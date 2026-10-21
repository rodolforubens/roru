// The app on a phone (a window as narrow as one), like Notion's app: one screen at a time, full
// width, instead of the rail, the tabs and the peeks. A screen is a space's pinned page (Home, or a
// project's dashboard) or a note, shown in the main area as a tab; the bar on top goes back (also
// the phone's back button, through the browser history) and has the screen's menu, and the bar at
// the bottom goes home, searches and makes a new page. Home lists the recent notes, the projects
// and Home's notes.
import * as S from './notes-store.js?v=7fcf47a';
import * as P from './projects.js?v=7fcf47a';
import { isMobile } from './platform.js?v=7fcf47a';
import { esc, icon, store } from './util.js?v=7fcf47a';

const $ = (sel, root = document) => root.querySelector(sel);

// Callbacks into the app (see initMobile).
let host = null;

const stack = [];    // the screens gone through ({ space, note }), the last one shown now
let restoring = false;
const same = (a, b) => !!a && !!b && a.space === b.space && (a.note || null) === (b.note || null);

// `h`: { screen() (the one shown: { space, note }), go(screen) (shows it; a promise), noteTitle(id),
// noteIcon(id), noteMenu(id), projectMenu(project), accountButton(), accountMenu(x, y),
// newPage(space), renderNotes(el, space), showMenu, toast }.
export function initMobile(h) {
  host = h;
  $('#mbar').addEventListener('click', e => {
    const b = e.target.closest('[data-mb]');
    if (!b) return;
    const r = b.getBoundingClientRect(), s = host.screen();
    if (b.dataset.mb === 'back') back();
    else if (b.dataset.mb === 'account') host.accountMenu(r.left, r.bottom + 4);
    else if (b.dataset.mb === 'more') host.showMenu(r.right - 220, r.bottom + 4, s.note ? host.noteMenu(s.note) : host.projectMenu(P.getProject(s.space)));
  });
  $('#mnav').addEventListener('click', e => {
    const b = e.target.closest('[data-mn]');
    if (!b) return;
    if (b.dataset.mn === 'home') go({ space: 'home', note: null });
    else if (b.dataset.mn === 'search') openSearch();
    else if (b.dataset.mn === 'new') host.newPage(host.screen().space);
  });
  $('#mnav').innerHTML = `<button class="mn-btn" data-mn="home" title="Home">${icon('home')}</button>
    <button class="mn-btn" data-mn="search" title="Search">${icon('search')}</button>
    <button class="mn-btn" data-mn="new" title="New page">${icon('plus')}</button>`;
  initTools();
  // the phone's back button (or gesture) goes back a screen
  addEventListener('popstate', () => {
    if (!isMobile() || stack.length < 2) return;
    stack.pop();
    restoring = true;
    Promise.resolve(host.go(stack[stack.length - 1])).finally(() => { restoring = false; paintBar(); });
  });
}

// A screen was shown: it goes on the stack (and in the browser history, so back works).
export function visited(screen) {
  if (!host) return;
  if (screen.note) remember(screen.note);
  if (restoring || same(stack[stack.length - 1], screen)) return paintBar();
  if (!stack.length || !isMobile()) {
    stack.length = 0;
    stack.push(screen);
    history.replaceState({ roru: 1 }, '');
  } else {
    stack.push(screen);
    history.pushState({ roru: stack.length }, '');
  }
  paintBar();
}

export function back() {
  if (stack.length > 1) history.back();
}

function go(screen) {
  if (same(stack[stack.length - 1], screen)) return;
  host.go(screen);
}

// ---------- the bars ----------

export function paintBar() {
  const bar = $('#mbar');
  if (!bar || !host || !isMobile()) return;
  const s = host.screen(), project = P.getProject(s.space);
  const title = s.note ? host.noteTitle(s.note) : project ? project.name : 'Roru Dashboard';
  const left = stack.length > 1 ? `<button class="mb-btn" data-mb="back" title="Back">${icon('back')}</button>`
    : `<span class="mb-account" data-mb="account">${host.accountButton()}</span>`;
  const more = s.note || project ? `<button class="mb-btn" data-mb="more" title="More">${icon('more')}</button>` : '';
  bar.innerHTML = `${left}<div class="mb-title">${s.note ? icon(host.noteIcon(s.note)) : ''}<span>${esc(title)}</span></div>${more}`;
}

// ---------- Home ----------

// The notes opened lately, most recent first.
function remember(id) {
  const list = (store('mobileRecents') || []).filter(x => x !== id);
  store('mobileRecents', [id, ...list].slice(0, 12));
}

// Home on a phone: the recent notes as cards, the projects, and Home's notes (their tree).
export function renderHome(el) {
  const recents = (store('mobileRecents') || []).filter(id => S.getNote(id) && (S.getNote(id).space === 'home' || P.getProject(S.getNote(id).space))).slice(0, 10);
  const projects = P.listProjects();
  el.innerHTML = `<div class="mh">
    ${recents.length ? `<section class="mh-sec"><h4>Recents</h4><div class="mh-recents">${recents.map(id => `<button class="mh-card" data-note="${esc(id)}">
      <span class="mh-card-top"></span>${icon(host.noteIcon(id))}<span class="mh-card-title">${esc(host.noteTitle(id))}</span></button>`).join('')}</div></section>` : ''}
    <section class="mh-sec"><h4>Projects</h4>
      ${projects.map(p => `<button class="mh-row" data-project="${esc(p.id)}"><span class="proj-badge" style="--pc: ${p.color}">${esc(P.initials(p.name))}</span><span class="mh-row-name">${esc(p.name)}</span>${icon('chevron')}</button>`).join('')}
      <button class="mh-row mh-add" data-new-project>${icon('plus')}<span class="mh-row-name">New project</span></button>
    </section>
    <section class="mh-sec mh-notes"></section>
  </div>`;
  host.renderNotes($('.mh-notes', el), 'home');
  el.onclick = e => {
    const card = e.target.closest('.mh-card');
    if (card) { const n = S.getNote(card.dataset.note); return n && go({ space: n.space, note: n.id }); }
    const row = e.target.closest('.mh-row[data-project]');
    if (row) return go({ space: row.dataset.project, note: null });
    if (e.target.closest('[data-new-project]')) host.newProject();
  };
  el.oncontextmenu = e => {
    const row = e.target.closest('.mh-row[data-project]');
    if (!row) return;
    e.preventDefault();
    host.showMenu(e.clientX, e.clientY, host.projectMenu(P.getProject(row.dataset.project)));
  };
}

// ---------- search ----------

// Finds notes (by title, in every space) and projects, to go to them.
function openSearch() {
  const root = document.createElement('div');
  root.className = 'msearch';
  root.innerHTML = `<div class="msr-bar">${icon('search')}<input type="search" placeholder="Search pages and projects" spellcheck="false"><button class="mb-btn" data-close title="Close">${icon('close')}</button></div><div class="msr-list"></div>`;
  document.body.append(root);
  const input = $('input', root), list = $('.msr-list', root);
  const spaces = ['home', ...P.listProjects().map(p => p.id)];
  const spaceName = s => P.getProject(s)?.name || 'Home';
  const paint = () => {
    const q = input.value.trim().toLowerCase();
    const notes = spaces.flatMap(s => S.notesOf(s)).filter(n => !q || (n.title || 'untitled').toLowerCase().includes(q))
      .sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 40);
    const projects = P.listProjects().filter(p => q && p.name.toLowerCase().includes(q));
    list.innerHTML = projects.map(p => `<button class="msr-item" data-project="${esc(p.id)}"><span class="proj-badge" style="--pc: ${p.color}">${esc(P.initials(p.name))}</span><span class="msr-text"><b>${esc(p.name)}</b><span>Project</span></span></button>`).join('')
      + notes.map(n => `<button class="msr-item" data-note="${esc(n.id)}">${icon(host.noteIcon(n.id))}<span class="msr-text"><b>${esc(n.title || 'Untitled')}</b><span>${esc(spaceName(n.space))}</span></span></button>`).join('')
      + (projects.length || notes.length ? '' : '<div class="msr-empty">Nothing found</div>');
  };
  const close = () => root.remove();
  root.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) return close();
    const it = e.target.closest('.msr-item');
    if (!it) return;
    close();
    if (it.dataset.project) go({ space: it.dataset.project, note: null });
    else { const n = S.getNote(it.dataset.note); if (n) go({ space: n.space, note: n.id }); }
  });
  input.addEventListener('input', paint);
  input.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  paint();
  input.focus();
}

// ---------- the toolbar while typing ----------
//
// A phone has no shortcuts for styles or Tab: while a note's text has the focus, the bar at the
// bottom becomes a toolbar (bold, italic, strike, code, lists, indent and outdent, done). Its buttons
// don't take the focus, so the keyboard stays.

// [id, label (an icon or text), title, run(editor), active(editor)]
const lists = ['listItem', 'taskItem'];
const TOOLS = [
  ['bold', '<b>B</b>', 'Bold', e => e.chain().toggleBold().run(), e => e.isActive('bold')],
  ['italic', '<i>I</i>', 'Italic', e => e.chain().toggleItalic().run(), e => e.isActive('italic')],
  ['strike', '<s>S</s>', 'Strikethrough', e => e.chain().toggleStrike().run(), e => e.isActive('strike')],
  ['code', icon('code'), 'Code', e => e.chain().toggleCode().run(), e => e.isActive('code')],
  ['bullets', icon('list'), 'Bulleted list', e => e.chain().toggleBulletList().run(), e => e.isActive('bulletList')],
  ['todo', icon('todo'), 'To-do list', e => e.chain().toggleTaskList().run(), e => e.isActive('taskList')],
  ['outdent', icon('outdent'), 'Outdent', e => lists.some(t => e.commands.liftListItem(t)), () => false],
  ['indent', icon('indent'), 'Indent', e => lists.some(t => e.commands.sinkListItem(t)), () => false],
  ['done', icon('check'), 'Done', e => e.commands.blur(), () => false],
];

let typing = null; // the editor being typed in

function initTools() {
  const bar = $('#mtools');
  bar.innerHTML = TOOLS.map(([id, label, title]) => `<button class="mt-btn" data-t="${id}" title="${title}">${label}</button>`).join('');
  const press = e => {
    const b = e.target.closest('[data-t]');
    if (!b || !typing) return;
    e.preventDefault(); // the text keeps the focus (and the keyboard stays)
    TOOLS.find(t => t[0] === b.dataset.t)[3](typing);
    paintTools();
  };
  bar.addEventListener('pointerdown', press);
  bar.addEventListener('mousedown', e => e.preventDefault());
  // typing is when a note's text has the focus (its selection changes as the caret moves)
  const sync = () => {
    typing = document.activeElement?.closest?.('.ProseMirror')?.editor || null;
    document.documentElement.classList.toggle('typing', !!typing);
    paintTools();
  };
  document.addEventListener('focusin', sync);
  document.addEventListener('focusout', () => setTimeout(sync));
  document.addEventListener('selectionchange', sync);
}

function paintTools() {
  if (!typing || !isMobile()) return;
  for (const [id, , , , active] of TOOLS) $(`#mtools [data-t="${id}"]`)?.classList.toggle('on', !!active(typing));
}
