// The rich text editor of the notes (TipTap, bundled in vendor/tiptap.js): text, headings, lists,
// to-do lists, quotes, code blocks, links, images, tables and database blocks, with Markdown-like
// shortcuts ("# ", "- ", "[] "...), a "/" menu to change or insert blocks, and "@" mentions of
// notes, files, commits and branches.
import { Editor, Extension, Node, StarterKit, TaskList, TaskItem, Placeholder, Mention, Image, TableKit, Markdown, Suggestion, PluginKey, Collaboration, getSchema } from './vendor/tiptap.js?v=ceecca2';
import { esc, icon } from './util.js?v=ceecca2';

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
// mentions(query) -> Promise<items>, mentionView(attrs) -> { icon, label, title },
// openMention(attrs, event), openLink(href), fileUrl(src), renderDatabase(el, id, { remove }),
// uploadImage(file) -> Promise<src> (pictures pasted, dropped or added with "/image"), onError(error),
// commands: extra "/" items [{ title, hint, icon, run(editor, range) }] }.
// Mention items are { kind, id, repo, label, detail }.
export function createEditor(el, opts) {
  let editor = null;
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
      // Pictures pasted or dropped in are uploaded and put in the text.
      handlePaste: (view, event) => {
        const files = opts.uploadImage ? imageFiles(event.clipboardData?.files) : [];
        if (!files.length) return false;
        event.preventDefault();
        addImages(editor, opts, files);
        return true;
      },
      handleDrop: (view, event, slice, moved) => {
        const files = !moved && opts.uploadImage ? imageFiles(event.dataTransfer?.files) : [];
        if (!files.length) return false;
        event.preventDefault();
        addImages(editor, opts, files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? null);
        return true;
      },
    },
    onUpdate: ({ editor }) => opts.onChange?.(editor.getJSON()),
  }));
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
        dom.className = `mention m-${node.attrs.kind}`;
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
