// A small picker of emoji, for the icons of notes and views: common ones, or any typed or pasted in
// its box (on a phone, the emoji keyboard).
import { esc } from './util.js?v=db25cd6';

const COMMON = '📄 📝 📌 📎 📁 📂 🗂️ 📚 📖 📓 📒 📅 🗓️ ✅ ☑️ ❌ ⚠️ ❗ ❓ 💡 🔥 ⭐ 🌟 ✨ 🎯 🚀 🛠️ 🔧 🔨 ⚙️ 🧩 🧪 🐛 🔍 🔒 🔑 🏷️ 📊 📈 📉 🗺️ 🌍 🌲 🏔️ 🏗️ 🏙️ 🧱 🛣️ 🎮 🕹️ 🎨 🖌️ 🎬 🎵 💻 🖥️ 📱 ☁️ 🗄️ 💾 🧠 💬 📣 👀 👥 🤝 💰 🛒 🏁 🏆 🎉 ❤️ 💙 💚 💛 🟢 🟡 🔴 🔵 🟣 🟠 ⚪ ⚫'.split(' ');

const graphemes = text => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(s => s.segment);
const isEmoji = g => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g);

// Opens under `r` (a rect); `done(emoji)` gets the one picked, or null for "Remove".
export function pickEmoji(r, current, done) {
  document.querySelector('.emoji-pop')?.remove();
  const el = document.createElement('div');
  el.className = 'emoji-pop';
  el.innerHTML = `<div class="ep-head"><input class="ep-q" placeholder="Type or paste an emoji" spellcheck="false">
      ${current ? '<button class="btn-sm ep-remove">Remove</button>' : ''}</div>
    <div class="ep-grid">${COMMON.map(e => `<button class="ep-e ${e === current ? 'on' : ''}" data-e="${esc(e)}">${esc(e)}</button>`).join('')}</div>`;
  document.body.append(el);
  const w = el.getBoundingClientRect();
  el.style.left = Math.max(8, Math.min(r.left, innerWidth - w.width - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(r.bottom + 4, innerHeight - w.height - 8)) + 'px';
  const close = () => { el.remove(); removeEventListener('pointerdown', outside, true); };
  const pick = e => { close(); done(e); };
  const outside = e => { if (!el.contains(e.target)) close(); };
  setTimeout(() => addEventListener('pointerdown', outside, true));
  el.addEventListener('click', e => {
    const b = e.target.closest('.ep-e');
    if (b) return pick(b.dataset.e);
    if (e.target.closest('.ep-remove')) pick(null);
  });
  const q = el.querySelector('.ep-q');
  // an emoji typed (or picked on a phone's emoji keyboard) is taken right away
  q.addEventListener('input', () => { const g = graphemes(q.value.trim()).find(isEmoji); if (g) pick(g); });
  q.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  if (matchMedia('(hover: hover)').matches) q.focus();
}
