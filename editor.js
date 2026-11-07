// The rich text editor of the notes (TipTap, bundled in vendor/tiptap.js): text, headings, lists,
// to-do lists, quotes, code blocks, links, images, tables, database blocks and cards of links (a
// YouTube video, a post on X), with Markdown-like shortcuts ("# ", "- ", "[] "...), a "/" menu to
// change or insert blocks, and "@" mentions of notes, files, commits and branches.
import { Editor, Extension, Node, StarterKit, TaskList, TaskItem, Placeholder, Mention, Image, TableKit, Markdown, Suggestion, PluginKey, Collaboration, getSchema } from './vendor/tiptap.js?v=62e3e82';
import { esc, icon } from './util.js?v=62e3e82';

// The blocks and marks of a note's content. With a Yjs document (`opts.ydoc`) the undo history is
// the collaboration's own.
const contentExtensions = (opts = {}) => [
  StarterKit.configure({
    link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https' },
    ...(opts.ydoc ? { undoRedo: false } : {}),
  }),
  TaskList,
  TaskItem.configure({ nested: true }),
  ImageNode(opts),
  TableKit.configure({ table: { resizable: false } }),
  DatabaseNode(opts),
  EmbedNode(opts),
];

// A database shown in the text: the block keeps the database's id, and `renderDatabase(el, id,
// { remove })` draws it (its views and items). What happens inside it is its own: the editor
// leaves its clicks, keys and changes alone.
function DatabaseNode(opts) {
  return Node.create({
    name: 'database',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: false,
    addAttributes() {
      return { id: { default: null, parseHTML: e => e.getAttribute('data-database'), renderHTML: a => ({ 'data-database': a.id }) } };
    },
    parseHTML() {
      return [{ tag: 'div[data-database]' }];
    },
    renderHTML({ HTMLAttributes }) {
      return ['div', HTMLAttributes];
    },
    addNodeView() {
      return ({ node, editor, getPos }) => {
        const dom = document.createElement('div');
        dom.className = 'db-block';
        dom.contentEditable = 'false';
        dom.dataset.id = node.attrs.id;
        const remove = () => {
          const pos = getPos();
          if (typeof pos === 'number') editor.chain().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
        };
        opts.renderDatabase?.(dom, node.attrs.id, { remove });
        return { dom, stopEvent: () => true, ignoreMutation: () => true };
      };
    },
  });
}

// ---------- cards of links: a YouTube video, a post on X ----------

// Seconds from a YouTube time ("90", "90s", "1m30s", "1h2m").
const seconds = t => {
  if (!t) return 0;
  if (/^\d+$/.test(t)) return +t;
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
};

// What a link shows as a card, or null when it has none: { kind ('youtube' or 'tweet'), label (the
// site), src (the address of its frame), short (a YouTube Short, upright), thumb (a picture of it) }.
export function embedOf(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|music)\./, '');
  if (['youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host)) {
    let id = host === 'youtu.be' ? u.pathname.split('/')[1] : u.searchParams.get('v');
    const path = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{11})(?:[/?#]|$)/);
    if (path) id = path[2];
    if (!/^[\w-]{11}$/.test(id || '')) return null;
    const start = seconds(u.searchParams.get('t') || u.searchParams.get('start'));
    return {
      kind: 'youtube', label: 'YouTube', short: path?.[1] === 'shorts',
      src: `https://www.youtube-nocookie.com/embed/${id}?rel=0${start ? `&start=${start}` : ''}`,
      thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  }
  if (host === 'x.com' || host === 'twitter.com') {
    const m = u.pathname.match(/^\/(?:\w+|i\/web|i)\/status(?:es)?\/(\d+)/);
    if (!m) return null;
    const theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    return { kind: 'tweet', label: 'X', src: `https://platform.twitter.com/embed/Tweet.html?id=${m[1]}&dnt=true&theme=${theme}` };
  }
  return null;
}

// A post on X sizes its frame through messages it sends to the page.
if (typeof window !== 'undefined') {
  window.addEventListener('message', e => {
    if (e.origin !== 'https://platform.twitter.com') return;
    let data = e.data;
    try { if (typeof data === 'string') data = JSON.parse(data); } catch { return; }
    const msg = data?.['twttr.embed'];
    const height = msg?.method === 'twttr.private.resize' && Math.ceil(msg.params?.[0]?.height || 0);
    if (!height) return;
    for (const f of document.querySelectorAll('iframe.eb-tweet')) {
      if (f.contentWindow === e.source) f.style.height = `${height}px`;
    }
  });
}

// A link shown as a card: the block keeps its `url` and draws what `embedOf` gives for it, with the
// link under it (opened with `openLink`) and buttons to show it as a link again or remove it.
function EmbedNode(opts) {
  return Node.create({
    name: 'embed',
    group: 'block',
    atom: true,
    selectable: true,
    draggable: false,
    addAttributes() {
      return { url: { default: null, parseHTML: e => e.getAttribute('data-embed'), renderHTML: a => ({ 'data-embed': a.url }) } };
    },
    parseHTML() {
      return [{ tag: 'div[data-embed]' }];
    },
    renderHTML({ HTMLAttributes }) {
      return ['div', HTMLAttributes];
    },
    renderText: ({ node }) => node.attrs.url || '',
    addNodeView() {
      return ({ node, editor, getPos }) => {
        const url = node.attrs.url || '';
        const e = embedOf(url);
        const dom = document.createElement('div');
        dom.className = `embed-block${e ? ` eb-${e.kind}` : ''}${e?.short ? ' eb-short' : ''}`;
        dom.contentEditable = 'false';
        const shown = url.replace(/^https?:\/\/(www\.)?/i, '');
        dom.innerHTML = `${e ? `<iframe class="eb-frame eb-${e.kind}" loading="lazy" allowfullscreen
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture; web-share"
            referrerpolicy="strict-origin-when-cross-origin"></iframe>` : ''}
          <div class="eb-foot">
            <a class="eb-src" href="${esc(url)}" title="${esc(url)}">${icon(e?.kind === 'tweet' ? 'xLogo' : e ? 'youtube' : 'link')}<span>${esc(shown)}</span></a>
            <button class="eb-btn" data-eb="link" title="Show as a link">${icon('link')}</button>
            <button class="eb-btn" data-eb="remove" title="Remove">${icon('trash')}</button>
          </div>`;
        if (e) {
          const frame = dom.querySelector('iframe');
          frame.title = `${e.label}: ${shown}`;
          if (e.kind === 'tweet') frame.setAttribute('scrolling', 'no'); // it says how tall it is
          frame.src = e.src;
        }
        // its place in the text, from where it is now
        const range = () => {
          const pos = getPos();
          return typeof pos === 'number' ? { from: pos, to: pos + node.nodeSize } : null;
        };
        dom.addEventListener('mousedown', ev => {
          if (ev.target.closest('.eb-src, [data-eb]')) ev.preventDefault(); // don't move the focus
        });
        dom.addEventListener('click', ev => {
          const act = ev.target.closest('.eb-src, [data-eb]');
          if (!act) return;
          ev.preventDefault();
          const r = range();
          if (act.classList.contains('eb-src')) opts.openLink?.(url);
          else if (r && act.dataset.eb === 'remove') editor.chain().focus().deleteRange(r).run();
          else if (r) editor.chain().focus().insertContentAt(r, linkParagraph(url)).run();
        });
        return {
          dom,
          // the frame keeps playing while the text around it changes
          update: n => n.type === node.type && n.attrs.url === url,
          stopEvent: ev => !!ev.target.closest?.('.eb-src, .eb-btn'),
          ignoreMutation: () => true,
        };
      };
    },
  });
}

const linkParagraph = url => ({ type: 'paragraph', content: [{ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }] });

// Turns the link at from..to into a card: in place of its paragraph when the link is all it has,
// else right after it. The caret goes on in the line after the card (so typing doesn't replace it).
function showAsCard(editor, from, to, url) {
  const { state } = editor;
  const type = state.schema.nodes.embed;
  const $from = state.doc.resolve(from);
  const block = $from.parent, card = type.create({ url });
  const parent = $from.node(-1), at = $from.index(-1);
  let onlyText = true;
  block.forEach(c => { if (!c.isText) onlyText = false; });
  const whole = onlyText && block.textContent.trim() === url && parent.canReplaceWith(at, at + 1, type);
  const pos = whole ? $from.before() : $from.after() - (to - from); // where the card ends up
  const end = pos + card.nodeSize;
  let placed = false;
  editor.chain()
    .command(({ tr }) => {
      if (whole) tr.replaceWith($from.before(), $from.after(), card);
      else tr.insert($from.after(), card).delete(from, to);
      placed = tr.doc.nodeAt(pos)?.type === type;
      if (placed && !tr.doc.nodeAt(end)?.isTextblock) tr.insert(end, state.schema.nodes.paragraph.create());
      return true;
    })
    .command(({ commands }) => !placed || commands.setTextSelection(end + 1))
    .scrollIntoView()
    .focus()
    .run();
}

// The link a paste is made of (plain text that is only an address), when it can show as a card.
function pastedEmbed(event) {
  const text = event.clipboardData?.getData('text/plain')?.trim() || '';
  return text && !/\s/.test(text) && embedOf(text) ? text : null;
}

// Images keep where they are as `src`: a web address, or a file of the notes ("files/<note>/<name>")
// that `fileUrl(src)` turns into an address the webview can load (or a promise of one).
function ImageNode(opts) {
  if (!opts.fileUrl) return Image.configure({ inline: true });
  return Image.configure({ inline: true }).extend({
    addNodeView() {
      return ({ node }) => {
        const img = document.createElement('img');
        const url = opts.fileUrl(node.attrs.src);
        if (url?.then) url.then(u => { if (u) img.src = u; });
        else img.src = url;
        img.alt = node.attrs.alt || '';
        if (node.attrs.title) img.title = node.attrs.title;
        img.draggable = false;
        return { dom: img };
      };
    },
  });
}

// Markdown to a note's content (JSON), with the same blocks notes have (used by imports).
let parser = null;
export function parseMarkdown(md) {
  parser ||= new Editor({ extensions: [...contentExtensions(), Markdown] });
  return parser.markdown.parse(md);
}

// The schema of a note's content: every block and mark it can have, mentions included (to turn
// its JSON into a document).
let schema = null;
export const noteSchema = () => (schema ||= getSchema([...contentExtensions(), MentionNode({ mentionView: () => ({}) })]));

// The content (JSON) made to fit the schema: what is inline (text, pictures, mentions) but loose among
// blocks goes in a paragraph. Imports can leave pictures like that, and the collaboration editor
// would show none of the text then (and drop them at the next change).
export function fitToSchema(json) {
  const s = noteSchema();
  const fit = node => {
    if (!node.content) return node;
    const type = s.nodes[node.type];
    let content = node.content.map(fit);
    if (type && !type.inlineContent && !type.isLeaf) {
      const out = [];
      let run = null;
      for (const c of content) {
        if (s.nodes[c.type]?.isInline) {
          if (!run) out.push(run = { type: 'paragraph', content: [] });
          run.content.push(c);
        } else {
          run = null;
          out.push(c);
        }
      }
      content = out;
    }
    return { ...node, content };
  };
  return fit(json);
}

// ---------- images: pasted, dropped or picked ----------

const imageFiles = list => [...(list || [])].filter(f => f.type.startsWith('image/'));

// Lets the user pick pictures (on a phone: the gallery or the camera).
export function pickImages(done) {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', multiple: true });
  input.onchange = () => input.files.length && done([...input.files]);
  input.click();
}

// Uploads the pictures (`opts.uploadImage(file)` gives each one's `src`) and puts them at `at` (where
// they were dropped) or at the selection.
export async function addImages(editor, opts, files, at = null) {
  const nodes = [];
  for (const f of files) {
    try {
      nodes.push({ type: 'image', attrs: { src: await opts.uploadImage(f), alt: f.name.replace(/\.[^.]+$/, '') } });
    } catch (e) {
      opts.onError?.(e);
    }
  }
  if (!nodes.length || editor.isDestroyed) return;
  const chain = editor.chain().focus();
  (at == null ? chain : chain.setTextSelection(Math.min(at, editor.state.doc.content.size))).insertContent(nodes).run();
}

// `opts`: { content, onChange(doc) | ydoc (a Yjs document the editor edits and that saves itself),
// mentions(query) -> Promise<items>, mentionView(attrs) -> { icon, label, title, gone (deleted) },
// openMention(attrs, event), openLink(href), fileUrl(src), renderDatabase(el, id, { remove }),
// uploadImage(file) -> Promise<src> (pictures pasted, dropped or added with "/image"), onError(error),
// commands: extra "/" items [{ title, hint, icon, run(editor, range) }] }.
// Mention items are { kind, id, repo, label, detail }.
export function createEditor(el, opts) {
  let editor = null;
  const offer = cardOffer(() => editor);
  return (editor = new Editor({
    element: el,
    ...(opts.ydoc ? {} : { content: opts.content || '' }),
    extensions: [
      ...contentExtensions(opts),
      ...(opts.ydoc ? [Collaboration.configure({ document: opts.ydoc, field: 'default' })] : []),
      Placeholder.configure({
        placeholder: ({ node }) => (node.type.name === 'heading' ? `Heading ${node.attrs.level}` : "Type '/' for commands, '@' to mention"),
      }),
      MentionNode(opts),
      SlashCommands(opts),
    ],
    editorProps: {
      attributes: { class: 'note-prose', spellcheck: 'true' },
      // Links open with Ctrl+click (a plain click edits them).
      handleClick: (view, pos, event) => {
        const a = event.target.closest?.('a[href]');
        if (!a || !(event.ctrlKey || event.metaKey)) return false;
        opts.openLink?.(a.getAttribute('href'));
        return true;
      },
      // Pictures pasted or dropped in are uploaded and put in the text. A link that can show as a
      // card (YouTube, X) goes in as a link, with a menu under it that offers the card.
      handlePaste: (view, event) => {
        const files = opts.uploadImage ? imageFiles(event.clipboardData?.files) : [];
        if (files.length) {
          event.preventDefault();
          addImages(editor, opts, files);
          return true;
        }
        const url = pastedEmbed(event);
        const { state } = view, { empty, $from } = state.selection;
        if (!url || !empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return false;
        event.preventDefault();
        const link = state.schema.marks.link;
        const tr = state.tr.replaceSelectionWith(state.schema.text(url, link ? [link.create({ href: url })] : []), false);
        view.dispatch(tr.setStoredMarks([]).setMeta('paste', true).setMeta('uiEvent', 'paste').scrollIntoView());
        const to = view.state.selection.from;
        offer.open(url, to - url.length, to);
        return true;
      },
      handleKeyDown: (view, event) => offer.keyDown(event),
      handleDrop: (view, event, slice, moved) => {
        const files = !moved && opts.uploadImage ? imageFiles(event.dataTransfer?.files) : [];
        if (!files.length) return false;
        event.preventDefault();
        addImages(editor, opts, files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null);
        return true;
      },
    },
    onUpdate: ({ editor }) => opts.onChange?.(editor.getJSON()),
    onTransaction: ({ editor, transaction }) => offer.follow(transaction, editor.state),
    onBlur: () => offer.close(),
    onDestroy: () => offer.close(),
  }));
}

// ---------- the offer to show a pasted link as a card ----------

// A menu under a link just pasted: "Dismiss" first (like Notion, so Enter right after pasting keeps
// the link) and "Show as a card". Typing, moving the caret or leaving the text closes it.
function cardOffer(getEditor) {
  let o = null; // { url, from, to, el, index }

  const close = () => {
    o?.el.remove();
    o = null;
  };
  const paint = () => {
    const e = embedOf(o.url);
    const items = [{ label: 'Dismiss', icon: 'close' }, { label: 'Show as a card', icon: e.kind === 'tweet' ? 'xLogo' : 'youtube', hint: e.label }];
    o.el.innerHTML = items.map((it, i) => `<div class="sg-item ${i === o.index ? 'on' : ''}" data-i="${i}">${icon(it.icon)}<span class="sg-label">${esc(it.label)}</span>${it.hint ? `<span class="sg-detail">${esc(it.hint)}</span>` : ''}</div>`).join('');
  };
  const pick = i => {
    const { url, from, to } = o;
    close();
    if (i === 1) showAsCard(getEditor(), from, to, url);
  };

  return {
    open(url, from, to) {
      close();
      const el = document.createElement('div');
      el.className = 'sg-menu paste-menu';
      o = { url, from, to, el, index: 0 };
      paint();
      el.addEventListener('mousedown', e => {
        e.preventDefault(); // keep the focus in the editor
        const it = e.target.closest('.sg-item');
        if (it) pick(+it.dataset.i);
      });
      document.body.append(el);
      // under the end of the link (above it when there's no room), inside the window
      const r = getEditor().view.coordsAtPos(to);
      const h = el.offsetHeight, w = el.offsetWidth;
      const below = r.bottom + 6 + h < innerHeight || r.top - 6 - h < 0;
      el.style.left = Math.max(6, Math.min(r.left, innerWidth - w - 6)) + 'px';
      el.style.top = (below ? r.bottom + 6 : r.top - 6 - h) + 'px';
    },
    close,
    keyDown(event) {
      if (!o) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        o.index = 1 - o.index;
        paint();
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        pick(o.index);
        return true;
      }
      if (event.key === 'Escape') {
        close();
        return true;
      }
      if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) close();
      return false;
    },
    // Keeps up with the link through changes made around it (here or elsewhere).
    follow(tr, state) {
      if (!o) return;
      if (tr.docChanged) {
        o.from = tr.mapping.map(o.from, 1);
        o.to = tr.mapping.map(o.to, -1);
        if (o.to - o.from !== o.url.length || state.doc.textBetween(o.from, o.to) !== o.url) return close();
      }
      if (!state.selection.empty || state.selection.head !== o.to) close();
    },
  };
}

// ---------- mentions ----------

// A mention keeps what it points to: `kind` ('note', 'file', 'commit', 'branch'), `id` (note id,
// file path, commit SHA or branch name), `repo` (the folder, except for notes) and the `label` it had
// when it was inserted. Notes show their current title (see mentionView).
function MentionNode(opts) {
  return Mention.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        kind: { default: 'note', parseHTML: e => e.getAttribute('data-kind'), renderHTML: a => ({ 'data-kind': a.kind }) },
        repo: { default: null, parseHTML: e => e.getAttribute('data-repo'), renderHTML: a => (a.repo ? { 'data-repo': a.repo } : {}) },
      };
    },
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement('span');
        const v = opts.mentionView(node.attrs);
        dom.className = `mention m-${node.attrs.kind}${v.gone ? ' m-gone' : ''}`;
        dom.contentEditable = 'false';
        dom.dataset.kind = node.attrs.kind;
        dom.dataset.id = node.attrs.id;
        dom.title = v.title || '';
        dom.innerHTML = `${icon(v.icon)}<span class="m-label">${esc(v.label)}</span>`;
        dom.addEventListener('mousedown', e => e.preventDefault()); // don't move the caret
        dom.addEventListener('click', e => opts.openMention(node.attrs, e));
        return { dom };
      };
    },
  }).configure({
    renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
    suggestion: {
      char: '@',
      pluginKey: new PluginKey('mention'),
      items: ({ query }) => opts.mentions(query),
      render: menu(item => `${icon(item.icon)}<span class="sg-label">${esc(item.label)}</span>${item.detail ? `<span class="sg-detail">${esc(item.detail)}</span>` : ''}`,
        { group: item => item.group, empty: 'Nothing found' }),
      command: ({ editor, range, props }) => {
        editor.chain().focus().insertContentAt(range, [
          { type: 'mention', attrs: { id: props.id, label: props.label, kind: props.kind, repo: props.repo ?? null } },
          { type: 'text', text: ' ' },
        ]).run();
      },
    },
  });
}

// ---------- "/" commands ----------

const BLOCKS = [
  { title: 'Text', hint: 'Plain paragraph', icon: 'text', keys: 'paragraph p', run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
  { title: 'Heading 1', hint: 'Big section heading', icon: 'h1', keys: 'h1 title', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
  { title: 'Heading 2', hint: 'Medium section heading', icon: 'h2', keys: 'h2 subtitle', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
  { title: 'Heading 3', hint: 'Small section heading', icon: 'h3', keys: 'h3', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
  { title: 'Bulleted list', hint: 'A simple list', icon: 'list', keys: 'ul bullet unordered', run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { title: 'Numbered list', hint: 'A list with numbers', icon: 'olist', keys: 'ol ordered number', run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { title: 'To-do list', hint: 'Track tasks with checkboxes', icon: 'todo', keys: 'todo task check', run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
  { title: 'Quote', hint: 'Capture a quote', icon: 'quote', keys: 'blockquote', run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { title: 'Code', hint: 'A block of code', icon: 'code', keys: 'codeblock pre', run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
  { title: 'Divider', hint: 'A line between blocks', icon: 'minus', keys: 'hr rule separator', run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
  { title: 'Table', hint: 'A simple table', icon: 'table', keys: 'grid', run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
];

function SlashCommands(opts) {
  const image = {
    title: 'Image', hint: 'Upload a picture or a photo', icon: 'image', keys: 'img picture photo upload',
    run: (e, r) => { e.chain().focus().deleteRange(r).run(); pickImages(files => addImages(e, opts, files)); },
  };
  const all = [...BLOCKS, ...(opts.uploadImage ? [image] : []), ...(opts.commands || [])];
  return Extension.create({
    name: 'slashCommands',
    addProseMirrorPlugins() {
      return [Suggestion({
        editor: this.editor,
        char: '/',
        pluginKey: new PluginKey('slash'),
        items: ({ query }) => {
          const q = query.toLowerCase();
          return all.filter(c => !q || c.title.toLowerCase().includes(q) || c.keys?.split(' ').some(k => k.startsWith(q)));
        },
        command: ({ editor, range, props }) => props.run(editor, range),
        render: menu(c => `<span class="sg-icon">${icon(c.icon)}</span><span class="sg-text"><span class="sg-label">${esc(c.title)}</span><span class="sg-hint">${esc(c.hint)}</span></span>`,
          { cls: 'sg-blocks', empty: 'No matching block' }),
      })];
    },
  });
}

// ---------- the suggestion popup (shared by "@" and "/") ----------

// `renderItem(item)` gives an item's HTML; `group(item)` (optional) starts a titled group when it changes.
function menu(renderItem, { group = null, cls = '', empty = 'No results' } = {}) {
  return () => {
    let el = null, props = null, items = [], index = 0;

    const paint = () => {
      let html = '', last = null;
      items.forEach((it, i) => {
        const g = group?.(it);
        if (g && g !== last) html += `<div class="sg-group">${esc(g)}</div>`;
        last = g;
        html += `<div class="sg-item ${i === index ? 'on' : ''}" data-i="${i}">${renderItem(it)}</div>`;
      });
      el.innerHTML = html || `<div class="sg-empty">${esc(empty)}</div>`;
      el.querySelector('.sg-item.on')?.scrollIntoView({ block: 'nearest' });
      place();
    };

    // Below the text (or above it when there's no room), inside the window.
    const place = () => {
      const r = props?.clientRect?.();
      if (!r) return;
      const h = el.offsetHeight, w = el.offsetWidth;
      const below = r.bottom + 6 + h < innerHeight || r.top - 6 - h < 0;
      el.style.left = Math.max(6, Math.min(r.left, innerWidth - w - 6)) + 'px';
      el.style.top = (below ? r.bottom + 6 : r.top - 6 - h) + 'px';
    };

    const pick = i => items[i] && props.command(items[i]);

    return {
      onStart(p) {
        props = p;
        el = document.createElement('div');
        el.className = `sg-menu ${cls}`;
        el.addEventListener('mousedown', e => {
          e.preventDefault(); // keep the focus in the editor
          const it = e.target.closest('.sg-item');
          if (it) pick(+it.dataset.i);
        });
        document.body.append(el);
        items = p.items;
        index = 0;
        paint();
      },
      onUpdate(p) {
        props = p;
        items = p.items;
        index = Math.min(index, Math.max(0, items.length - 1));
        paint();
      },
      onKeyDown({ event }) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (!items.length) return true;
          index = (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          paint();
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          if (!items.length) return false;
          pick(index);
          return true;
        }
        if (event.key === 'Escape') {
          el.remove();
          return true;
        }
        return false;
      },
      onExit() {
        el?.remove();
        el = null;
      },
    };
  };
}
