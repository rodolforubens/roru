// The emoji picker, for the icons of notes and views: every emoji of the Unicode list (see
// vendor/emoji.js), by group, found by its name and the words it goes with, the ones used lately
// first; any typed or pasted in its box is taken too (on a phone, the emoji keyboard).
import { esc, store } from './util.js?v=e5ab480';
import { GROUPS } from './vendor/emoji.js?v=e5ab480';

const GROUP_ICONS = {
  'Smileys & Emotion': '😀', 'People & Body': '👋', 'Animals & Nature': '🐻', 'Food & Drink': '🍔', 'Travel & Places': '✈️',
  Activities: '⚽', Objects: '💡', Symbols: '🔣', Flags: '🏁',
};
const RECENT = 'Recently used';

let list = null; // [{ e, name, words, group }]
const all = () => (list ||= GROUPS.flatMap(([group, text]) => text.split('\n').map(line => {
  const [e, name, words = ''] = line.split('\t');
  return { e, name, words, group, hay: `${name} ${words}`.toLowerCase() };
})));
const named = new Map();
const nameOf = e => { if (!named.size) for (const x of all()) named.set(x.e, x.name); return named.get(e) || ''; };

const recent = () => (store('emojiRecent') || []).filter(Boolean).slice(0, 27);
const remember = e => store('emojiRecent', [e, ...recent().filter(x => x !== e)].slice(0, 27));

const graphemes = text => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(s => s.segment);
const isEmoji = g => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g);

// The emoji whose name or words have all the words searched (the ones whose name starts with them first).
function search(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = all().filter(x => words.every(w => x.hay.includes(w)));
  const first = words[0];
  return hits.sort((a, b) => (b.name.startsWith(first) - a.name.startsWith(first)) || (b.name.includes(first) - a.name.includes(first))).slice(0, 400);
}

const button = (e, current) => `<button class="ep-e ${e === current ? 'on' : ''}" data-e="${esc(e)}" title="${esc(nameOf(e))}">${esc(e)}</button>`;

// Opens under `r` (a rect); `done(emoji)` gets the one picked, or null for "Remove".
export function pickEmoji(r, current, done) {
  document.querySelector('.emoji-pop')?.remove();
  const el = document.createElement('div');
  el.className = 'emoji-pop';
  const used = recent();
  const groups = [...(used.length ? [[RECENT, '🕘']] : []), ...GROUPS.map(([g]) => [g, GROUP_ICONS[g] || '•'])];
  el.innerHTML = `<div class="ep-head"><input class="ep-q" placeholder="Search emoji, or type or paste one" spellcheck="false">
      ${current ? '<button class="btn-sm ep-remove">Remove</button>' : ''}</div>
    <div class="ep-tabs">${groups.map(([g, i], k) => `<button class="ep-tab ${k ? '' : 'on'}" data-g="${esc(g)}" title="${esc(g)}">${esc(i)}</button>`).join('')}</div>
    <div class="ep-list"></div>
    <div class="ep-foot"><span class="ep-big"></span><span class="ep-name">Pick an emoji</span></div>`;
  document.body.append(el);
  const listEl = el.querySelector('.ep-list'), q = el.querySelector('.ep-q');

  const sections = () => {
    const by = new Map(GROUPS.map(([g]) => [g, []]));
    for (const x of all()) by.get(x.group)?.push(x.e);
    return [...(used.length ? [[RECENT, used]] : []), ...by];
  };
  const paintAll = () => {
    listEl.innerHTML = sections().map(([g, es]) => `<div class="ep-sec" data-g="${esc(g)}"><div class="ep-gh">${esc(g)}</div>
      <div class="ep-grid">${es.map(e => button(e, current)).join('')}</div></div>`).join('');
  };
  const paintSearch = text => {
    const hits = search(text);
    listEl.innerHTML = hits.length
      ? `<div class="ep-sec"><div class="ep-gh">${hits.length === 400 ? 'The first 400' : hits.length} found</div><div class="ep-grid">${hits.map(x => button(x.e, current)).join('')}</div></div>`
      : '<div class="ep-none">No emoji found</div>';
  };
  paintAll();

  const w = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(r.left, innerWidth - w.width - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(r.bottom + 4, innerHeight - w.height - 8)) + 'px';

  const close = () => { el.remove(); removeEventListener('pointerdown', outside, true); };
  const pick = e => { close(); if (e) remember(e); done(e); };
  const outside = e => { if (!el.contains(e.target)) close(); };
  setTimeout(() => addEventListener('pointerdown', outside, true));

  el.addEventListener('click', e => {
    const b = e.target.closest('.ep-e');
    if (b) return pick(b.dataset.e);
    if (e.target.closest('.ep-remove')) return pick(null);
    const tab = e.target.closest('.ep-tab');
    if (tab) {
      if (q.value) { q.value = ''; paintAll(); }
      const sec = [...listEl.querySelectorAll('.ep-sec')].find(s => s.dataset.g === tab.dataset.g);
      if (sec) listEl.scrollTop = sec.offsetTop - listEl.offsetTop;
    }
  });
  // the name of the one under the pointer
  const foot = el.querySelector('.ep-foot');
  el.addEventListener('pointerover', e => {
    const b = e.target.closest('.ep-e');
    if (!b) return;
    foot.querySelector('.ep-big').textContent = b.dataset.e;
    foot.querySelector('.ep-name').textContent = b.title;
  });
  // the tab of the group being looked at
  listEl.addEventListener('scroll', () => {
    if (q.value) return;
    const top = listEl.scrollTop + listEl.offsetTop + 4;
    const sec = [...listEl.querySelectorAll('.ep-sec')].filter(s => s.offsetTop <= top).pop();
    for (const t of el.querySelectorAll('.ep-tab')) t.classList.toggle('on', t.dataset.g === sec?.dataset.g);
  });
  q.addEventListener('input', () => {
    const text = q.value.trim();
    // an emoji typed (or picked on a phone's emoji keyboard) is taken right away
    const g = graphemes(text).find(isEmoji);
    if (g) return pick(g);
    listEl.scrollTop = 0;
    if (text) paintSearch(text);
    else paintAll();
  });
  q.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter') {
      e.preventDefault();
      const first = listEl.querySelector('.ep-e');
      if (first && q.value.trim()) pick(first.dataset.e);
    }
  });
  if (matchMedia('(hover: hover)').matches) q.focus();
}
