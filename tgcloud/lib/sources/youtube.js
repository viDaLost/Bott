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

// ------------------------------------------------------------------ скачивание без cobalt
// Плеер YouTube отдаёт прямые ссылки на файлы. Мобильные клиенты (Android, iOS,
// Android VR) получают ссылки без шифрования подписи — их можно скачать обычным
// fetch. Проверено из облака Telegram: Android отдаёт и видео со звуком, и аудио. Без ffmpeg
// нельзя склеить отдельные дорожки, поэтому видео — только «готовые» форматы
// со звуком (обычно 360p), а аудио — M4A (AAC), который Telegram играет как музыку.

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const PLAYER_CLIENTS = [
  {
    id: '3',
    client: {
      clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30,
      osName: 'Android', osVersion: '11', hl: 'ru', gl: 'US',
    },
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip',
  },
  {
    id: '28',
    client: {
      clientName: 'ANDROID_VR', clientVersion: '1.65.10', deviceMake: 'Oculus', deviceModel: 'Quest 3',
      androidSdkVersion: 32, osName: 'Android', osVersion: '12L', hl: 'ru', gl: 'US',
    },
    userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 '
      + '(Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
  },
  {
    id: '5',
    client: {
      clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2',
      osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'ru', gl: 'US',
    },
    userAgent: 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
  },
];

export class YoutubeBlocked extends Error {}

function playabilityError(status) {
  const reason = [status?.reason, ...(status?.messages || [])].filter(Boolean).join(' ');
  if (/sign in|bot|войдите/i.test(reason)) return 'YouTube просит подтвердить, что запрос не от бота.';
  if (/private|частн/i.test(reason)) return 'Видео приватное.';
  if (/age|возраст/i.test(reason)) return 'Видео с возрастным ограничением — скачать нельзя.';
  if (/country|стран|region/i.test(reason)) return 'Видео недоступно в регионе сервера.';
  if (/live/i.test(reason)) return 'Трансляции скачать нельзя.';
  return reason ? `YouTube: ${reason}` : 'Видео недоступно.';
}

function formatSize(f, duration) {
  const exact = Number(f.contentLength);
  if (exact) return { size: exact, exact: true };
  const rate = Number(f.bitrate || f.averageBitrate);
  return rate && duration ? { size: Math.round(rate / 8 * duration), exact: false } : { size: null, exact: false };
}

// Разбирает ответ плеера: метаданные и подходящие форматы (от лучшего к худшему).
export function parsePlayer(data) {
  const status = data?.playabilityStatus;
  if (status?.status !== 'OK') {
    throw new YoutubeBlocked(playabilityError(status));
  }
  const details = data.videoDetails || {};
  const duration = Number(details.lengthSeconds) || null;
  const sd = data.streamingData || {};
  const withUrl = (list) => (list || []).filter((f) => f.url && f.mimeType);

  const videos = withUrl(sd.formats)
    .filter((f) => f.mimeType.startsWith('video/mp4'))
    .map((f) => ({ url: f.url, height: f.height || 0, mime: 'video/mp4', ...formatSize(f, duration) }))
    .sort((a, b) => b.height - a.height);

  const audios = withUrl(sd.adaptiveFormats)
    .filter((f) => f.mimeType.startsWith('audio/mp4'))
    .map((f) => ({ url: f.url, bitrate: Number(f.bitrate) || 0, mime: 'audio/mp4', ...formatSize(f, duration) }))
    .sort((a, b) => b.bitrate - a.bitrate);

  return {
    title: details.title || null,
    author: details.author || null,
    duration,
    live: Boolean(details.isLiveContent && !duration),
    videos,
    audios,
  };
}

// kind: 'v' — нужен файл со звуком и видео, 'a' — звук; null — любой.
// Клиенты перебираются, пока какой-нибудь не отдаст нужный формат.
export async function youtubePlayer(videoId, kind = null) {
  let lastError = null;
  let fallback = null;
  for (const c of PLAYER_CLIENTS) {
    try {
      const res = await fetch(PLAYER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': c.userAgent,
          'X-YouTube-Client-Name': c.id,
          'X-YouTube-Client-Version': c.client.clientVersion,
        },
        body: JSON.stringify({
          context: { client: c.client }, videoId, contentCheckOk: true, racyCheckOk: true,
        }),
      });
      if (!res.ok) throw new YoutubeBlocked(`YouTube ответил HTTP ${res.status}.`);
      const info = { ...parsePlayer(await res.json()), userAgent: c.userAgent, client: c.client.clientName };
      const wanted = kind === 'v' ? info.videos : kind === 'a' ? info.audios : [...info.videos, ...info.audios];
      if (wanted.length) return info;
      fallback = fallback || info;
      lastError = new YoutubeBlocked('YouTube не отдал ссылки на файлы.');
    } catch (e) {
      lastError = e;
      console.warn(`YouTube player (${c.client.clientName}) не сработал:`, e?.message);
    }
  }
  // метаданные пригодятся для понятной ошибки, даже если нужного формата нет
  if (fallback) return fallback;
  throw lastError || new YoutubeBlocked('YouTube недоступен.');
}
