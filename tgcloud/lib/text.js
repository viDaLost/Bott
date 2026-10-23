// Мелкие утилиты: форматирование, экранирование, клавиатуры.

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function short(text, n) {
  const s = String(text ?? '').trim();
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

export function fmtDuration(sec) {
  if (!sec) return '';
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// «3:45», «1:02:03» → секунды
export function parseDuration(text) {
  if (!text) return null;
  const parts = String(text).trim().split(':').map(Number);
  if (!parts.length || parts.some((x) => !Number.isFinite(x))) return null;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
}

export function fmtMb(bytes) {
  return (bytes / 2 ** 20).toFixed(1);
}

export function safeFilename(name, ext) {
  const base = short(String(name ?? '').replace(/[\\/:*?"<>|\n\r\t]+/g, ' ').trim(), 80) || 'file';
  return base + ext;
}

// [[['Текст', 'data'], …], …] → inline-клавиатура
export function kb(rows) {
  return {
    inline_keyboard: rows.map((row) => row.map(([text, data]) => ({ text, callback_data: data }))),
  };
}

export function randomKey(len = 12) {
  const bytes = new Uint8Array(Math.ceil(len / 2));
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}

export function now() {
  return Math.floor(Date.now() / 1000);
}

export function sleep(ms) {
  return new Promise((resolve) => (typeof setTimeout === 'function' ? setTimeout(resolve, ms) : resolve()));
}
