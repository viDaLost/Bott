// Сценарии целиком: апдейт → обработчик → вызовы Bot API, на заглушках платформы.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { apiState, fetchState, resetDb, resetMocks, response } from 'sdk';
import * as schema from '../tgcloud/schema.js';
import onMessage from '../tgcloud/handlers/message.js';
import onCallback from '../tgcloud/handlers/callback_query.js';
import { ALLOWED_USERS, OWNER_IDS } from '../tgcloud/lib/config.js';
import { resetSettingsCache } from '../tgcloud/lib/settings.js';

const USER = { id: 42, is_bot: false, first_name: 'Ann' };
const CHAT = { id: 42, type: 'private' };
let updateId = 1;
let messageId = 1;

async function send(text, extra = {}) {
  const message = { message_id: messageId++, from: USER, chat: CHAT, date: 0, text, ...extra };
  await onMessage(message, { update: { update_id: updateId++, message } });
  return message;
}

async function press(data, from = USER) {
  const callback = { id: `cb${updateId}`, from, data, message: { message_id: 999, chat: CHAT } };
  await onCallback(callback, { update: { update_id: updateId++, callback_query: callback } });
}

const calls = (method) => apiState.calls.filter((c) => c.method === method);
const lastButtons = () => {
  const withKb = apiState.calls.filter((c) => c.params.reply_markup).at(-1);
  return withKb.params.reply_markup.inline_keyboard.flat();
};

beforeEach(async () => {
  resetMocks();
  await resetDb(schema);
  resetSettingsCache();
  OWNER_IDS.length = 0;
  ALLOWED_USERS.length = 0;
});

const TIKTOK = 'https://www.tiktok.com/@user/video/7234567890123456789';

function tikwmRoutes(post) {
  fetchState.routes.push(
    [/tikwm\.com\/api\//, () => response({ code: 0, data: post })],
    [/cdn\.example\/video\.mp4/, () => response(new Uint8Array(1000), { headers: { 'content-type': 'video/mp4', 'content-length': 1000 } })],
  );
}

test('ссылка на TikTok → видео, повторный запрос — из кэша', async () => {
  tikwmRoutes({ id: '7234567890123456789', title: 'Котик', duration: 10, play: 'https://cdn.example/video.mp4', size: 1000 });
  await send(`глянь ${TIKTOK}`);
  const [video, audio] = lastButtons();
  assert.equal(video.text, '🎬 Видео');
  assert.match(audio.callback_data, /^a:/);

  await press(video.callback_data);
  const sent = calls('sendVideo');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.video.filename, 'Котик.mp4');
  assert.equal(sent[0].params.video.bytes.length, 1000);
  assert.equal(calls('deleteMessage').length, 1, 'статус удалён после успешной отправки');

  const fetchesBefore = fetchState.calls.length;
  await press(video.callback_data);
  assert.equal(calls('sendVideo').length, 2);
  assert.match(calls('sendVideo')[1].params.video, /^video-\d+$/, 'отправлено по file_id');
  assert.equal(fetchState.calls.length, fetchesBefore, 'из кэша — без скачивания');
});

test('повторная доставка того же апдейта игнорируется', async () => {
  const message = { message_id: 1, from: USER, chat: CHAT, date: 0, text: TIKTOK };
  await onMessage(message, { update: { update_id: 777, message } });
  await onMessage(message, { update: { update_id: 777, message } });
  assert.equal(calls('sendMessage').length, 1);
});

test('YouTube без cobalt — понятная ошибка', async () => {
  await send('https://youtu.be/dQw4w9WgXcQ');
  const [video] = lastButtons();
  fetchState.routes.push([/youtube\.com\/oembed/, () => response({ title: 'Song', author_name: 'Artist' })]);
  await press(video.callback_data);
  const edits = calls('editMessageText');
  assert.match(edits.at(-1).params.text, /cobalt/);
});

test('cobalt: качество понижается, если файл не влезает', async () => {
  OWNER_IDS.push(USER.id);
  await send('/set cobalt_url https://cobalt.example/');
  resetSettingsCache();
  const asked = [];
  fetchState.routes.push(
    [/youtube\.com\/oembed/, () => response({ title: 'Song', author_name: 'Artist - Topic' })],
    [(url, init) => url === 'https://cobalt.example/' && init.method === 'POST', (_u, init) => {
      const body = JSON.parse(init.body);
      asked.push(body.audioBitrate);
      return response({ status: 'tunnel', url: `https://cobalt.example/tunnel/${body.audioBitrate}`, filename: 'Song.mp3' });
    }],
    [/tunnel\/128/, () => response('x', { headers: { 'content-length': 60 * 2 ** 20 } })],
    [/tunnel\/96/, () => response(new Uint8Array(500), { headers: { 'content-type': 'audio/mpeg' } })],
  );
  await send('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const [, audio] = lastButtons();
  await press(audio.callback_data);
  assert.deepEqual(asked, ['128', '96']);
  const sent = calls('sendAudio');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.title, 'Song');
  assert.equal(sent[0].params.performer, 'Artist');
});

test('поиск музыки и листание страниц', async () => {
  const video = (n) => ({ videoRenderer: { videoId: `vid${String(n).padStart(8, '0')}`, title: { runs: [{ text: `Трек ${n}` }] }, lengthText: { simpleText: '3:00' } } });
  fetchState.routes.push([/youtubei\/v1\/search/, (_u, init) => {
    const body = JSON.parse(init.body);
    if (body.continuation) return response({ onResponseReceivedCommands: [{ appendContinuationItemsAction: { continuationItems: Array.from({ length: 5 }, (_, i) => video(20 + i)) } }] });
    return response({ contents: [{ itemSectionRenderer: { contents: Array.from({ length: 10 }, (_, i) => video(i)) } }, { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'T' } } } }] });
  }]);
  await send('numb linkin park');
  let buttons = lastButtons();
  assert.equal(buttons.filter((b) => b.callback_data.startsWith('a:')).length, 8);
  const next = buttons.find((b) => b.text === 'Ещё ▶');
  await press(next.callback_data);
  buttons = lastButtons();
  const tracks = buttons.filter((b) => b.callback_data.startsWith('a:'));
  assert.equal(tracks.length, 7); // 2 из первой пачки + 5 из продолжения
  assert.match(tracks[0].text, /^9\. Трек 8/);
  assert.ok(!buttons.some((b) => b.text === 'Ещё ▶'), 'больше страниц нет');
});

test('отмена загрузки', async () => {
  tikwmRoutes({ id: '1', title: 'T', play: 'https://cdn.example/slow.mp4' });
  fetchState.routes.push([/slow\.mp4/, async () => {
    // пока идёт загрузка, пользователь нажимает «Отмена» (отдельный вызов обработчика)
    const job = apiState.calls.filter((c) => c.params.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('c:')).at(-1);
    await press(job.params.reply_markup.inline_keyboard[0][0].callback_data);
    return response(new Uint8Array(10), { headers: { 'content-length': 10 } });
  }]);
  await send(TIKTOK);
  await press(lastButtons()[0].callback_data);
  assert.equal(calls('sendVideo').length, 0);
  assert.match(calls('editMessageText').at(-1).params.text, /отменена/);
});

test('доступ: чужим закрыто, /id работает всегда', async () => {
  ALLOWED_USERS.push(1);
  await send('привет');
  assert.match(calls('sendMessage').at(-1).params.text, /Доступ закрыт/);
  await send('/id');
  assert.match(calls('sendMessage').at(-1).params.text, /<code>42<\/code>/);
});

test('владелец задаёт токен — сообщение с ним удаляется', async () => {
  OWNER_IDS.push(USER.id);
  const msg = await send('/set genius_token secret123');
  assert.deepEqual(calls('deleteMessage')[0].params, { chat_id: CHAT.id, message_id: msg.message_id });
  await send('/settings');
  const text = calls('sendMessage').at(-1).params.text;
  assert.ok(!text.includes('secret123'));
  assert.match(text, /genius_token<\/code>: ✅ задан/);
});

test('в группе обычный текст не запускает поиск', async () => {
  const message = { message_id: 5, from: USER, chat: { id: -100, type: 'supergroup' }, date: 0, text: 'просто болтаем' };
  await onMessage(message, { update: { update_id: updateId++, message } });
  assert.equal(apiState.calls.length, 0);
});

test('карусель TikTok: альбом, а webp — повтором как файлы', async () => {
  const images = Array.from({ length: 12 }, (_, i) => `https://cdn.example/p${i}.webp`);
  fetchState.routes.push(
    [/tikwm\.com\/api\//, () => response({ code: 0, data: { id: '9', title: 'Фото', images } })],
    [/cdn\.example\/p\d+\.webp/, () => response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), { headers: { 'content-type': 'image/webp' } })],
  );
  let firstTry = true;
  apiState.handlers.sendMediaGroup = (params) => {
    if (params.media[0].type === 'photo' && firstTry) {
      firstTry = false;
      const e = new Error('Bad Request: IMAGE_PROCESS_FAILED');
      e.code = 400;
      throw e;
    }
    return [];
  };
  await send(TIKTOK);
  await press(lastButtons()[0].callback_data);
  const groups = calls('sendMediaGroup');
  assert.equal(groups.length, 3); // 10 фото (отказ) → 10 файлами → оставшиеся 2
  assert.equal(groups[1].params.media[0].type, 'document');
  assert.equal(groups[1].params.media[0].caption, 'Фото');
  assert.equal(groups[2].params.media.length, 2);
  assert.equal(calls('deleteMessage').length, 1);
});
