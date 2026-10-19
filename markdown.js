// Markdown from a note's content (a ProseMirror document as JSON), for exporting and copying notes.
// `mention(attrs)` gives the text of a mention, `database(attrs)` the one of a database block (see editor.js).

// Characters that would start Markdown syntax in plain text.
const escText = s => s.replace(/([\\`*_[\]<>~|])/g, '\\$1').replace(/^(\s*)([#>+-]|\d+\.)(?=\s)/gm, '$1\\$2');

export function toMarkdown(doc, { mention = a => `@${a.label ?? a.id}`, database = () => '' } = {}) {
  const inline = nodes => (nodes || []).map(n => {
    if (n.type === 'hardBreak') return '  \n';
    if (n.type === 'mention') return mention(n.attrs);
    if (n.type === 'image') return `![${n.attrs?.alt || ''}](${n.attrs?.src || ''})`;
    if (n.type !== 'text') return '';
    let t = n.marks?.some(m => m.type === 'code') ? '`' + n.text + '`' : escText(n.text);
    for (const m of n.marks || []) {
      if (m.type === 'bold') t = `**${t}**`;
      else if (m.type === 'italic') t = `_${t}_`;
      else if (m.type === 'strike') t = `~~${t}~~`;
      else if (m.type === 'underline') t = `<u>${t}</u>`;
      else if (m.type === 'link') t = `[${t}](${m.attrs.href})`;
    }
    return t;
  }).join('');

  // Each block gives its lines; nested blocks are indented by their container.
  const block = (n, ctx = {}) => {
    const kids = (nodes, c) => (nodes || []).map(k => block(k, c));
    switch (n.type) {
      case 'paragraph': return inline(n.content);
      case 'heading': return '#'.repeat(n.attrs?.level || 1) + ' ' + inline(n.content);
      case 'horizontalRule': return '---';
      case 'image': return `![${n.attrs?.alt || ''}](${n.attrs?.src || ''})`;
      case 'database': return database(n.attrs);
      case 'table': {
        // the first row is the header; cells keep their text on one line
        const rows = (n.content || []).map(r => (r.content || []).map(c => kids(c.content).join(' ').replace(/\n+/g, ' ').replace(/\|/g, '\\|')));
        if (!rows.length) return '';
        const line = cells => `| ${cells.join(' | ')} |`;
        return [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n');
      }
      case 'codeBlock': return '```' + (n.attrs?.language || '') + '\n' + (n.content || []).map(t => t.text).join('') + '\n```';
      case 'blockquote': return kids(n.content).join('\n\n').split('\n').map(l => (l ? '> ' + l : '>')).join('\n');
      case 'bulletList':
      case 'orderedList':
      case 'taskList': {
        let k = n.attrs?.start ?? 1;
        const isList = c => ['bulletList', 'orderedList', 'taskList'].includes(c.type);
        return (n.content || []).map(item => {
          const marker = n.type === 'orderedList' ? `${k++}.` : n.type === 'taskList' ? `- [${item.attrs?.checked ? 'x' : ' '}]` : '-';
          // a nested list goes right below its item's text; other blocks of the item are paragraphs
          const body = (item.content || []).map((c, i) => (i ? (isList(c) ? '\n' : '\n\n') : '') + block(c)).join('');
          const pad = ' '.repeat(marker.length + 1);
          return marker + ' ' + body.split('\n').map((l, i) => (i && l ? pad + l : l)).join('\n');
        }).join('\n');
      }
      default: return kids(n.content, ctx).join('\n\n');
    }
  };

  return (doc?.content || []).map(n => block(n)).join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
