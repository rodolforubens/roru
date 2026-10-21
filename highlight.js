// Lightweight syntax highlighting for the diff viewer, with no dependencies.
// Each language is a small rule set (comments, strings, keywords...). The tokenizer
// carries state between lines, so block comments and multi-line strings stay
// colored across the lines of a hunk.
import { esc } from './util.js?v=589d7e5';

const words = s => new Set(s.split(/\s+/).filter(Boolean));

const C_FAMILY = 'abstract as async await break case catch class const continue default do else enum ' +
  'explicit extends extern final finally for foreach friend fun func goto if implements import in inline ' +
  'interface internal is let namespace new noexcept operator override package private protected public ' +
  'readonly ref return sealed sizeof static struct super switch template this throw throws try typedef ' +
  'typename typeof union unsafe using val var virtual volatile when where while with yield delete constexpr ' +
  'mutable register signed unsigned auto out params lock fixed checked unchecked event delegate object get set';
const C_TYPES = 'int long short char float double bool boolean byte sbyte uint ulong ushort decimal string void ' +
  'size_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t Int Long Double Float Boolean Unit Any';
const JS = 'break case catch class const continue debugger default delete do else export extends finally for ' +
  'from function if import in instanceof let new of return static super switch this throw try typeof var void ' +
  'while with yield async await get set as';
const TS = JS + ' interface type enum implements namespace declare abstract private protected public readonly ' +
  'keyof infer is satisfies';

const C_LIKE = { line: ['//'], block: [['/*', '*/']], strings: ['"', "'"], numbers: true, capTypes: true, calls: true };

const LANGS = {
  js: { ...C_LIKE, strings: ['"', "'", '`'], multiline: ['`'], keywords: words(JS), decorators: true, capTypes: false,
    literals: words('true false null undefined NaN Infinity'), types: words('') },
  ts: { ...C_LIKE, strings: ['"', "'", '`'], multiline: ['`'], keywords: words(TS), decorators: true,
    literals: words('true false null undefined NaN Infinity'),
    types: words('any unknown never string number boolean symbol bigint object void') },
  rust: { ...C_LIKE, strings: ['"'], chars: true, rustAttrs: true,
    keywords: words('as async await break const continue crate dyn else enum extern fn for if impl in let loop ' +
      'match mod move mut pub ref return self static struct super trait type unsafe use where while'),
    literals: words('true false None Some Ok Err Self'),
    types: words('i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box') },
  go: { ...C_LIKE, strings: ['"', '`'], multiline: ['`'], chars: true,
    keywords: words('break case chan const continue default defer else fallthrough for func go goto if import ' +
      'interface map package range return select struct switch type var'),
    literals: words('true false nil iota'),
    types: words('int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 ' +
      'complex128 string bool byte rune error any') },
  clike: { ...C_LIKE, strings: ['"'], chars: true, preprocessor: true, decorators: true,
    keywords: words(C_FAMILY), literals: words('true false null nil nullptr NULL'), types: words(C_TYPES) },
  php: { ...C_LIKE, line: ['//', '#'], vars: true,
    keywords: words('abstract and as break case catch class clone const continue declare default do echo else ' +
      'elseif enum extends final finally fn for foreach function global if implements include interface match ' +
      'namespace new or private protected public readonly require return static switch throw trait try use var while yield'),
    literals: words('true false null TRUE FALSE NULL'), types: words('int float string bool array object mixed void') },
  python: { line: ['#'], strings: ['"""', "'''", '"', "'"], multiline: ['"""', "'''"], numbers: true, calls: true,
    decorators: true, capTypes: true,
    keywords: words('and as assert async await break class continue def del elif else except finally for from ' +
      'global if import in is lambda nonlocal not or pass raise return try while with yield match case'),
    literals: words('True False None self cls'), types: words('int float str bool list dict tuple set bytes object') },
  ruby: { line: ['#'], strings: ['"', "'"], numbers: true, calls: true, capTypes: true, vars: true,
    keywords: words('alias and begin break case class def defined do else elsif end ensure for if in module next ' +
      'not or redo rescue retry return self super then undef unless until when while yield require attr_accessor'),
    literals: words('true false nil') },
  lua: { line: ['--'], block: [['--[[', ']]']], strings: ['"', "'"], numbers: true, calls: true,
    keywords: words('and break do else elseif end for function goto if in local not or repeat return then until while'),
    literals: words('true false nil') },
  shell: { line: ['#'], strings: ['"', "'"], numbers: true, vars: true,
    keywords: words('if then else elif fi for while until do done case esac function in return export local ' +
      'readonly declare unset shift exit source alias echo cd set') },
  powershell: { line: ['#'], block: [['<#', '#>']], strings: ['"', "'"], numbers: true, vars: true, ci: true, calls: true, cmdlets: true,
    keywords: words('begin break catch class continue data do dynamicparam else elseif end exit filter finally for ' +
      'foreach from function if in param process return switch throw trap try until using var while'),
    literals: words('$true $false $null') },
  bat: { line: ['::', 'REM ', 'rem '], strings: ['"'], vars: true, ci: true,
    keywords: words('echo set if else goto call exit for in do not exist defined errorlevel setlocal endlocal shift pause') },
  sql: { line: ['--'], block: [['/*', '*/']], strings: ["'", '"'], numbers: true, ci: true, calls: true,
    keywords: words('select from where insert into values update set delete create table alter drop index view join ' +
      'left right inner outer full cross on and or not as order by group having limit offset distinct union all ' +
      'primary key foreign references default exists case when then else end begin commit rollback with returning ' +
      'unique check constraint is in like between asc desc'),
    literals: words('true false null'),
    types: words('int integer bigint smallint text varchar char boolean date timestamp numeric decimal real float serial uuid json jsonb') },
  css: { block: [['/*', '*/']], strings: ['"', "'"], numbers: true, css: true },
  scss: { line: ['//'], block: [['/*', '*/']], strings: ['"', "'"], numbers: true, css: true, vars: true },
  json: { strings: ['"'], numbers: true, jsonKeys: true, literals: words('true false null') },
  jsonc: { line: ['//'], block: [['/*', '*/']], strings: ['"'], numbers: true, jsonKeys: true, literals: words('true false null') },
  yaml: { line: ['#'], strings: ['"', "'"], numbers: true, yamlKeys: true, literals: words('true false null yes no on off ~') },
  ini: { line: ['#', ';'], strings: ['"', "'"], numbers: true, iniKeys: true, literals: words('true false yes no on off') },
  docker: { line: ['#'], strings: ['"', "'"], numbers: true, vars: true, ci: true,
    keywords: words('from run cmd copy add env arg workdir expose entrypoint user volume label shell healthcheck onbuild stopsignal as') },
  markup: { markup: true },
  markdown: { markdown: true },
};

const EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  rs: 'rust', go: 'go', php: 'php', py: 'python', pyw: 'python', rb: 'ruby', lua: 'lua',
  c: 'clike', h: 'clike', cc: 'clike', cpp: 'clike', cxx: 'clike', hpp: 'clike', hh: 'clike', ino: 'clike',
  cs: 'clike', java: 'clike', kt: 'clike', kts: 'clike', scala: 'clike', groovy: 'clike', gradle: 'clike',
  dart: 'clike', swift: 'clike', m: 'clike', mm: 'clike', shader: 'clike', hlsl: 'clike', glsl: 'clike', compute: 'clike',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell', bat: 'bat', cmd: 'bat',
  sql: 'sql', css: 'css', scss: 'scss', sass: 'scss', less: 'scss',
  json: 'json', jsonc: 'jsonc', json5: 'jsonc', asmdef: 'json',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'ini',
  editorconfig: 'ini', gitignore: 'ini', gitattributes: 'ini', gitmodules: 'ini', npmrc: 'ini',
  html: 'markup', htm: 'markup', xhtml: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup',
  xaml: 'markup', csproj: 'markup', props: 'markup', targets: 'markup', plist: 'markup', resx: 'markup', uxml: 'markup', uss: 'css',
  md: 'markdown', markdown: 'markdown',
};
const NAMES = { dockerfile: 'docker', makefile: 'shell', gemfile: 'ruby', rakefile: 'ruby', '.bashrc': 'shell', '.zshrc': 'shell' };

export function languageFor(path) {
  const name = path.split('/').pop().toLowerCase();
  if (NAMES[name]) return NAMES[name];
  if (name.startsWith('dockerfile')) return 'docker';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return EXT[ext] || null;
}

const span = (cls, text) => (text ? `<span class="tk-${cls}">${esc(text)}</span>` : '');

const NUM = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z%]*/y;
const IDENT = /[A-Za-z_$][\w$]*/y;
const CSS_IDENT = /-{0,2}[A-Za-z_][\w-]*/y;
const VAR = /\$\{[^}]*\}|\$[\w:]+|%[\w]+%/y;
const CHAR = /'(?:\\.|[^\\'])'/y;
const HEX = /#[0-9a-fA-F]{3,8}\b/y;

const at = (re, text, i) => { re.lastIndex = i; const m = re.exec(text); return m && m[0]; };

// Index just past the closing quote `q`, skipping backslash escapes; -1 if the line ends first.
function findClose(text, from, q) {
  for (let j = from; j < text.length; j++) {
    if (text[j] === '\\') { j++; continue; }
    if (text.startsWith(q, j)) return j + q.length;
  }
  return -1;
}

// Highlighting that depends on where the line starts (keys, sections, directives).
function linePrefix(text, L) {
  let m;
  if (L.yamlKeys) {
    if (/^(---|\.\.\.)\s*$/.test(text)) return { html: span('keyword', text), end: text.length };
    if ((m = /^(\s*(?:-\s+)?)([^\s#:'"][^:#]*?|"[^"]*"|'[^']*')(\s*:)(?=\s|$)/.exec(text))) return { html: esc(m[1]) + span('prop', m[2]) + esc(m[3]), end: m[0].length };
  }
  if (L.iniKeys) {
    if ((m = /^\s*\[[^\]]*\]/.exec(text))) return { html: span('keyword', m[0]), end: m[0].length };
    if ((m = /^(\s*)([\w.\-@/]+)(\s*[=:])/.exec(text))) return { html: esc(m[1]) + span('prop', m[2]) + esc(m[3]), end: m[0].length };
  }
  if (L.preprocessor && (m = /^\s*#\s*[a-z]+/.exec(text))) return { html: span('meta', m[0]), end: m[0].length };
  return null;
}

function tokenize(text, L, st) {
  let out = '', plain = '', i = 0;
  const flush = () => { out += esc(plain); plain = ''; };
  const emit = (cls, s) => { flush(); out += span(cls, s); };

  // continue a block comment or multi-line string from the previous line
  if (st.block) {
    const end = text.indexOf(st.block);
    if (end < 0) return span('comment', text);
    emit('comment', text.slice(0, end + st.block.length));
    i = end + st.block.length;
    st.block = null;
  } else if (st.str) {
    const end = findClose(text, 0, st.str);
    if (end < 0) return span('string', text);
    emit('string', text.slice(0, end));
    i = end;
    st.str = null;
  } else {
    const p = linePrefix(text, L);
    if (p) { out += p.html; i = p.end; }
  }

  while (i < text.length) {
    const ch = text[i];
    const block = L.block?.find(([open]) => text.startsWith(open, i));
    if (block) {
      const end = text.indexOf(block[1], i + block[0].length);
      if (end < 0) { emit('comment', text.slice(i)); st.block = block[1]; break; }
      emit('comment', text.slice(i, end + block[1].length));
      i = end + block[1].length;
      continue;
    }
    // '#' only starts a comment at the line start or after whitespace (not in `$#`, `a#b`)
    if (L.line?.some(p => text.startsWith(p, i) && (p !== '#' || i === 0 || /\s/.test(text[i - 1])))) {
      emit('comment', text.slice(i));
      break;
    }
    if (L.rustAttrs && (text.startsWith('#[', i) || text.startsWith('#![', i))) {
      const end = text.indexOf(']', i);
      const stop = end < 0 ? text.length : end + 1;
      emit('meta', text.slice(i, stop));
      i = stop;
      continue;
    }
    const q = L.strings?.find(s => text.startsWith(s, i));
    if (q) {
      const end = findClose(text, i + q.length, q);
      if (end < 0) {
        emit('string', text.slice(i));
        if (L.multiline?.includes(q)) st.str = q;
        break;
      }
      const isKey = L.jsonKeys && /^\s*:/.test(text.slice(end));
      emit(isKey ? 'prop' : 'string', text.slice(i, end));
      i = end;
      continue;
    }
    let m;
    if (L.chars && ch === "'" && (m = at(CHAR, text, i))) { emit('string', m); i += m.length; continue; }
    if (L.vars && (ch === '$' || ch === '%') && (m = at(VAR, text, i))) {
      emit(L.literals?.has(m.toLowerCase()) ? 'literal' : 'var', m);
      i += m.length;
      continue;
    }
    if (L.css && ch === '@' && (m = at(/@[\w-]+/y, text, i))) { emit('keyword', m); i += m.length; continue; }
    if (L.css && ch === '#' && (m = at(HEX, text, i))) { emit('number', m); i += m.length; continue; }
    if (L.decorators && ch === '@' && (m = at(/@[\w.]+/y, text, i))) { emit('meta', m); i += m.length; continue; }
    const prev = i > 0 ? text[i - 1] : '';
    if (L.cmdlets && !/[\w$-]/.test(prev) && (m = at(/[A-Z][a-z]+-[A-Z][A-Za-z]+/y, text, i))) { emit('fn', m); i += m.length; continue; }
    if (L.numbers && /\d/.test(ch) && !/[\w$.]/.test(prev) && (m = at(NUM, text, i))) { emit('number', m); i += m.length; continue; }
    if (/[A-Za-z_$-]/.test(ch) && !/[\w$]/.test(prev) && (m = at(L.css ? CSS_IDENT : IDENT, text, i))) {
      i += m.length;
      const w = L.ci ? m.toLowerCase() : m;
      const next = text.slice(i).match(/^\s*(.?)/)[1];
      let cls = null;
      if (L.keywords?.has(w)) cls = 'keyword';
      else if (L.literals?.has(w)) cls = 'literal';
      else if (L.types?.has(m)) cls = 'type';
      else if (L.css) cls = next === ':' && !text.includes('{') ? 'prop' : null;
      else if (L.calls && next === '(') cls = 'fn';
      else if (L.rustAttrs && text[i] === '!' && text[i + 1] !== '=') cls = 'fn'; // macros: format!, vec!
      else if (L.capTypes && /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(m)) cls = 'type';
      if (cls) emit(cls, m); else plain += m;
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}

function markup(text, st) {
  let out = '', plain = '', i = 0;
  const flush = () => { out += esc(plain); plain = ''; };
  const emit = (cls, s) => { flush(); out += span(cls, s); };
  while (i < text.length) {
    if (st.block) {
      const end = text.indexOf('-->', i);
      if (end < 0) { emit('comment', text.slice(i)); break; }
      emit('comment', text.slice(i, end + 3));
      i = end + 3;
      st.block = null;
      continue;
    }
    if (st.tag) {
      const c = text[i];
      if (text.startsWith('/>', i) || text.startsWith('?>', i)) { plain += text.slice(i, i + 2); i += 2; st.tag = false; continue; }
      if (c === '>') { plain += c; i++; st.tag = false; continue; }
      if (c === '"' || c === "'") {
        const end = text.indexOf(c, i + 1);
        const stop = end < 0 ? text.length : end + 1;
        emit('string', text.slice(i, stop));
        i = stop;
        continue;
      }
      const attr = at(/[^\s=>/"'?]+/y, text, i);
      if (attr) { emit('attr', attr); i += attr.length; continue; }
      plain += c;
      i++;
      continue;
    }
    if (text.startsWith('<!--', i)) { emit('comment', '<!--'); i += 4; st.block = '-->'; continue; }
    const tag = /<([/?!]?)([A-Za-z][\w:.-]*)/y;
    tag.lastIndex = i;
    const m = tag.exec(text);
    if (m) { plain += '<' + m[1]; emit('tag', m[2]); i += m[0].length; st.tag = true; continue; }
    const ent = at(/&[#\w]+;/y, text, i);
    if (ent) { emit('literal', ent); i += ent.length; continue; }
    plain += text[i];
    i++;
  }
  flush();
  return out;
}

function markdown(text, st) {
  if (/^\s*(```|~~~)/.test(text)) { st.fence = !st.fence; return span('meta', text); }
  if (st.fence) return span('string', text);
  if (/^#{1,6}\s/.test(text)) return span('keyword', text);
  if (/^\s*>/.test(text)) return span('comment', text);
  let out = '', last = 0;
  const re = /`[^`]+`|\[([^\]]*)\]\([^)]*\)|^(\s*)([-*+]|\d+[.)])(?=\s)/g;
  for (let m; (m = re.exec(text));) {
    out += esc(text.slice(last, m.index));
    if (m[0][0] === '`') out += span('string', m[0]);
    else if (m[3]) out += esc(m[2]) + span('keyword', m[3]);
    else out += esc(`[${m[1]}]`) + span('fn', m[0].slice(m[1].length + 2));
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

const MAX_LINE = 2000; // minified files: skip highlighting very long lines

// Returns a function (text, state) => html for the file's language, or null if unknown.
// Use one state object per side (old/new) and per hunk.
export function highlighterFor(path) {
  const id = languageFor(path);
  const L = id && LANGS[id];
  if (!L) return null;
  const fn = L.markup ? markup : L.markdown ? markdown : (text, st) => tokenize(text, L, st);
  return (text, st) => (text.length > MAX_LINE ? esc(text) : fn(text, st));
}
