// Поиск музыки на YouTube со страницами «◀ Назад» / «Ещё ▶».
// Результаты хранятся в базе, следующие пачки подгружаются по токену продолжения.
import { MAX_RESULTS, PAGE_SIZE } from './config.js';
import { youtubeUrl } from './links.js';
import { loadSearch, putMany, saveSearch } from './storage.js';
import { encodeTarget } from './targets.js';
import { escapeHtml, fmtDuration, kb, randomKey, short } from './text.js';
import { searchMore, searchYoutube } from './sources/youtube.js';

export async function newSearch(cfg, query) {
  const { results, continuation } = await searchYoutube(cfg, query);
  const id = randomKey();
  await saveSearch(id, query, dedupe(results).slice(0, MAX_RESULTS), continuation);
  return id;
}

function dedupe(results) {
  const seen = new Set();
  return results.filter((r) => !seen.has(r.id) && seen.add(r.id));
}

// Возвращает { text, markup }, null — если на странице пусто, 'expired' — если поиск устарел.
export async function renderPage(cfg, sid, page) {
  const s = await loadSearch(sid);
  if (!s) return 'expired';

  const start = page * PAGE_SIZE;
  const need = Math.min(start + PAGE_SIZE + 1, MAX_RESULTS);
  let changed = false;
  while (s.results.length < need && s.continuation) {
    const more = await searchMore(cfg, s.query, s.continuation);
    const before = s.results.length;
    s.results = dedupe([...s.results, ...more.results]).slice(0, MAX_RESULTS);
    // пустая пачка или потолок — дальше листать нечего
    s.continuation = s.results.length > before && s.results.length < MAX_RESULTS ? more.continuation : null;
    changed = true;
  }
  if (changed) await saveSearch(sid, s.query, s.results, s.continuation);

  const chunk = s.results.slice(start, start + PAGE_SIZE);
  if (!chunk.length) return null;

  const keys = await putMany(chunk.map((r) => encodeTarget({
    url: youtubeUrl(r.id), title: r.title, channel: r.channel, duration: r.duration,
  })));
  const rows = chunk.map((r, i) => {
    let label = `${start + i + 1}. ${short(r.title, 44)}`;
    const d = fmtDuration(r.duration);
    if (d) label += ` · ${d}`;
    return [[label, `a:${keys[i]}`]];
  });

  const hasNext = s.results.length > start + PAGE_SIZE || Boolean(s.continuation);
  const nav = [];
  if (page > 0) nav.push(['◀ Назад', `p:${sid}:${page - 1}`]);
  if (page > 0 || hasNext) nav.push([`стр. ${page + 1}`, 'noop']);
  if (hasNext) nav.push(['Ещё ▶', `p:${sid}:${page + 1}`]);
  if (nav.length) rows.push(nav);

  return {
    text: `🎵 <b>${escapeHtml(short(s.query, 80))}</b>\nВыберите трек 👇`,
    markup: kb(rows),
  };
}

// Первый подходящий трек по запросу — для кнопок после /lyrics и распознавания.
export async function firstResult(cfg, query) {
  const { results } = await searchYoutube(cfg, query);
  return results[0] || null;
}
