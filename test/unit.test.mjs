import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findUrl, siteName, sourceIds, tiktokId, youtubeId } from '../tgcloud/lib/links.js';
import { decodeTarget, encodeTarget } from '../tgcloud/lib/targets.js';
import { escapeHtml, fmtDuration, parseDuration, safeFilename, short } from '../tgcloud/lib/text.js';
import { parseCobaltResponse, titleFromFilename } from '../tgcloud/lib/sources/cobalt.js';
import { parseInnertube } from '../tgcloud/lib/sources/youtube.js';
import { parsePost, videoCandidates } from '../tgcloud/lib/sources/tikwm.js';
import { DownloadError, TooLarge } from '../tgcloud/lib/job.js';

test('ссылки: поиск в тексте и обрезка знаков препинания', () => {
  assert.equal(findUrl('смотри https://youtu.be/dQw4w9WgXcQ).'), 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(findUrl('без ссылок'), null);
});

test('ссылки: устойчивые id для YouTube и TikTok', () => {
  for (const url of [
    'https://youtu.be/dQw4w9WgXcQ?si=abc',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10',
    'https://m.youtube.com/shorts/dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=x',
  ]) assert.equal(youtubeId(url), 'dQw4w9WgXcQ', url);
  assert.equal(youtubeId('https://notyoutube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(tiktokId('https://www.tiktok.com/@user/video/7234567890123456789'), '7234567890123456789');
  assert.deepEqual(sourceIds('https://youtu.be/dQw4w9WgXcQ'), ['youtube:dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ']);
  assert.equal(siteName('https://www.instagram.com/reel/abc'), 'Instagram');
  assert.equal(siteName('https://example.org/x'), 'example.org');
});

test('кнопки: кодирование цели', () => {
  assert.equal(encodeTarget({ url: 'https://a.b/c' }), 'https://a.b/c');
  const t = decodeTarget(encodeTarget({ url: 'https://a.b/c', title: 'T', duration: 61 }));
  assert.equal(t.url, 'https://a.b/c');
  assert.equal(t.title, 'T');
  assert.equal(t.duration, 61);
  assert.equal(decodeTarget(encodeTarget({ query: 'a - b' })).query, 'a - b');
  assert.equal(decodeTarget('{битый'), null);
  // ключ кнопки + префикс укладываются в 64 байта callback_data
  assert.ok(Buffer.byteLength('p:0123456789ab:199') <= 64);
});

test('текст: форматирование', () => {
  assert.equal(fmtDuration(3725), '1:02:05');
  assert.equal(fmtDuration(65), '1:05');
  assert.equal(parseDuration('1:02:05'), 3725);
  assert.equal(parseDuration(''), null);
  assert.equal(short('абвгд', 3), 'аб…');
  assert.equal(escapeHtml('<b>&'), '&lt;b&gt;&amp;');
  assert.equal(safeFilename('a/b:c?', '.mp4'), 'a b c.mp4');
});

test('cobalt: разбор ответов', () => {
  assert.deepEqual(parseCobaltResponse({ status: 'tunnel', url: 'https://c/t', filename: 'X (720p, h264).mp4' }),
    { type: 'file', url: 'https://c/t', filename: 'X (720p, h264).mp4' });
  const picker = parseCobaltResponse({ status: 'picker', picker: [{ type: 'photo', url: 'u1' }, { url: 'u2' }, {}], audio: 'a' });
  assert.equal(picker.items.length, 2);
  assert.equal(picker.audio, 'a');
  assert.throws(() => parseCobaltResponse({ status: 'error', error: { code: 'error.api.content.video.age' } }, 'https://youtu.be/x'),
    (e) => e instanceof DownloadError && /возрастным/.test(e.message));
  assert.throws(() => parseCobaltResponse({ status: 'error', error: { code: 'error.api.<script>' } }),
    (e) => !e.message.includes('<script>'));
  assert.equal(titleFromFilename('Song Name (720p, h264).mp4'), 'Song Name');
  assert.equal(titleFromFilename('Song - Artist.mp3'), 'Song - Artist');
});

test('YouTube: разбор поиска и продолжения', () => {
  const video = (id, title, len) => ({ videoRenderer: {
    videoId: id, title: { runs: [{ text: title }] },
    ...(len ? { lengthText: { simpleText: len } } : {}),
    ownerText: { runs: [{ text: 'Channel - Topic' }] },
  } });
  const data = { contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [
    { itemSectionRenderer: { contents: [video('aaaaaaaaaaa', 'Первый', '3:30'), { adSlotRenderer: {} }, video('bbbbbbbbbbb', 'Эфир', null), video('ccccccccccc', 'Третий', '1:00:00')] } },
    { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'TOKEN' } } } },
  ] } } } } };
  const { results, continuation } = parseInnertube(data);
  assert.deepEqual(results.map((r) => r.id), ['aaaaaaaaaaa', 'ccccccccccc']); // трансляция отброшена
  assert.equal(results[0].duration, 210);
  assert.equal(results[0].channel, 'Channel - Topic');
  assert.equal(continuation, 'TOKEN');

  const more = parseInnertube({ onResponseReceivedCommands: [{ appendContinuationItemsAction: { continuationItems: [video('ddddddddddd', 'Ещё', '2:00')] } }] });
  assert.deepEqual(more.results.map((r) => r.id), ['ddddddddddd']);
  assert.equal(more.continuation, null);
});

test('TikWM: разбор поста и выбор качества', () => {
  const post = parsePost({ id: 7, title: ' ', duration: '15', play: '/video/play.mp4', hdplay: 'https://x/hd.mp4', size: 1000, hd_size: 5000, images: ['i1', null] });
  assert.equal(post.title, 'TikTok');
  assert.equal(post.video, 'https://www.tikwm.com/video/play.mp4');
  assert.deepEqual(post.images, ['i1']);
  assert.deepEqual(videoCandidates(post, 10000), ['https://x/hd.mp4', 'https://www.tikwm.com/video/play.mp4']);
  assert.deepEqual(videoCandidates(post, 2000), ['https://www.tikwm.com/video/play.mp4']);
  assert.throws(() => videoCandidates(post, 500), TooLarge);
});
