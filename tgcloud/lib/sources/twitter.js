// X (Twitter) без cobalt: открытый API FxTwitter (api.fxtwitter.com) отдаёт
// текст поста и прямые ссылки на видео и фото.
import { fetch } from 'sdk';
import { DownloadError } from '../job.js';
import { tweetId } from '../links.js';
import { USER_AGENT } from '../transfer.js';

export function parseTweet(data) {
  const t = data?.tweet;
  if (!t) return null;
  const items = (t.media?.all || [])
    .map((m) => (m.type === 'photo'
      ? { type: 'photo', url: m.url }
      : m.url ? { type: 'video', url: m.url } : null))
    .filter(Boolean);
  return {
    title: (t.text || '').trim() || null,
    author: t.author?.name || t.author?.screen_name || null,
    items,
  };
}

export async function fetchTweet(url) {
  const id = tweetId(url);
  if (!id) throw new DownloadError('Не понял ссылку на X — пришлите ссылку на пост.');
  let data;
  try {
    const res = await fetch(`https://api.fxtwitter.com/status/${id}`, { headers: { 'User-Agent': USER_AGENT } });
    data = await res.json();
  } catch (e) {
    console.warn('FxTwitter недоступен', e?.message);
    throw new DownloadError('Сервис для X сейчас недоступен. Попробуйте позже.');
  }
  const post = parseTweet(data);
  if (!post) throw new DownloadError('Пост не найден: он удалён или закрыт.');
  if (!post.items.length) throw new DownloadError('В этом посте нет видео или фото.');
  return { ...post, source: `x:${id}` };
}
