// Логика бота: команды, ссылки, поиск, распознавание и кнопки.
// handlers/message.js и handlers/callback_query.js только передают сюда апдейты.
import { api } from 'sdk';
import { MAX_ACTIVE_PER_USER, MAX_FILE_MB } from './config.js';
import { fetchAndSend, sendCached } from './download.js';
import { Cancelled, DownloadError, Job } from './job.js';
import { findUrl, sourceIds, youtubeUrl } from './links.js';
import { geniusSearch, recognize } from './music.js';
import { firstResult, newSearch, renderPage } from './search.js';
import {
  isAllowed, isOwner, resetSettingsCache, SETTING_KEYS, settings,
} from './settings.js';
import {
  activeJobs, allowedUserIds, allowUser, claimUpdate, deleteSetting, denyUser, get, getJob,
  maybePrune, put, putMany, setJobState, setSetting, startJob, stats,
} from './storage.js';
import { decodeTarget, encodeTarget } from './targets.js';
import { cobaltConfigured } from './sources/cobalt.js';
import { escapeHtml, kb, short } from './text.js';

const RECOGNIZE_LIMIT = 20 * 1024 * 1024; // getFile отдаёт файлы до 20 МБ

// ------------------------------------------------------------------ утилиты

async function reply(message, text, extra = {}) {
  return api.sendMessage({
    chat_id: message.chat.id,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    ...extra,
  });
}

async function edit(msg, text, extra = {}) {
  try {
    await api.editMessageText({
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  } catch (e) {
    if (e?.code !== 400) throw e; // 400 — текст не изменился или сообщение удалено
  }
}

let botUsername = null;

async function myUsername() {
  if (!botUsername) botUsername = (await api.getMe()).username?.toLowerCase() || '';
  return botUsername;
}

// «/music@MyBot запрос» → { name: 'music', args: 'запрос' }; null — не команда или не нам.
async function parseCommand(text) {
  const m = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text || '');
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== await myUsername()) return null;
  return { name: m[1].toLowerCase(), args: (m[3] || '').trim() };
}

// ------------------------------------------------------------------ справка

async function helpText(userId) {
  const cfg = await settings();
  const lines = [
    '👋 <b>Привет! Я умею:</b>',
    '',
    '🎬 <b>Скачивать видео</b> — пришлите ссылку на TikTok'
      + (cobaltConfigured(cfg) ? ', YouTube, Instagram, VK и многие другие сайты' : '')
      + ', затем выберите «Видео» или «Аудио MP3».',
    '',
    '🎵 <b>Искать музыку по названию</b> — просто напишите название песни '
      + 'или используйте <code>/music название</code>.',
  ];
  if (cfg.geniusToken) {
    lines.push('', '📝 <b>Искать по строчке из песни</b> — <code>/lyrics фрагмент текста</code>.');
  }
  if (cfg.auddToken) {
    lines.push('', '🎧 <b>Распознавать музыку</b> — пришлите голосовое, кружок или аудио с песней.');
  }
  lines.push('', `Лимит файла: ${MAX_FILE_MB} МБ.`);
  if (isOwner(userId)) {
    lines.push('', '🔧 <b>Владельцу:</b> /settings, /set, /unset, /allow, /deny, /users, /stats, /setup');
  }
  return lines.join('\n');
}

const COMMANDS = [
  { command: 'music', description: 'Найти песню по названию' },
  { command: 'lyrics', description: 'Найти песню по строчке из текста' },
  { command: 'help', description: 'Что умеет бот' },
  { command: 'id', description: 'Показать мой Telegram ID' },
];

// ------------------------------------------------------------------ сообщения

export async function handleMessage(message, ctx) {
  if (!(await claimUpdate(ctx?.update?.update_id))) return; // повторная доставка
  await maybePrune();

  const user = message.from;
  if (!user || user.is_bot) return;
  const isPrivate = message.chat.type === 'private';
  const text = message.text ?? '';
  const cmd = text.startsWith('/') ? await parseCommand(text) : null;

  // /id работает даже без доступа — чтобы было что передать владельцу
  if (cmd?.name === 'id') {
    await reply(message, `Ваш Telegram ID: <code>${user.id}</code>`
      + (isPrivate ? '' : `\nID чата: <code>${message.chat.id}</code>`));
    return;
  }

  if (!(await isAllowed(user.id))) {
    if (isPrivate) await reply(message, `⛔ Доступ закрыт. Ваш ID: <code>${user.id}</code>`);
    return;
  }

  if (cmd) {
    await handleCommand(message, cmd);
    return;
  }
  if (text.startsWith('/')) return; // команда другому боту

  const url = findUrl(text || message.caption);
  if (url) {
    await onLink(message, url);
    return;
  }

  // В группах реагируем только на команды и ссылки, иначе бот отвечал бы на всё подряд.
  if (!isPrivate) return;

  if (message.voice || message.audio || message.video_note) {
    await onVoice(message);
    return;
  }
  if (text.trim()) await doSearch(message, text.trim());
}

async function handleCommand(message, { name, args }) {
  const userId = message.from.id;
  switch (name) {
    case 'start':
    case 'help':
      await reply(message, await helpText(userId));
      return;
    case 'music':
      if (!args) {
        await reply(message, 'Напишите так: <code>/music исполнитель название</code>');
        return;
      }
      await doSearch(message, args);
      return;
    case 'lyrics':
      await onLyrics(message, args);
      return;
    default:
      if (isOwner(userId)) await handleOwnerCommand(message, name, args);
  }
}

async function onLink(message, url) {
  const key = await put(url);
  await reply(message, 'Что скачать?', {
    reply_markup: kb([[['🎬 Видео', `v:${key}`], ['🎵 Аудио MP3', `a:${key}`]]]),
  });
}

async function doSearch(message, query) {
  const status = await reply(message, `🔎 Ищу: <i>${escapeHtml(short(query, 100))}</i>`);
  let page;
  try {
    const cfg = await settings();
    const sid = await newSearch(cfg, query);
    page = await renderPage(cfg, sid, 0);
  } catch (e) {
    console.error('Поиск не удался', e);
    await edit(status, 'Не удалось выполнить поиск, попробуйте позже.');
    return;
  }
  if (!page || page === 'expired') {
    await edit(status, 'Ничего не найдено 😕');
    return;
  }
  await edit(status, page.text, { reply_markup: page.markup });
}

async function onLyrics(message, args) {
  const cfg = await settings();
  if (!cfg.geniusToken) {
    await reply(message, 'Поиск по тексту не настроен: владелец бота может задать '
      + '<code>/set genius_token …</code> (токен — на genius.com/api-clients).');
    return;
  }
  if (!args) {
    await reply(message, 'Напишите так: <code>/lyrics строчка из песни</code>');
    return;
  }
  const status = await reply(message, '🔎 Ищу песню по фрагменту текста…');
  let hits;
  try {
    hits = await geniusSearch(cfg.geniusToken, args);
  } catch (e) {
    console.error('Genius search failed', e);
    await edit(status, 'Не удалось выполнить поиск, попробуйте позже.');
    return;
  }
  if (!hits.length) {
    await edit(status, 'Ничего не нашёл 😕 Попробуйте другой фрагмент.');
    return;
  }
  const queries = hits.map((h) => `${h.artist} - ${h.title}`);
  const keys = await putMany(queries.map((q) => encodeTarget({ query: q })));
  await edit(status, 'Возможно, это одна из этих песен 👇', {
    reply_markup: kb(queries.map((q, i) => [[short(q, 60), `a:${keys[i]}`]])),
  });
}

async function onVoice(message) {
  const cfg = await settings();
  if (!cfg.auddToken) {
    await reply(message, 'Распознавание музыки не настроено: владелец бота может задать '
      + '<code>/set audd_token …</code> (токен — на audd.io).');
    return;
  }
  const media = message.voice || message.audio || message.video_note;
  if (media.file_size && media.file_size > RECOGNIZE_LIMIT) {
    await reply(message, 'Файл слишком большой для распознавания (максимум 20 МБ).');
    return;
  }

  const status = await reply(message, '🎧 Слушаю…');
  let track = null;
  try {
    const bytes = await api.getFileContent(media.file_id);
    const name = message.voice ? 'voice.ogg' : message.video_note ? 'note.mp4' : (media.file_name || 'audio.mp3');
    track = await recognize(cfg.auddToken, bytes, name);
  } catch (e) {
    console.error('Распознавание не удалось', e);
  }
  if (!track?.title) {
    await edit(status, 'Не удалось распознать трек 😕');
    return;
  }
  const query = `${track.artist} - ${track.title}`.replace(/^\s*-\s*|\s*-\s*$/g, '');
  const key = await put(encodeTarget({ query }));
  await edit(status, `Похоже, это <b>${escapeHtml(query)}</b>`, {
    reply_markup: kb([[['⬇️ Скачать MP3', `a:${key}`]]]),
  });
}

// ------------------------------------------------------------------ команды владельца

async function handleOwnerCommand(message, name, args) {
  switch (name) {
    case 'settings': {
      const cfg = await settings();
      const values = {
        cobalt_url: cfg.cobaltUrl, cobalt_key: cfg.cobaltKey, genius_token: cfg.geniusToken,
        audd_token: cfg.auddToken, youtube_key: cfg.youtubeKey,
      };
      const lines = ['<b>Настройки</b> (<code>/set ключ значение</code>, <code>/unset ключ</code>):', ''];
      for (const [key, { secret, about }] of Object.entries(SETTING_KEYS)) {
        const v = values[key];
        const shown = !v ? '—' : secret ? '✅ задан' : `<code>${escapeHtml(v)}</code>`;
        lines.push(`<code>${key}</code>: ${shown}\n<i>${escapeHtml(about)}</i>`);
      }
      await reply(message, lines.join('\n'));
      return;
    }
    case 'set': {
      const m = /^(\S+)\s+(\S[\s\S]*)$/.exec(args);
      const key = m?.[1]?.toLowerCase();
      if (!m || !SETTING_KEYS[key]) {
        await reply(message, 'Напишите так: <code>/set ключ значение</code>. Ключи: '
          + Object.keys(SETTING_KEYS).map((k) => `<code>${k}</code>`).join(', '));
        return;
      }
      const value = m[2].trim();
      if (key === 'cobalt_url' && !/^https?:\/\/\S+$/.test(value)) {
        await reply(message, 'cobalt_url должен начинаться с https://');
        return;
      }
      await setSetting(key, value);
      resetSettingsCache();
      if (SETTING_KEYS[key].secret) {
        // не оставляем токен в переписке
        try {
          await api.deleteMessage({ chat_id: message.chat.id, message_id: message.message_id });
        } catch {
          // в группе без прав администратора удалить нельзя — не страшно
        }
        await api.sendMessage({ chat_id: message.chat.id, text: `✅ <code>${key}</code> сохранён, сообщение с ним удалено.`, parse_mode: 'HTML' });
      } else {
        await reply(message, `✅ <code>${key}</code> = <code>${escapeHtml(value)}</code>`);
      }
      return;
    }
    case 'unset': {
      const key = args.toLowerCase();
      if (!SETTING_KEYS[key]) {
        await reply(message, 'Напишите так: <code>/unset ключ</code>');
        return;
      }
      await deleteSetting(key);
      resetSettingsCache();
      await reply(message, `✅ <code>${key}</code> удалён.`);
      return;
    }
    case 'allow':
    case 'deny': {
      const id = Number(args) || message.reply_to_message?.from?.id;
      if (!id) {
        await reply(message, `Напишите так: <code>/${name} 123456789</code> или ответьте командой на сообщение пользователя.`);
        return;
      }
      if (name === 'allow') await allowUser(id);
      else await denyUser(id);
      await reply(message, name === 'allow'
        ? `✅ Доступ открыт: <code>${id}</code>`
        : `🚫 Доступ закрыт: <code>${id}</code>`);
      return;
    }
    case 'users': {
      const ids = await allowedUserIds();
      await reply(message, ids.length
        ? '<b>Доступ открыт:</b>\n' + ids.map((id) => `<code>${id}</code>`).join('\n')
        : 'Список пуст — если ALLOWED_USERS в lib/config.js тоже пуст, бот доступен всем.');
      return;
    }
    case 'stats': {
      const s = await stats();
      await reply(message, [
        '<b>Статистика</b>',
        `Загрузок за сутки: ${s.jobsDay}`,
        `Идёт сейчас: ${s.activeJobs}`,
        `Файлов в кэше: ${s.files}`,
        `Пользователей с доступом: ${s.allowed}`,
      ].join('\n'));
      return;
    }
    case 'setup':
      await api.setMyCommands({ commands: COMMANDS });
      await reply(message, '✅ Меню команд обновлено.');
      return;
    default:
  }
}

// ------------------------------------------------------------------ кнопки

export async function handleCallback(call, ctx) {
  if (!(await claimUpdate(ctx?.update?.update_id))) return;
  const data = call.data || '';

  if (!(await isAllowed(call.from.id))) {
    await api.answerCallbackQuery({ callback_query_id: call.id, text: '⛔ Доступ закрыт', show_alert: true });
    return;
  }

  if (data === 'noop') {
    await api.answerCallbackQuery({ callback_query_id: call.id });
    return;
  }
  let m;
  if ((m = /^p:([0-9a-f]+):(\d+)$/.exec(data))) {
    await onPage(call, m[1], Number(m[2]));
  } else if ((m = /^([va]):([0-9a-f]+)$/.exec(data))) {
    await onDownload(call, m[1], m[2]);
  } else if (data.startsWith('c:')) {
    await onCancel(call, data.slice(2));
  } else {
    await api.answerCallbackQuery({ callback_query_id: call.id, text: 'Кнопка устарела.' });
  }
}

async function onPage(call, sid, page) {
  let result;
  try {
    result = await renderPage(await settings(), sid, page);
  } catch (e) {
    console.error('Страница поиска не загрузилась', e);
    await api.answerCallbackQuery({ callback_query_id: call.id, text: 'Не удалось загрузить страницу, попробуйте позже.', show_alert: true });
    return;
  }
  if (result === 'expired') {
    await api.answerCallbackQuery({ callback_query_id: call.id, text: 'Поиск устарел — отправьте запрос заново.', show_alert: true });
    return;
  }
  if (!result) {
    await api.answerCallbackQuery({ callback_query_id: call.id, text: 'Больше ничего не нашлось.' });
    return;
  }
  await api.answerCallbackQuery({ callback_query_id: call.id });
  if (call.message) await edit(call.message, result.text, { reply_markup: result.markup });
}

async function onDownload(call, kind, key) {
  const target = decodeTarget(await get(key));
  if (!target || (!target.url && !target.query)) {
    await api.answerCallbackQuery({ callback_query_id: call.id, text: 'Кнопка устарела — отправьте ссылку или запрос заново.', show_alert: true });
    return;
  }
  await api.answerCallbackQuery({ callback_query_id: call.id });

  const chatId = call.message?.chat?.id ?? call.from.id;
  const userId = call.from.id;
  const cfg = await settings();

  // Запрос после /lyrics или распознавания: сначала находим трек на YouTube.
  if (!target.url) {
    let found = null;
    try {
      found = await firstResult(cfg, target.query);
    } catch (e) {
      console.error('Поиск трека не удался', e);
    }
    if (!found) {
      await api.sendMessage({ chat_id: chatId, text: 'Не нашёл этот трек на YouTube 😕' });
      return;
    }
    Object.assign(target, { url: youtubeUrl(found.id), title: found.title, channel: found.channel, duration: found.duration });
  }

  if (await sendCached(chatId, kind, sourceIds(target.url))) return;

  if (await activeJobs(userId) >= MAX_ACTIVE_PER_USER) {
    await api.sendMessage({ chat_id: chatId, text: '⏳ У вас уже идут загрузки — дождитесь, пока они закончатся.' });
    return;
  }
  if (!(await startJob(call.id, userId, chatId))) return; // это нажатие уже обрабатывается

  const job = new Job({ id: call.id, chatId, kind });
  const status = await api.sendMessage({
    chat_id: chatId, text: job.render(), parse_mode: 'HTML', reply_markup: job.keyboard(),
  });
  job.statusMessageId = status.message_id;
  job.lastText = job.render();

  let outcome = null;
  try {
    await fetchAndSend(job, cfg, kind, target);
  } catch (e) {
    if (e instanceof Cancelled) {
      outcome = '🚫 Загрузка отменена.';
    } else if (e instanceof DownloadError) {
      outcome = '❌ ' + e.message;
    } else {
      console.error('Загрузка не удалась', target.url, e);
      outcome = '❌ Что-то пошло не так. Попробуйте позже.';
    }
  } finally {
    try {
      await setJobState(job.id, 'done');
    } catch (e) {
      console.warn('Не удалось завершить загрузку в базе', e);
    }
  }

  try {
    if (outcome) await edit(status, outcome);
    else await api.deleteMessage({ chat_id: chatId, message_id: status.message_id });
  } catch (e) {
    if (e?.code !== 400) throw e;
  }
}

async function onCancel(call, jobId) {
  const job = await getJob(jobId);
  if (!job || job.state !== 'active') {
    await api.answerCallbackQuery({ callback_query_id: call.id, text: 'Загрузка уже завершена.' });
    return;
  }
  if (call.from.id !== job.userId) {
    await api.answerCallbackQuery({ callback_query_id: call.id, text: 'Отменить может только тот, кто запустил загрузку.', show_alert: true });
    return;
  }
  await setJobState(jobId, 'cancelled');
  await api.answerCallbackQuery({ callback_query_id: call.id, text: 'Отменяю…' });
}
