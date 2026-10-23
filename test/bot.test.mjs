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

// Сервер, который отдаёт файл кусками по заголовку Range (как googlevideo).
function rangedFile(bytes, ranges = []) {
  return (_url, init) => {
    const m = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range || '');
    if (!m) return response(bytes, { headers: { 'content-length': bytes.length } });
    ranges.push(`${m[1]}-${m[2]}`);
    const part = bytes.subarray(Number(m[1]), Number(m[2]) + 1);
    return response(part, { status: 206, headers: { 'content-length': part.length, 'content-type': 'video/mp4' } });
  };
}

function playerResponse({ status = 'OK', reason, videos = [], audios = [] } = {}) {
  return {
    playabilityStatus: { status, reason },
    videoDetails: { title: 'Numb', author: 'Linkin Park - Topic', lengthSeconds: '187' },
    streamingData: {
      formats: videos.map((v) => ({ itag: 18, mimeType: 'video/mp4; codecs="avc1"', height: 360, ...v })),
      adaptiveFormats: [
        { itag: 137, mimeType: 'video/mp4; codecs="avc1"', url: 'https://gv.example/video-only', contentLength: '999' },
        ...audios.map((a) => ({ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', ...a })),
      ],
    },
  };
}

test('YouTube без cobalt: аудио M4A через плеер, скачивание кусками', async () => {
  const ranges = [];
  fetchState.routes.push(
    [/youtubei\/v1\/player/, () => response(playerResponse({
      audios: [
        { url: 'https://gv.example/too-big', bitrate: 256000, contentLength: String(60 * 2 ** 20) },
        { url: 'https://gv.example/audio', bitrate: 128000, contentLength: String(20 * 2 ** 20) },
      ],
    }))],
    [/gv\.example\/audio/, rangedFile(new Uint8Array(20 * 2 ** 20), ranges)],
  );
  await send('https://youtu.be/dQw4w9WgXcQ');
  const [, audio] = lastButtons();
  await press(audio.callback_data);
  const sent = calls('sendAudio');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.title, 'Numb');
  assert.equal(sent[0].params.performer, 'Linkin Park');
  assert.equal(sent[0].params.audio.filename, 'Numb.m4a');
  assert.equal(sent[0].params.audio.bytes.length, 20 * 2 ** 20);
  assert.deepEqual(ranges, ['0-8388607', '8388608-16777215', '16777216-20971519']);
  assert.ok(!fetchState.calls.some((c) => c.url.includes('too-big')), 'слишком большой формат не скачивается');
});

test('YouTube без cobalt: видео со звуком', async () => {
  fetchState.routes.push(
    [/youtubei\/v1\/player/, () => response(playerResponse({ videos: [{ url: 'https://gv.example/v18', contentLength: '3000' }] }))],
    [/gv\.example\/v18/, rangedFile(new Uint8Array(3000))],
  );
  await send('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await press(lastButtons()[0].callback_data);
  const sent = calls('sendVideo');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.video.filename, 'Numb.mp4');
  assert.equal(sent[0].params.duration, 187);
});

test('YouTube заблокировал запрос — понятная ошибка', async () => {
  fetchState.routes.push([/youtubei\/v1\/player/, () => response(playerResponse({ status: 'LOGIN_REQUIRED', reason: "Sign in to confirm you're not a bot" }))]);
  await send('https://youtu.be/dQw4w9WgXcQ');
  await press(lastButtons()[0].callback_data);
  assert.match(calls('editMessageText').at(-1).params.text, /не от бота/);
});

const igMedia = (extra) => ({ data: { xdt_shortcode_media: {
  owner: { username: 'nasa' },
  edge_media_to_caption: { edges: [{ node: { text: 'Подпись поста' } }] },
  ...extra,
} } });

test('Instagram: Reels скачивается как видео', async () => {
  fetchState.routes.push(
    [(url, init) => url.includes('instagram.com/graphql/query') && /shortcode%22%3A%22C1a2B3c4D5e/.test(init.body),
      () => response(igMedia({ is_video: true, video_url: 'https://ig.example/v.mp4', display_url: 'https://ig.example/p.jpg' }))],
    [/ig\.example\/v\.mp4/, () => response(new Uint8Array(700), { headers: { 'content-type': 'video/mp4' } })],
  );
  await send('https://www.instagram.com/reel/C1a2B3c4D5e/?igsh=abc');
  await press(lastButtons()[0].callback_data);
  const sent = calls('sendVideo');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.caption, 'Подпись поста');

  const before = fetchState.calls.length;
  await send('https://instagram.com/p/C1a2B3c4D5e/');
  await press(lastButtons()[0].callback_data);
  assert.equal(calls('sendVideo').length, 2);
  assert.equal(fetchState.calls.length, before, 'другая ссылка на тот же пост — из кэша');
});

test('Instagram: карусель альбомом, «MP3» — понятный отказ', async () => {
  fetchState.routes.push(
    [/instagram\.com\/graphql\/query/, () => response(igMedia({ edge_sidecar_to_children: { edges: [
      { node: { is_video: false, display_url: 'https://ig.example/1.jpg' } },
      { node: { is_video: true, video_url: 'https://ig.example/2.mp4' } },
    ] } }))],
    [/ig\.example\/1\.jpg/, () => response(new Uint8Array([0xff, 0xd8, 0, 0]), { headers: { 'content-type': 'image/jpeg' } })],
    [/ig\.example\/2\.mp4/, () => response(new Uint8Array(50), { headers: { 'content-type': 'video/mp4' } })],
  );
  await send('https://www.instagram.com/p/Cxyz12345/');
  const [video, audio] = lastButtons();
  await press(video.callback_data);
  const group = calls('sendMediaGroup');
  assert.equal(group.length, 1);
  assert.deepEqual(group[0].params.media.map((m) => m.type), ['photo', 'video']);

  await press(audio.callback_data);
  assert.match(calls('editMessageText').at(-1).params.text, /только видео и фото/);
});

test('Instagram закрыл доступ — понятная ошибка', async () => {
  fetchState.routes.push(
    [/instagram\.com\/graphql\/query/, () => response({ data: { xdt_shortcode_media: null } })],
    [/instagram\.com\/p\/.*\/embed/, () => response('<html>login</html>')],
  );
  await send('https://www.instagram.com/p/Cxyz12345/');
  await press(lastButtons()[0].callback_data);
  assert.match(calls('editMessageText').at(-1).params.text, /Instagram не отдал этот пост/);
});

test('X: видео через FxTwitter', async () => {
  fetchState.routes.push(
    [/api\.fxtwitter\.com\/status\/1234567890/, () => response({ code: 200, tweet: {
      text: 'Твит', author: { name: 'Автор' }, media: { all: [{ type: 'video', url: 'https://tw.example/v.mp4' }] },
    } })],
    [/tw\.example\/v\.mp4/, () => response(new Uint8Array(100), { headers: { 'content-type': 'video/mp4' } })],
  );
  await send('https://x.com/someone/status/1234567890?s=20');
  await press(lastButtons()[0].callback_data);
  assert.equal(calls('sendVideo').length, 1);
  assert.equal(calls('sendVideo')[0].params.caption, 'Твит');
});

test('неподдерживаемый сайт — понятная ошибка без упоминания серверов', async () => {
  await send('https://vk.com/video-1_2');
  await press(lastButtons()[0].callback_data);
  const text = calls('editMessageText').at(-1).params.text;
  assert.match(text, /VK пока не поддерживается/);
  assert.ok(!/cobalt/.test(text));
});

test('cobalt: качество понижается, если файл не влезает', async () => {
  OWNER_IDS.push(USER.id);
  await send('/set cobalt_url https://cobalt.example/');
  resetSettingsCache();
  const asked = [];
  fetchState.routes.push(
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
  assert.equal(sent[0].params.performer, undefined);
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
