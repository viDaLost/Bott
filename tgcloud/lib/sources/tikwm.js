// TikTok через публичный сервис tikwm.com: видео без водяного знака,
// фото из каруселей и звук. Ключ не нужен; бесплатный лимит — ~1 запрос в секунду.
import { fetch } from 'sdk';
import { DownloadError, TooLarge } from '../job.js';
import { escapeHtml, sleep } from '../text.js';
import { USER_AGENT } from '../transfer.js';

const API_URL = 'https://www.tikwm.com/api/';
const BASE_URL = 'https://www.tikwm.com';
export const MAX_PHOTOS = 30;

function abs(url) {
  if (!url) return null;
  return url.startsWith('/') ? BASE_URL + url : url;
}

export function parsePost(data) {
  const music = data.music_info || {};
  const author = data.author || {};
  return {
    id: String(data.id || ''),
    title: String(data.title || '').trim() || 'TikTok',
    author: author.nickname || author.unique_id || '',
    duration: data.duration ? Math.floor(Number(data.duration)) : null,
    cover: abs(data.origin_cover || data.cover),
    video: abs(data.play),
    videoSize: Number(data.size) || null,
    hdVideo: abs(data.hdplay),
    hdSize: Number(data.hd_size) || null,
    music: abs(data.music || music.play),
    musicTitle: music.title || null,
    musicAuthor: music.author || null,
    images: (data.images || []).filter(Boolean).map(abs),
  };
}

// Тот же формат, что у кэша по ссылкам (lib/links.js), чтобы file_id был общим.
export function postSource(post) {
  return post.id ? `tiktok:${post.id}` : null;
}

export async function fetchPost(url) {
  const query = `${API_URL}?url=${encodeURIComponent(url)}&hd=1`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let data;
    try {
      const res = await fetch(query, { headers: { 'User-Agent': USER_AGENT } });
      data = await res.json();
    } catch (e) {
      console.warn('TikWM недоступен', e);
      throw new DownloadError('Сервис TikWM сейчас недоступен.');
    }
    if (data?.code === 0 && data.data) return parsePost(data.data);
    const msg = String(data?.msg || 'неизвестная ошибка');
    if (/limit/i.test(msg) && attempt < 2) {
      await sleep(1100); // упёрлись в лимит 1 запрос/с — повторяем после паузы
      continue;
    }
    console.warn('TikWM ответил ошибкой', msg);
    throw new DownloadError(`TikWM не смог получить пост: ${escapeHtml(msg)}`);
  }
  throw new DownloadError('TikWM перегружен, попробуйте через минуту.');
}

// Ссылки на видео от лучшего к худшему, которые по известному размеру влезают в лимит.
export function videoCandidates(post, limit) {
  const list = [];
  if (post.hdVideo && (!post.hdSize || post.hdSize <= limit)) list.push(post.hdVideo);
  if (post.video && (!post.videoSize || post.videoSize <= limit)) list.push(post.video);
  if (!list.length) {
    if (post.video || post.hdVideo) throw new TooLarge('Видео больше лимита Telegram.');
    throw new DownloadError('В этом посте нет видео.');
  }
  return [...new Set(list)];
}
