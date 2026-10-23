// Проверка источников прямо в облаке Telegram (с тех же адресов, что и бот).
// Не деплоится: workflow копирует файл в tgcloud/endpoints/probe.js уже после
// push и запускает его командой `npx tgcloud run endpoints/probe`.
import { fetch } from 'sdk';
import { searchYoutube, youtubePlayer } from '../lib/sources/youtube.js';
import { fetchPost } from '../lib/sources/tikwm.js';
import { fetchInstagram } from '../lib/sources/instagram.js';
import { fetchTweet } from '../lib/sources/twitter.js';

const DEFAULTS = {
  youtube: 'jNQXAC9IVRw',
  tiktok: 'https://www.tiktok.com/@scout2015/video/6718335390845095173',
  instagram: 'https://www.instagram.com/p/aye83DjauH/',
  x: 'https://x.com/jack/status/20', // первый твит: без медиа, но проверяет доступность
};

// Пробует скачать первые 64 КБ — так видно, отдаёт ли сервер сам файл.
async function head(url, headers = {}) {
  try {
    const res = await fetch(url, { headers: { ...headers, Range: 'bytes=0-65535' } });
    let n = 0;
    for await (const chunk of res.body) n += chunk.length;
    return `HTTP ${res.status}, ${n} байт`;
  } catch (e) {
    return `ошибка: ${e?.message}`;
  }
}

async function check(name, fn) {
  const started = Date.now();
  try {
    return { name, ok: true, ms: Date.now() - started, ...(await fn()) };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - started, error: String(e?.message || e) };
  }
}

export default async function (input) {
  const t = { ...DEFAULTS, ...input };
  return [
    await check('youtube-search', async () => {
      const r = await searchYoutube({}, 'linkin park numb');
      return { results: r.results.length, continuation: Boolean(r.continuation), first: r.results[0]?.title };
    }),
    await check('youtube-player', async () => {
      const info = await youtubePlayer(t.youtube);
      return {
        title: info.title,
        videos: info.videos.map((v) => `${v.height}p ${v.size}`),
        audios: info.audios.map((a) => `${a.bitrate} ${a.size}`),
        videoFile: info.videos[0] ? await head(info.videos[0].url, { 'User-Agent': info.userAgent }) : null,
        audioFile: info.audios[0] ? await head(info.audios[0].url, { 'User-Agent': info.userAgent }) : null,
      };
    }),
    await check('tiktok', async () => {
      const post = await fetchPost(t.tiktok);
      return { title: post.title, file: post.video ? await head(post.video) : null };
    }),
    await check('instagram', async () => {
      const post = await fetchInstagram(t.instagram);
      return { items: post.items.map((i) => i.type), file: await head(post.items[0].url) };
    }),
    await check('x', async () => {
      try {
        const post = await fetchTweet(t.x);
        return { items: post.items.map((i) => i.type), file: await head(post.items[0].url) };
      } catch (e) {
        if (/нет видео/.test(e?.message)) return { reachable: true, note: 'пост без медиа' };
        throw e;
      }
    }),
  ];
}
