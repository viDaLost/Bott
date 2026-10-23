// cobalt (https://github.com/imputnet/cobalt) — сервис, который делает то же,
// что yt-dlp + ffmpeg: достаёт видео/звук с YouTube, Instagram, VK, X, Reddit и
// др., склеивает дорожки и конвертирует в mp3. В Serverless нельзя запускать
// yt-dlp, поэтому бот обращается к cobalt по HTTP.
import { fetch } from 'sdk';
import { DownloadError } from '../job.js';
import { siteName } from '../links.js';
import { escapeHtml } from '../text.js';

export function cobaltConfigured(cfg) {
  return Boolean(cfg.cobaltUrl);
}

export function humanizeCobaltError(code, url) {
  const c = String(code || '');
  const site = escapeHtml(siteName(url));
  if (c.includes('auth')) return 'cobalt отклонил запрос: проверьте cobalt_key (/set cobalt_key …).';
  if (c.includes('rate_exceeded')) return 'cobalt перегружен, попробуйте через минуту.';
  if (c.includes('link.unsupported') || c.includes('service.unsupported')) return 'Эта ссылка не поддерживается.';
  if (c.includes('link.invalid')) return 'Ссылка выглядит неправильной.';
  if (c.includes('too_long')) return 'Запись слишком длинная.';
  if (c.includes('age')) return `${site}: видео с возрастным ограничением, скачать нельзя.`;
  if (c.includes('private')) return 'Видео приватное или недоступно.';
  if (c.includes('region')) return 'Видео недоступно в регионе сервера.';
  if (c.includes('login') || c.includes('cookie')) return `${site} требует вход — скачать с этого сервера не получится.`;
  if (c.includes('unavailable') || c.includes('empty')) return 'Видео недоступно (удалено или закрыто).';
  if (c.includes('fetch')) return `${site} не ответил cobalt. Попробуйте позже.`;
  return `Не удалось скачать (${escapeHtml(c) || 'неизвестная ошибка'}).`;
}

// Разбирает ответ cobalt в один из видов:
//   { type: 'file', url, filename }
//   { type: 'picker', items: [{ type: 'photo' | 'video' | 'gif', url }], audio }
export function parseCobaltResponse(data, url) {
  switch (data?.status) {
    case 'tunnel':
    case 'redirect':
    case 'stream': // старое название
      if (!data.url) throw new DownloadError('cobalt не вернул ссылку на файл.');
      return { type: 'file', url: data.url, filename: data.filename || null };
    case 'picker':
      return {
        type: 'picker',
        items: (data.picker || []).filter((p) => p?.url).map((p) => ({ type: p.type || 'photo', url: p.url })),
        audio: data.audio || null,
      };
    case 'local-processing':
      throw new DownloadError('cobalt просит обработать файл на устройстве — этот сервер так не умеет. Укажите другой cobalt_url.');
    case 'error':
      throw new DownloadError(humanizeCobaltError(data.error?.code || data.text, url));
    default:
      throw new DownloadError('cobalt вернул непонятный ответ.');
  }
}

// mode: 'auto' (видео или карусель) | 'audio'
export async function cobaltRequest(cfg, url, { mode = 'auto', quality = '720', bitrate = '128' } = {}) {
  if (!cobaltConfigured(cfg)) {
    throw new DownloadError(
      `Для ${escapeHtml(siteName(url))} нужен сервер cobalt. Владелец бота может указать его командой `
      + '<code>/set cobalt_url https://…</code> (см. README).',
    );
  }
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (cfg.cobaltKey) headers.Authorization = `Api-Key ${cfg.cobaltKey}`;
  const body = {
    url,
    downloadMode: mode,
    videoQuality: quality,
    audioFormat: 'mp3',
    audioBitrate: bitrate,
    youtubeVideoCodec: 'h264', // h264 + aac лучше всего играет прямо в Telegram
    filenameStyle: 'basic',
  };

  let data;
  try {
    const res = await fetch(cfg.cobaltUrl + '/', { method: 'POST', headers, body: JSON.stringify(body) });
    data = await res.json();
  } catch (e) {
    console.warn('cobalt недоступен', e);
    throw new DownloadError('Сервер cobalt недоступен. Попробуйте позже.');
  }
  return parseCobaltResponse(data, url);
}

// «Название (720p, h264).mp4» → «Название»
export function titleFromFilename(filename) {
  if (!filename) return null;
  const base = filename.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/\s*\([^()]*\)\s*$/, '').trim();
  return base || null;
}
