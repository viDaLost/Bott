// Скачивание и отправка. Всё работает внутри Serverless: TikTok — через TikWM,
// YouTube — через API плеера, Instagram — через GraphQL сайта, X — через FxTwitter.
// Если владелец подключил свой cobalt, он используется первым (выше качество).
// Готовый файл уходит в Telegram из памяти, а его file_id запоминается,
// чтобы повторные запросы отправлялись мгновенно.
import { api, InputFile } from 'sdk';
import { AUDIO_BITRATES, MAX_DURATION, VIDEO_QUALITIES } from './config.js';
import { Cancelled, DownloadError, TooLarge } from './job.js';
import {
  instagramShortcode, isTikTok, siteName, sourceIds, tweetId, youtubeId,
} from './links.js';
import { forgetFile, getFile, saveFile } from './storage.js';
import { escapeHtml, safeFilename, short } from './text.js';
import { download, downloadRanged, FILE_LIMIT, isJpegOrPng } from './transfer.js';
import { cobaltConfigured, cobaltRequest, titleFromFilename } from './sources/cobalt.js';
import { fetchPost, MAX_PHOTOS, postSource, videoCandidates } from './sources/tikwm.js';
import { fetchInstagram } from './sources/instagram.js';
import { fetchTweet } from './sources/twitter.js';
import { youtubePlayer, YoutubeBlocked } from './sources/youtube.js';

const PHOTO_LIMIT = 10 * 1024 * 1024; // Bot API: фото до 10 МБ
const DOC_PREFIX = 'doc:'; // file_id документа (а не видео/аудио) в кэше

function caption(title) {
  return title ? escapeHtml(short(title, 1000)) : undefined;
}

function cleanChannel(name) {
  return name ? name.replace(/\s+-\s+Topic$/i, '').trim() : null;
}

function extOf(file, fallback) {
  const fromName = /\.([a-z0-9]{2,4})$/i.exec(file.filename || '');
  if (fromName) return '.' + fromName[1].toLowerCase();
  const byType = {
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/ogg': '.ogg', 'audio/opus': '.opus',
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  };
  return byType[file.contentType] || fallback;
}

function isImage(file) {
  return (file.contentType || '').startsWith('image/') || /\.(jpe?g|png|webp)$/i.test(file.filename || '');
}

// ------------------------------------------------------------------ кэш file_id

export async function sendCached(chatId, kind, sources) {
  const hit = await getFile(sources, kind);
  if (!hit) return false;
  const asDoc = hit.fileId.startsWith(DOC_PREFIX);
  const fileId = asDoc ? hit.fileId.slice(DOC_PREFIX.length) : hit.fileId;
  try {
    if (asDoc) {
      await api.sendDocument({ chat_id: chatId, document: fileId, caption: caption(hit.title), parse_mode: 'HTML' });
    } else if (kind === 'v') {
      await api.sendVideo({
        chat_id: chatId, video: fileId, caption: caption(hit.title), parse_mode: 'HTML', supports_streaming: true,
      });
    } else {
      await api.sendAudio({ chat_id: chatId, audio: fileId });
    }
  } catch (e) {
    if (e?.code !== 400) throw e;
    // например, бот пересоздан с другим токеном — file_id больше не действует
    console.warn('file_id из кэша не подошёл, скачиваю заново', e.description);
    await forgetFile(hit.fileId);
    return false;
  }
  await saveFile(sources, kind, hit.fileId, hit.title); // запоминаем и новые варианты ссылки
  return true;
}

// ------------------------------------------------------------------ отправка

async function sendFile(job, kind, file, meta, sources) {
  job.check();
  job.setPhase('uploading');
  await job.tick(true);
  const chatId = job.chatId;
  const title = meta.title || titleFromFilename(file.filename) || (kind === 'a' ? 'audio' : 'video');

  if (isImage(file)) {
    // одиночная фотография (например, пост Instagram без видео) — в кэш не кладём
    if (file.bytes.length <= PHOTO_LIMIT && isJpegOrPng(file.bytes)) {
      await api.sendPhoto({
        chat_id: chatId,
        photo: new InputFile(file.bytes, safeFilename(title, extOf(file, '.jpg')), { type: file.contentType || 'image/jpeg' }),
        caption: caption(meta.title),
        parse_mode: 'HTML',
      });
    } else {
      await api.sendDocument({
        chat_id: chatId,
        document: new InputFile(file.bytes, safeFilename(title, extOf(file, '.jpg'))),
        caption: caption(meta.title),
        parse_mode: 'HTML',
      });
    }
    return;
  }

  let msg;
  let fileId = null;
  if (kind === 'a') {
    const ext = extOf(file, '.mp3');
    msg = await api.sendAudio({
      chat_id: chatId,
      audio: new InputFile(file.bytes, safeFilename(title, ext), { type: file.contentType || 'audio/mpeg' }),
      title: short(title, 64),
      performer: short(meta.performer, 64) || undefined,
      duration: meta.duration || undefined,
    });
    if (msg.audio) fileId = msg.audio.file_id;
    else if (msg.document) fileId = DOC_PREFIX + msg.document.file_id;
  } else {
    const ext = extOf(file, '.mp4');
    const input = new InputFile(file.bytes, safeFilename(title, ext), { type: file.contentType || 'video/mp4' });
    try {
      msg = await api.sendVideo({
        chat_id: chatId,
        video: input,
        caption: caption(meta.title || title),
        parse_mode: 'HTML',
        duration: meta.duration || undefined,
        supports_streaming: true,
      });
    } catch (e) {
      if (e?.code !== 400) throw e;
      // формат, который Telegram не принял как видео, — отправляем файлом
      msg = await api.sendDocument({
        chat_id: chatId,
        document: new InputFile(file.bytes, safeFilename(title, ext)),
        caption: caption(meta.title || title),
        parse_mode: 'HTML',
      });
    }
    if (msg.video) fileId = msg.video.file_id;
    else if (msg.animation) fileId = DOC_PREFIX + msg.animation.file_id;
    else if (msg.document) fileId = DOC_PREFIX + msg.document.file_id;
  }
  if (fileId) await saveFile(sources, kind, fileId, meta.title || title);
}

// Карусель фото/видео: альбомами по 10, скачивая каждую пачку перед отправкой,
// чтобы в памяти не лежало всё сразу.
async function sendGallery(job, items, title) {
  items = items.slice(0, MAX_PHOTOS);
  job.setPhase('downloading');
  job.unit = 'photos';
  job.downloaded = 0;
  job.total = items.length;
  await job.tick(true);

  let first = true;
  for (let start = 0; start < items.length; start += 10) {
    const batch = [];
    let batchBytes = 0;
    for (const item of items.slice(start, start + 10)) {
      const isVideo = item.type === 'video' || item.type === 'gif';
      let file;
      try {
        file = await download(item.url, { job, track: false, limit: isVideo ? FILE_LIMIT : PHOTO_LIMIT });
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        console.warn('Не удалось скачать элемент карусели', e?.message);
        job.downloaded += 1;
        continue;
      }
      job.downloaded += 1;
      if (batchBytes + file.bytes.length > FILE_LIMIT) break; // остальное не влезет в один запрос
      batchBytes += file.bytes.length;
      batch.push({ isVideo, file });
    }
    if (!batch.length) continue;

    job.check();
    job.setPhase('uploading');
    await job.tick(true);
    await sendBatch(job.chatId, batch, first ? title : null);
    first = false;
    job.setPhase('downloading');
  }
  if (first) throw new DownloadError('Не удалось скачать ни одного фото из этого поста.');
}

async function sendBatch(chatId, batch, title) {
  const media = (asDocs) => batch.map(({ isVideo, file }, i) => {
    const name = `${isVideo ? 'video' : 'photo'}_${i + 1}${extOf(file, isVideo ? '.mp4' : '.jpg')}`;
    const entry = {
      type: asDocs ? 'document' : isVideo ? 'video' : 'photo',
      media: new InputFile(file.bytes, name, file.contentType ? { type: file.contentType } : undefined),
    };
    if (i === 0 && title) {
      entry.caption = caption(title);
      entry.parse_mode = 'HTML';
    }
    return entry;
  });

  if (batch.length === 1) {
    const [{ isVideo, file }] = batch;
    const m = media(false)[0];
    try {
      if (isVideo) await api.sendVideo({ chat_id: chatId, video: m.media, caption: m.caption, parse_mode: 'HTML', supports_streaming: true });
      else await api.sendPhoto({ chat_id: chatId, photo: m.media, caption: m.caption, parse_mode: 'HTML' });
    } catch (e) {
      if (e?.code !== 400) throw e;
      await api.sendDocument({ chat_id: chatId, document: new InputFile(file.bytes, isVideo ? 'video.mp4' : 'photo.jpg'), caption: m.caption, parse_mode: 'HTML' });
    }
    return;
  }
  try {
    await api.sendMediaGroup({ chat_id: chatId, media: media(false) });
  } catch (e) {
    if (e?.code !== 400) throw e;
    // например, webp, который Telegram не принимает как фото, — отправляем файлами
    await api.sendMediaGroup({ chat_id: chatId, media: media(true) });
  }
}

// ------------------------------------------------------------------ TikTok

async function viaTikwm(job, kind, target, sources) {
  job.setPhase('probing');
  await job.tick(true);
  const post = await fetchPost(target.url);
  job.check();
  const all = [...sources, postSource(post)];

  if (post.images.length && kind === 'v') {
    const title = post.title !== 'TikTok' ? post.title : null;
    await sendGallery(job, post.images.map((url) => ({ type: 'photo', url })), title);
    return;
  }
  if (await sendCached(job.chatId, kind, all)) return;

  job.setPhase('starting');
  if (kind === 'v') {
    let file = null;
    let lastError = null;
    for (const url of videoCandidates(post, FILE_LIMIT)) {
      try {
        file = await download(url, { job });
        break;
      } catch (e) {
        if (!(e instanceof TooLarge)) throw e;
        lastError = e;
      }
    }
    if (!file) throw lastError;
    await sendFile(job, 'v', file, { title: post.title, duration: post.duration }, all);
    return;
  }

  if (!post.music) throw new DownloadError('В этом посте нет звука.');
  const file = await download(post.music, { job });
  await sendFile(job, 'a', file, {
    title: post.musicTitle || post.title,
    performer: post.musicAuthor || post.author,
    duration: null, // длительность ролика не равна длительности звука
  }, all);
}

// ------------------------------------------------------------------ cobalt

async function viaCobalt(job, cfg, kind, target, sources, meta) {
  const ladder = kind === 'a' ? AUDIO_BITRATES : VIDEO_QUALITIES;
  let lastError = null;
  for (let i = 0; i < ladder.length; i++) {
    job.setPhase('probing');
    job.note = i > 0 ? (kind === 'a' ? `не влезло, пробую ${ladder[i]} кбит/с` : `не влезло, пробую ${ladder[i]}p`) : '';
    await job.tick(true);
    const res = await cobaltRequest(cfg, target.url, kind === 'a'
      ? { mode: 'audio', bitrate: ladder[i] }
      : { mode: 'auto', quality: ladder[i] });
    job.check();

    let url;
    if (res.type === 'picker') {
      if (kind === 'v') {
        await sendGallery(job, res.items, meta.title);
        return;
      }
      if (!res.audio) throw new DownloadError('В этом посте нет звука.');
      url = res.audio;
    } else {
      url = res.url;
    }

    job.setPhase('starting');
    try {
      const file = await download(url, { job });
      // имя файла есть и в ответе cobalt, и (не всегда) в заголовке скачивания
      file.filename = file.filename || (res.type === 'file' ? res.filename : null);
      if (!meta.title) meta.title = titleFromFilename(file.filename);
      await sendFile(job, kind, file, meta, sources);
      return;
    } catch (e) {
      if (!(e instanceof TooLarge)) throw e;
      lastError = e;
    }
  }
  console.warn('Не влезло ни в одном качестве', lastError?.message);
  throw new DownloadError(
    kind === 'a'
      ? 'Аудио не влезает в лимит Telegram даже в минимальном качестве.'
      : 'Видео не влезает в лимит Telegram даже в минимальном качестве.',
  );
}

// ------------------------------------------------------------------ YouTube, Instagram, X без cobalt

function resetJob(job) {
  job.part = 0;
  job.unit = 'bytes';
  job.note = '';
}

async function viaYoutube(job, kind, id, sources, meta) {
  job.setPhase('probing');
  await job.tick(true);
  let info;
  try {
    info = await youtubePlayer(id);
  } catch (e) {
    throw new DownloadError(e instanceof YoutubeBlocked ? e.message : 'YouTube сейчас недоступен. Попробуйте позже.');
  }
  job.check();
  if (info.live) throw new DownloadError('Трансляции скачать нельзя.');
  if (MAX_DURATION && info.duration && info.duration > MAX_DURATION) throw new DownloadError('Запись слишком длинная.');
  meta.title = meta.title || info.title;
  meta.performer = meta.performer || cleanChannel(info.author);
  meta.duration = meta.duration || info.duration;

  const formats = (kind === 'a' ? info.audios : info.videos)
    .filter((f) => !f.size || f.size <= FILE_LIMIT * (f.exact ? 1 : 1.05));
  if (!formats.length) {
    const any = kind === 'a' ? info.audios.length : info.videos.length;
    throw any
      ? new DownloadError(`${kind === 'a' ? 'Аудио' : 'Видео'} больше лимита Telegram (${Math.round(FILE_LIMIT / 2 ** 20)} МБ).`)
      : new DownloadError(kind === 'a' ? 'YouTube не отдал звук для этого видео.' : 'YouTube не отдал видео со звуком — попробуйте «Аудио MP3».');
  }

  job.setPhase('starting');
  for (const f of formats) {
    let file;
    try {
      file = await downloadRanged(f.url, f.exact ? f.size : null, { job, headers: { 'User-Agent': info.userAgent } });
    } catch (e) {
      if (e instanceof TooLarge) continue;
      throw e;
    }
    file.contentType = f.mime;
    file.filename = kind === 'a' ? 'audio.m4a' : 'video.mp4';
    await sendFile(job, kind, file, meta, sources);
    return;
  }
  throw new DownloadError(`${kind === 'a' ? 'Аудио' : 'Видео'} больше лимита Telegram (${Math.round(FILE_LIMIT / 2 ** 20)} МБ).`);
}

// Пост с одним видео — отправляется как видео и кэшируется; несколько файлов — альбомом.
async function viaPost(job, kind, fetchPostFn, url, sources) {
  job.setPhase('probing');
  await job.tick(true);
  const post = await fetchPostFn(url);
  job.check();
  const all = [...sources, post.source];
  const single = post.items.length === 1 ? post.items[0] : null;

  if (kind === 'a') {
    throw new DownloadError('Отсюда можно скачать только видео и фото: отдельно звук без ffmpeg не извлечь. '
      + 'Чтобы найти песню, напишите её название.');
  }
  if (!single || single.type === 'photo') {
    await sendGallery(job, post.items, post.title);
    return;
  }
  if (await sendCached(job.chatId, 'v', all)) return;
  job.setPhase('starting');
  const file = await download(single.url, { job });
  await sendFile(job, 'v', file, { title: post.title }, all);
}

// ------------------------------------------------------------------ точка входа

// Сайты, которые бот умеет скачивать сам, без cobalt.
export function builtinSite(url) {
  if (isTikTok(url)) return 'tiktok';
  if (youtubeId(url)) return 'youtube';
  if (instagramShortcode(url) || /instagram\.com\/share\//i.test(url)) return 'instagram';
  if (tweetId(url)) return 'x';
  return null;
}

// target — { url, title, channel, duration } (поиск уже разрешён в ссылку).
// Кэш по ссылке проверяет вызывающий код (до показа статуса), здесь — по id поста.
export async function fetchAndSend(job, cfg, kind, target) {
  if (MAX_DURATION && target.duration && target.duration > MAX_DURATION) {
    throw new DownloadError('Запись слишком длинная.');
  }
  const sources = sourceIds(target.url);
  const site = builtinSite(target.url);
  const meta = { title: target.title, performer: cleanChannel(target.channel), duration: target.duration };

  if (site === 'tiktok') {
    try {
      await viaTikwm(job, kind, target, sources);
      return;
    } catch (e) {
      if (e instanceof Cancelled || e instanceof TooLarge || !cobaltConfigured(cfg)) throw e;
      console.warn('TikWM не справился, пробую cobalt', e?.message);
      resetJob(job);
      await viaCobalt(job, cfg, kind, target, sources, meta);
      return;
    }
  }

  // Если владелец подключил свой cobalt — сначала он (качество выше), встроенное — запасной путь.
  if (cobaltConfigured(cfg)) {
    try {
      await viaCobalt(job, cfg, kind, target, sources, { ...meta });
      return;
    } catch (e) {
      if (e instanceof Cancelled || !site) throw e;
      console.warn('cobalt не справился, пробую встроенный способ', e?.message);
      resetJob(job);
    }
  }

  if (site === 'youtube') return viaYoutube(job, kind, youtubeId(target.url), sources, meta);
  if (site === 'instagram') return viaPost(job, kind, fetchInstagram, target.url, sources);
  if (site === 'x') return viaPost(job, kind, fetchTweet, target.url, sources);
  throw new DownloadError(`${escapeHtml(siteName(target.url))} пока не поддерживается. Бот умеет скачивать из TikTok, YouTube, Instagram и X.`);
}
