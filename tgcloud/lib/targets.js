// Что скрывается за кнопкой «Видео»/«MP3»: ссылка, трек из поиска или запрос,
// который надо сначала найти на YouTube (после /lyrics и распознавания).
// Значение хранится в таблице keys строкой: ссылка как есть, остальное — JSON.

export function encodeTarget({ url = null, query = null, title = null, channel = null, duration = null }) {
  if (url && !title && !channel && !duration) return url;
  const obj = {};
  if (url) obj.u = url;
  if (query) obj.q = query;
  if (title) obj.t = title;
  if (channel) obj.c = channel;
  if (duration) obj.d = duration;
  return JSON.stringify(obj);
}

export function decodeTarget(value) {
  if (!value) return null;
  if (!value.startsWith('{')) return { url: value, query: null, title: null, channel: null, duration: null };
  try {
    const o = JSON.parse(value);
    return { url: o.u || null, query: o.q || null, title: o.t || null, channel: o.c || null, duration: o.d || null };
  } catch {
    return null;
  }
}
