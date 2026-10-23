// Поиск на YouTube без yt-dlp: внутренний API сайта (youtubei/v1/search),
// который отдаёт JSON и токен продолжения для следующих страниц.
// Если он перестанет отвечать, а владелец задал youtube_key, — YouTube Data API.
import { fetch } from 'sdk';
import { parseDuration } from '../text.js';
import { USER_AGENT } from '../transfer.js';

const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false';
const CLIENT = { clientName: 'WEB', clientVersion: '2.20251001.00.00', hl: 'ru', gl: 'US' };
const VIDEOS_ONLY = 'EgIQAQ%3D%3D'; // фильтр «только видео»

function runsText(node) {
  if (!node) return '';
  if (node.simpleText) return node.simpleText;
  return (node.runs || []).map((r) => r.text).join('');
}

// Обходит ответ и собирает videoRenderer и токен продолжения — так разбор
// не ломается, когда YouTube меняет вложенность блоков.
export function parseInnertube(data) {
  const results = [];
  let continuation = null;
  const stack = [data];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    if (node.videoRenderer?.videoId) {
      const v = node.videoRenderer;
      results.push({
        id: v.videoId,
        title: runsText(v.title) || 'Без названия',
        duration: parseDuration(runsText(v.lengthText)),
        channel: runsText(v.ownerText || v.longBylineText) || null,
        live: !v.lengthText, // у трансляций нет длительности — скачать их нельзя
      });
      continue;
    }
    const token = node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (token) {
      continuation = token;
      continue;
    }
    const values = Object.values(node);
    for (let i = values.length - 1; i >= 0; i--) {
      if (values[i] && typeof values[i] === 'object') stack.push(values[i]);
    }
  }
  return { results: results.filter((r) => !r.live).map(({ live, ...r }) => r), continuation };
}

async function innertube(body) {
  const res = await fetch(INNERTUBE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ context: { client: CLIENT }, ...body }),
  });
  if (!res.ok) throw new Error(`YouTube search HTTP ${res.status}`);
  return parseInnertube(await res.json());
}

function isoDuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : null;
}

// YouTube Data API v3: 100 единиц квоты на поиск, бесплатно ~100 поисков в сутки.
async function dataApi(key, query, pageToken) {
  let url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=25'
    + `&q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`;
  if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YouTube Data API HTTP ${res.status}`);
  const data = await res.json();
  const items = (data.items || []).filter((i) => i.id?.videoId);
  const durations = {};
  if (items.length) {
    const ids = items.map((i) => i.id.videoId).join(',');
    const det = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${encodeURIComponent(key)}`);
    if (det.ok) {
      for (const v of (await det.json()).items || []) durations[v.id] = isoDuration(v.contentDetails?.duration);
    }
  }
  return {
    results: items
      .filter((i) => i.snippet?.liveBroadcastContent !== 'live')
      .map((i) => ({
        id: i.id.videoId,
        title: decodeEntities(i.snippet?.title) || 'Без названия',
        duration: durations[i.id.videoId] ?? null,
        channel: decodeEntities(i.snippet?.channelTitle) || null,
      })),
    continuation: data.nextPageToken ? `api:${data.nextPageToken}` : null,
  };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Первая страница поиска. Возвращает { results, continuation }.
export async function searchYoutube(cfg, query) {
  try {
    return await innertube({ query, params: VIDEOS_ONLY });
  } catch (e) {
    if (!cfg.youtubeKey) throw e;
    console.warn('Поиск через youtubei не удался, пробую Data API', e);
    return dataApi(cfg.youtubeKey, query, null);
  }
}

// Следующая пачка результатов по токену продолжения.
export async function searchMore(cfg, query, continuation) {
  if (continuation.startsWith('api:')) return dataApi(cfg.youtubeKey, query, continuation.slice(4));
  return innertube({ continuation });
}

// Название и автор ролика по ссылке — для подписи к файлу.
export async function oembed(url) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return { title: data.title || null, author: data.author_name || null };
  } catch {
    return null;
  }
}
