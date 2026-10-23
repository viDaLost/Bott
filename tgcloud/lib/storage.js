// Работа с базой. Все запросы — сырой SQL с именованными параметрами,
// схема таблиц — в ../schema.js.
import { db } from 'sdk';
import {
  FILE_TTL_SEC, JOB_STALE_SEC, KEY_TTL_SEC, SEARCH_TTL_SEC, UPDATE_TTL_SEC,
} from './config.js';
import { now, randomKey } from './text.js';

function inList(prefix, values) {
  const params = {};
  const marks = values.map((v, i) => {
    params[`:${prefix}${i}`] = v;
    return `:${prefix}${i}`;
  });
  return { marks: marks.join(', '), params };
}

// ------------------------------------------------------------ апдейты

// true — апдейт новый; false — Telegram/платформа доставили его повторно.
export async function claimUpdate(updateId) {
  if (updateId == null) return true;
  const res = await db.run(
    'INSERT OR IGNORE INTO updates (id, created) VALUES (:id, :t)',
    { ':id': updateId, ':t': now() },
  );
  return res.rowsAffected > 0;
}

// Чистка устаревших записей. Cron на платформе нет, поэтому вызывается
// изредка из обработчиков (см. maybePrune).
export async function prune() {
  const t = now();
  await db.run('DELETE FROM keys WHERE created < :t', { ':t': t - KEY_TTL_SEC });
  await db.run('DELETE FROM files WHERE created < :t', { ':t': t - FILE_TTL_SEC });
  await db.run('DELETE FROM searches WHERE created < :t', { ':t': t - SEARCH_TTL_SEC });
  await db.run('DELETE FROM updates WHERE created < :t', { ':t': t - UPDATE_TTL_SEC });
  await db.run('DELETE FROM jobs WHERE created < :t', { ':t': t - 24 * 3600 });
}

export async function maybePrune(probability = 0.02) {
  if (Math.random() >= probability) return;
  try {
    await prune();
  } catch (e) {
    console.warn('Не удалось почистить базу', e);
  }
}

// ------------------------------------------------------------ кнопки

export async function putMany(values) {
  if (!values.length) return [];
  const t = now();
  const keys = values.map(() => randomKey());
  const params = {};
  const rows = values.map((v, i) => {
    params[`:k${i}`] = keys[i];
    params[`:v${i}`] = v;
    return `(:k${i}, :v${i}, :t)`;
  });
  params[':t'] = t;
  await db.run(`INSERT INTO keys (key, value, created) VALUES ${rows.join(', ')}`, params);
  return keys;
}

export async function put(value) {
  return (await putMany([value]))[0];
}

export async function get(key) {
  const row = await db.get(
    'SELECT value FROM keys WHERE key = :k AND created > :t',
    { ':k': key, ':t': now() - KEY_TTL_SEC },
  );
  return row ? row.value : null;
}

// ------------------------------------------------------------ кэш file_id
// Кэш — не главное: если база недоступна, бот просто скачает файл заново.

export async function getFile(sources, kind) {
  sources = [...new Set(sources.filter(Boolean))];
  if (!sources.length) return null;
  const { marks, params } = inList('s', sources);
  let rows;
  try {
    rows = await db.all(
      `SELECT source, file_id, title FROM files WHERE source IN (${marks}) AND kind = :kind AND created > :t`,
      { ...params, ':kind': kind, ':t': now() - FILE_TTL_SEC },
    );
  } catch (e) {
    console.warn('Не удалось прочитать кэш file_id', e);
    return null;
  }
  if (!rows.length) return null;
  rows.sort((a, b) => sources.indexOf(a.source) - sources.indexOf(b.source));
  return { fileId: rows[0].file_id, title: rows[0].title };
}

export async function saveFile(sources, kind, fileId, title) {
  sources = [...new Set(sources.filter(Boolean))];
  if (!sources.length) return;
  const params = { ':kind': kind, ':f': fileId, ':title': title ?? null, ':t': now() };
  const rows = sources.map((s, i) => {
    params[`:s${i}`] = s;
    return `(:s${i}, :kind, :f, :title, :t)`;
  });
  try {
    await db.run(
      `INSERT OR REPLACE INTO files (source, kind, file_id, title, created) VALUES ${rows.join(', ')}`,
      params,
    );
  } catch (e) {
    console.warn('Не удалось сохранить file_id', e);
  }
}

export async function forgetFile(fileId) {
  try {
    await db.run('DELETE FROM files WHERE file_id = :f', { ':f': fileId });
  } catch (e) {
    console.warn('Не удалось удалить file_id из кэша', e);
  }
}

// ------------------------------------------------------------ поиск

export async function saveSearch(id, query, results, continuation) {
  await db.run(
    `INSERT OR REPLACE INTO searches (id, query, results, continuation, created)
     VALUES (:id, :q, :r, :c, :t)`,
    { ':id': id, ':q': query, ':r': JSON.stringify(results), ':c': continuation ?? null, ':t': now() },
  );
}

export async function loadSearch(id) {
  const row = await db.get(
    'SELECT query, results, continuation FROM searches WHERE id = :id AND created > :t',
    { ':id': id, ':t': now() - SEARCH_TTL_SEC },
  );
  if (!row) return null;
  return { query: row.query, results: JSON.parse(row.results), continuation: row.continuation };
}

// ------------------------------------------------------------ загрузки

// Регистрирует загрузку. id — id нажатия кнопки, поэтому повторная доставка
// того же нажатия не запустит загрузку второй раз. Возвращает false, если
// такая загрузка уже была.
export async function startJob(id, userId, chatId) {
  const res = await db.run(
    `INSERT OR IGNORE INTO jobs (id, user_id, chat_id, state, created)
     VALUES (:id, :u, :c, 'active', :t)`,
    { ':id': id, ':u': userId, ':c': chatId, ':t': now() },
  );
  return res.rowsAffected > 0;
}

export async function activeJobs(userId) {
  const row = await db.get(
    "SELECT count(*) AS n FROM jobs WHERE user_id = :u AND state = 'active' AND created > :t",
    { ':u': userId, ':t': now() - JOB_STALE_SEC },
  );
  return row ? Number(row.n) : 0;
}

export async function getJob(id) {
  const row = await db.get(
    'SELECT id, user_id, chat_id, state, created FROM jobs WHERE id = :id',
    { ':id': id },
  );
  return row ? { id: row.id, userId: row.user_id, chatId: row.chat_id, state: row.state, created: row.created } : null;
}

export async function setJobState(id, state) {
  await db.run('UPDATE jobs SET state = :s WHERE id = :id', { ':s': state, ':id': id });
}

// ------------------------------------------------------------ настройки и доступ

export async function getSettings() {
  const rows = await db.all('SELECT key, value FROM settings', {});
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setSetting(key, value) {
  await db.run(
    'INSERT OR REPLACE INTO settings (key, value, updated) VALUES (:k, :v, :t)',
    { ':k': key, ':v': value, ':t': now() },
  );
}

export async function deleteSetting(key) {
  await db.run('DELETE FROM settings WHERE key = :k', { ':k': key });
}

export async function allowedUserIds() {
  const rows = await db.all('SELECT user_id FROM allowed_users ORDER BY added', {});
  return rows.map((r) => Number(r.user_id));
}

export async function allowUser(userId) {
  await db.run(
    'INSERT OR IGNORE INTO allowed_users (user_id, added) VALUES (:u, :t)',
    { ':u': userId, ':t': now() },
  );
}

export async function denyUser(userId) {
  await db.run('DELETE FROM allowed_users WHERE user_id = :u', { ':u': userId });
}

export async function stats() {
  const one = async (q, params = {}) => Number((await db.get(q, params))?.n ?? 0);
  return {
    files: await one('SELECT count(*) AS n FROM files'),
    jobsDay: await one('SELECT count(*) AS n FROM jobs WHERE created > :t', { ':t': now() - 24 * 3600 }),
    activeJobs: await one("SELECT count(*) AS n FROM jobs WHERE state = 'active' AND created > :t", { ':t': now() - JOB_STALE_SEC }),
    allowed: await one('SELECT count(*) AS n FROM allowed_users'),
  };
}
