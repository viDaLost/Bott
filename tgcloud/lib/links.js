// Разбор ссылок: поиск в тексте, название сайта, устойчивые идентификаторы для кэша.

export const URL_RE = /https?:\/\/[^\s<>"']+/;

export function findUrl(text) {
  const m = URL_RE.exec(text || '');
  // хвостовые знаки препинания обычно не часть ссылки: «смотри https://…/abc).»
  return m ? m[0].replace(/[).,!?»]+$/, '') : null;
}

export function hostname(url) {
  const m = /^https?:\/\/(?:[^@/?#]*@)?([^/?#:]+)/i.exec(url || '');
  return m ? m[1].toLowerCase() : '';
}

function onDomain(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

const SITE_NAMES = [
  ['youtube.com', 'YouTube'], ['youtu.be', 'YouTube'], ['tiktok.com', 'TikTok'],
  ['instagram.com', 'Instagram'], ['vk.com', 'VK'], ['vkvideo.ru', 'VK'],
  ['twitter.com', 'X (Twitter)'], ['x.com', 'X (Twitter)'], ['facebook.com', 'Facebook'],
  ['soundcloud.com', 'SoundCloud'], ['rutube.ru', 'Rutube'], ['pinterest.com', 'Pinterest'],
  ['reddit.com', 'Reddit'], ['twitch.tv', 'Twitch'], ['vimeo.com', 'Vimeo'],
];

export function siteName(url) {
  const host = hostname(url);
  for (const [domain, name] of SITE_NAMES) if (onDomain(host, domain)) return name;
  return host.replace(/^www\./, '') || 'Сайт';
}

export function isTikTok(url) {
  return onDomain(hostname(url), 'tiktok.com');
}

export function youtubeId(url) {
  const host = hostname(url);
  let m;
  if (onDomain(host, 'youtu.be')) {
    m = /^https?:\/\/[^/]+\/([\w-]{11})/.exec(url);
  } else if (onDomain(host, 'youtube.com')) {
    m = /[?&]v=([\w-]{11})/.exec(url) || /\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(url);
  }
  return m ? m[1] : null;
}

export function tiktokId(url) {
  if (!isTikTok(url)) return null;
  const m = /\/(?:video|photo)\/(\d{8,})/.exec(url);
  return m ? m[1] : null;
}

export function instagramShortcode(url) {
  if (!onDomain(hostname(url), 'instagram.com')) return null;
  const m = /instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]{5,})/i.exec(url);
  return m ? m[1] : null;
}

export function tweetId(url) {
  const host = hostname(url);
  if (!onDomain(host, 'x.com') && !onDomain(host, 'twitter.com')) return null;
  const m = /\/(?:\w+|i\/web)\/status(?:es)?\/(\d+)/i.exec(url);
  return m ? m[1] : null;
}

// Разные ссылки на одно видео дают один и тот же идентификатор — так кэш file_id
// срабатывает и для youtu.be/…, и для youtube.com/watch?v=…, и для Shorts.
export function sourceIds(url) {
  const ids = [];
  const yt = youtubeId(url);
  if (yt) ids.push(`youtube:${yt}`);
  const tt = tiktokId(url);
  if (tt) ids.push(`tiktok:${tt}`);
  const ig = instagramShortcode(url);
  if (ig) ids.push(`instagram:${ig}`);
  const tw = tweetId(url);
  if (tw) ids.push(`x:${tw}`);
  ids.push(url);
  return ids;
}

export function youtubeUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}
