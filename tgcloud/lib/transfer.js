// Скачивание файла в память с прогрессом, лимитом размера и отменой.
// Файловой системы в Serverless нет: файл собирается в Uint8Array и сразу
// отправляется в Telegram через InputFile.
import { fetch } from 'sdk';
import { DownloadError, TooLarge } from './job.js';
import { MAX_FILE_MB } from './config.js';

export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0 Safari/537.36';

export const FILE_LIMIT = MAX_FILE_MB * 1024 * 1024;

function toBytes(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  return new Uint8Array(chunk);
}

function filenameFrom(disposition) {
  if (!disposition) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // ниже — обычный filename
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1].trim() : null;
}

// Возвращает { bytes, contentType, filename }.
// job — для прогресса и отмены (может быть null), track — показывать ли прогресс
// этого файла (для обложек и фото из карусели — нет).
export async function download(url, { job = null, limit = FILE_LIMIT, headers = {}, track = true } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers } });
  } catch (e) {
    throw new DownloadError('Не удалось подключиться к серверу с файлом. Попробуйте позже.');
  }
  if (!res.ok) {
    throw new DownloadError(`Сервер с файлом ответил ошибкой (HTTP ${res.status}).`);
  }

  const declared = Number(res.headers.get('content-length')) || null;
  // cobalt при склейке видео заранее знает только примерный размер
  const estimated = Number(res.headers.get('estimated-content-length')) || null;
  if (declared && declared > limit) throw new TooLarge(`Файл больше ${Math.round(limit / 2 ** 20)} МБ.`);

  if (job && track) {
    job.phase = 'downloading';
    job.part += 1;
    job.downloaded = 0;
    job.total = declared || estimated;
    job.speed = null;
    await job.tick(true);
  }

  // Если размер известен — пишем сразу в один буфер, без лишней копии в памяти.
  let buffer = declared ? new Uint8Array(declared) : null;
  const chunks = [];
  let done = 0;
  const started = Date.now();

  for await (const raw of res.body) {
    const chunk = toBytes(raw);
    if (done + chunk.length > limit) {
      throw new TooLarge(`Файл больше ${Math.round(limit / 2 ** 20)} МБ.`);
    }
    if (buffer && done + chunk.length <= buffer.length) {
      buffer.set(chunk, done);
    } else {
      if (buffer) {
        // сервер прислал больше, чем объявил, — переходим на список кусков
        chunks.push(buffer.subarray(0, done));
        buffer = null;
      }
      chunks.push(chunk);
    }
    done += chunk.length;
    if (job) {
      if (track) {
        job.downloaded = done;
        job.speed = done / Math.max((Date.now() - started) / 1000, 0.001);
      }
      await job.tick();
    }
  }

  let bytes;
  if (buffer) {
    bytes = done === buffer.length ? buffer : buffer.subarray(0, done);
  } else {
    bytes = new Uint8Array(done);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
  }
  if (!bytes.length) throw new DownloadError('Сервер прислал пустой файл.');

  return {
    bytes,
    contentType: (res.headers.get('content-type') || '').split(';')[0].trim() || null,
    filename: filenameFrom(res.headers.get('content-disposition')),
  };
}

export function isJpegOrPng(bytes) {
  return (bytes[0] === 0xff && bytes[1] === 0xd8)
    || (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47);
}
