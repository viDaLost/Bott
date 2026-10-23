// Заглушка 'sdk': база на node:sqlite, запись вызовов Bot API и подменяемый fetch.
import { DatabaseSync } from 'node:sqlite';
import { ddl } from './sdk-db.js';

let sqlite = new DatabaseSync(':memory:');

function norm(params = {}) {
  const out = {};
  for (const [k, v] of Object.entries(params)) out[k.replace(/^[:@$]/, '')] = typeof v === 'boolean' ? Number(v) : v;
  return out;
}

export const db = {
  async run(q, params) {
    const r = sqlite.prepare(q).run(norm(params));
    return { rowsAffected: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid), rows: [] };
  },
  async all(q, params) {
    return sqlite.prepare(q).all(norm(params)).map((r) => ({ ...r }));
  },
  async get(q, params) {
    const r = sqlite.prepare(q).get(norm(params));
    return r ? { ...r } : null;
  },
};

export async function resetDb(schema) {
  sqlite = new DatabaseSync(':memory:');
  for (const t of Object.values(schema)) if (t?.__table) for (const s of ddl(t)) sqlite.exec(s);
}

export class BotApiError extends Error {
  constructor(method, code, description) {
    super(description);
    this.method = method;
    this.code = code;
    this.description = description;
  }
}

export class InputFile {
  constructor(bytes, filename, opts = {}) {
    this.bytes = bytes;
    this.filename = filename;
    this.type = opts.type;
  }
}

export class FormData {
  constructor() { this.fields = []; }
  append(k, v) { this.fields.push([k, v]); }
}

// Вызовы Bot API: api.calls — журнал, api.handlers[method] — свой ответ.
let messageId = 100;
export const apiState = { calls: [], handlers: {} };

export const api = new Proxy({}, {
  get(_t, method) {
    return async (params = {}) => {
      apiState.calls.push({ method, params });
      if (apiState.handlers[method]) return apiState.handlers[method](params);
      if (method === 'getMe') return { id: 1, username: 'test_bot' };
      if (method.startsWith('send') && method !== 'sendChatAction') {
        const msg = { message_id: ++messageId, chat: { id: params.chat_id } };
        if (method === 'sendVideo') msg.video = { file_id: `video-${messageId}` };
        if (method === 'sendAudio') msg.audio = { file_id: `audio-${messageId}` };
        if (method === 'sendDocument') msg.document = { file_id: `doc-${messageId}` };
        return method === 'sendMediaGroup' ? [msg] : msg;
      }
      return true;
    };
  },
});

// fetch: fetchState.routes — [ [RegExp | (url, init) => bool, (url, init) => Response-like] ]
export const fetchState = { routes: [], calls: [] };

export function response(body, { status = 200, headers = {}, chunks = null } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body)
    : body instanceof Uint8Array ? body : new TextEncoder().encode(JSON.stringify(body));
  const parts = chunks || [bytes];
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => lower[k.toLowerCase()] ?? null, has: (k) => k.toLowerCase() in lower },
    async json() { return JSON.parse(new TextDecoder().decode(bytes)); },
    async text() { return new TextDecoder().decode(bytes); },
    body: { async *[Symbol.asyncIterator]() { for (const p of parts) yield p; } },
  };
}

export async function fetch(url, init = {}) {
  fetchState.calls.push({ url, init });
  for (const [match, handler] of fetchState.routes) {
    if (match instanceof RegExp ? match.test(url) : match(url, init)) return handler(url, init);
  }
  throw new TypeError(`fetch failed: нет заглушки для ${url}`);
}

export function resetMocks() {
  apiState.calls = [];
  apiState.handlers = {};
  fetchState.routes = [];
  fetchState.calls = [];
}
