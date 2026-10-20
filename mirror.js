// A live copy of some tables of the user's account (Supabase), for a part of the app that keeps its
// own objects (the projects, the notes) and only says what they are as rows.
//
// `rows` has the rows as they are known here: the account's, plus the changes made here. A change
// made here is found by comparing what the objects are now with `rows` (so the owner just calls
// write() after changing them), and is written right away; until it is, it waits in `outbox`, kept
// on this device with the rows, so the changes made offline are written when the network comes
// back. Changes made elsewhere come in live (Realtime) and the owner builds its objects again from
// the rows; a change made here and not written yet wins over them. Everything is read again
// whenever the live channel (re)connects, which brings in what was missed while offline.
import { db } from './account.js?v=8088795';
import { store } from './util.js?v=8088795';

// ---------- how saving is going, for everything kept in the account ----------

const sources = new Map(); // what is being kept (a mirror, the notes' text) -> its state
const statusListeners = new Set();

// null (signed out), 'syncing', 'synced' or 'offline'.
export function syncStatus() {
  const s = [...sources.values()].filter(Boolean);
  return !s.length ? null : s.includes('offline') ? 'offline' : s.includes('syncing') ? 'syncing' : 'synced';
}

export const onSyncStatus = fn => statusListeners.add(fn);

export function reportStatus(source, state) {
  if (sources.get(source) === state) return;
  const before = syncStatus();
  sources.set(source, state);
  if (syncStatus() !== before) statusListeners.forEach(fn => fn(syncStatus()));
}

// JSON with the keys of every object sorted, to compare rows (the database reorders their keys).
export const canon = v => JSON.stringify(v ?? null, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));
export const clone = v => JSON.parse(JSON.stringify(v ?? {}));

const check = r => { if (r.error) throw r.error; };

// `opts`: {
//   name: what it is (kept on this device as `${name}.${user id}`), label: what it is, in messages,
//   tables: { table: 'the columns to read' }, in the order they are written (parents first),
//   rowsOf(): { table: Map(id -> row) }, the owner's objects as rows now ({ id, data, ... }),
//   build(rows): the owner builds its objects from the rows,
//   changed({ removed: { table: [ids] } }): after the rows changed elsewhere or were read again
//     (and when the mirror starts or stops); `removed` has the rows deleted in the account.
// }
export function createMirror(opts) {
  const TABLES = Object.keys(opts.tables);
  const empty = () => Object.fromEntries(TABLES.map(t => [t, new Map()]));
  let account = null;
  let rows = empty();
  let outbox = new Map();      // "table:id" -> { table, id, row } (row null: deleted)
  let channel = null;
  let flushing = null, retry = null, delay = 0;
  const echoes = new Map();    // "table:id" -> rows written from here lately (their echo is ignored)
  const status = s => reportStatus(opts.name, s);

  let told = null; // what was deleted elsewhere, told at once when a burst of changes is over
  function tell(removed = {}) {
    if (!told) {
      told = {};
      setTimeout(() => {
        const r = told;
        told = null;
        opts.changed({ removed: r });
      }, 30);
    }
    for (const [t, ids] of Object.entries(removed)) (told[t] ||= []).push(...ids);
  }

  // A row as the database gives it (a select, or a live change) to the shape of the owner's rows.
  const fromDb = r => {
    const { user_id, updated_at, created_at, ...row } = r;
    row.data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data || {};
    return row;
  };

  function keep() {
    if (!account) return;
    store(`${opts.name}.${account.id}`, {
      rows: Object.fromEntries(TABLES.map(t => [t, [...rows[t].values()]])),
      outbox: [...outbox.values()],
    });
  }

  // A change made here: what differs from the rows goes to the outbox, and is written.
  function write() {
    if (!account) return;
    const next = opts.rowsOf();
    for (const t of TABLES) {
      for (const [id, row] of next[t]) if (canon(row) !== canon(rows[t].get(id))) outbox.set(`${t}:${id}`, { table: t, id, row });
      for (const id of rows[t].keys()) if (!next[t].has(id)) outbox.set(`${t}:${id}`, { table: t, id, row: null });
    }
    rows = next;
    keep();
    flush();
  }

  function echo(key, row) {
    if (!echoes.has(key)) echoes.set(key, new Set());
    const c = canon(row);
    echoes.get(key).add(c);
    setTimeout(() => { echoes.get(key)?.delete(c); if (!echoes.get(key)?.size) echoes.delete(key); }, 15000);
  }

  // Writes the outbox: one request per table for the rows written, one for the ones deleted.
  function flush() {
    if (flushing || !account || !outbox.size) return flushing;
    const user = account;
    flushing = (async () => {
      const batch = [...outbox.entries()];
      const of = (t, written) => batch.map(([, o]) => o).filter(o => o.table === t && !!o.row === written);
      status('syncing');
      try {
        for (const t of TABLES) {
          const up = of(t, true).map(o => o.row);
          if (up.length) check(await db.from(t).upsert(up));
        }
        for (const t of [...TABLES].reverse()) {
          const ids = of(t, false).map(o => o.id);
          if (ids.length) check(await db.from(t).delete().in('id', ids));
        }
      } catch (e) {
        // offline, or the account refused it: tried again a little later, or when the network is back
        console.warn(`Could not write the ${opts.label || opts.name} to the account`, e);
        if (account !== user) return;
        delay = Math.min(60000, delay ? delay * 2 : 2000);
        clearTimeout(retry);
        retry = setTimeout(flush, delay);
        status('offline');
        return;
      } finally {
        flushing = null;
      }
      if (account !== user) return;
      for (const [key, o] of batch) {
        if (o.row) echo(key, o.row);
        if (outbox.get(key) === o) outbox.delete(key);
      }
      delay = 0;
      keep();
      if (outbox.size) flush();
      else status('synced');
    })();
    return flushing;
  }

  // A change that came from elsewhere (or the echo of one made here).
  function remote(table, { eventType, new: row, old }) {
    const id = (eventType === 'DELETE' ? old : row)?.id;
    if (!account || !id) return;
    const key = `${table}:${id}`;
    if (outbox.has(key)) return; // changed here too: this device's change is on its way, and wins
    if (eventType === 'DELETE') {
      if (!rows[table].delete(id)) return;
    } else {
      const r = fromDb(row), c = canon(r);
      if (c === canon(rows[table].get(id)) || echoes.get(key)?.has(c)) return;
      rows[table].set(id, r);
    }
    opts.build(rows);
    keep();
    tell(eventType === 'DELETE' ? { [table]: [id] } : {});
  }

  // Reads every row of the account again; the changes not written yet stay on top of them.
  async function resync() {
    const user = account;
    if (!user) return;
    status('syncing');
    const read = await Promise.all(TABLES.map(t => db.from(t).select(opts.tables[t]))).catch(e => [{ error: e }]);
    if (account !== user) return;
    const failed = read.find(r => r.error);
    if (failed) {
      console.warn(`Could not read the ${opts.label || opts.name} of the account`, failed.error);
      return status('offline');
    }
    const next = empty();
    TABLES.forEach((t, i) => read[i].data.forEach(r => next[t].set(r.id, fromDb(r))));
    for (const o of outbox.values()) {
      if (o.row) next[o.table].set(o.id, o.row);
      else next[o.table].delete(o.id);
    }
    const removed = Object.fromEntries(TABLES.map(t => [t, [...rows[t].keys()].filter(id => !next[t].has(id))]));
    const same = TABLES.every(t => rows[t].size === next[t].size && [...next[t]].every(([id, r]) => canon(r) === canon(rows[t].get(id))));
    rows = next;
    if (!same) opts.build(rows);
    keep();
    if (!same) tell(removed);
    if (outbox.size) flush();
    else status('synced');
  }

  // Starts copying the account of `user`, or stops (null). The owner's objects are built right away
  // from what this device kept last time, then from the account.
  function use(user) {
    if (channel) { db.removeChannel(channel); channel = null; }
    clearTimeout(retry);
    account = user && db ? user : null;
    outbox = new Map();
    rows = empty();
    echoes.clear();
    delay = 0;
    if (!account) {
      status(null);
      tell();
      return;
    }
    const cache = store(`${opts.name}.${account.id}`) || {};
    for (const t of TABLES) (cache.rows?.[t] || []).forEach(r => rows[t].set(r.id, r));
    (cache.outbox || []).forEach(o => outbox.set(`${o.table}:${o.id}`, o));
    opts.build(rows);
    tell();
    status('syncing');
    let ch = db.channel(`${opts.name}:${account.id}`);
    for (const t of TABLES) ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, p => remote(t, p));
    channel = ch.subscribe(s => {
      // (re)connected: what changed meanwhile is read, and what changed here is written
      if (s === 'SUBSCRIBED') resync();
      else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') status('offline');
    });
  }

  addEventListener('online', () => { if (account) { delay = 0; flush(); resync(); } });

  return { use, write, get active() { return !!account; }, get user() { return account; } };
}
