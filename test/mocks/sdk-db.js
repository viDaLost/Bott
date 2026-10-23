// Заглушка 'sdk/db': DSL схемы превращается в DDL для SQLite, чтобы тесты
// создавали те же таблицы, что описаны в tgcloud/schema.js.

function column(type, name) {
  const col = {
    type, name, mods: [],
    primaryKey(opts = {}) { this.mods.push(opts.autoIncrement ? 'PRIMARY KEY AUTOINCREMENT' : 'PRIMARY KEY'); return this; },
    notNull() { this.mods.push('NOT NULL'); return this; },
    unique() { this.mods.push('UNIQUE'); return this; },
    default(v) { this.mods.push(`DEFAULT ${typeof v === 'string' ? `'${v}'` : v}`); return this; },
  };
  return col;
}

export const text = (name) => column('TEXT', name);
export const integer = (name) => column('INTEGER', name);
export const real = (name) => column('REAL', name);

function idx(unique) {
  return (name) => ({ on: (...cols) => ({ index: true, unique, name, cols }) });
}
export const index = idx(false);
export const uniqueIndex = idx(true);

export function table(name, cols, extras) {
  for (const [key, col] of Object.entries(cols)) col.name = col.name || key;
  const refs = Object.fromEntries(Object.entries(cols).map(([k, c]) => [k, c]));
  return { __table: true, name, cols: Object.values(cols), extras: extras ? Object.values(extras(refs)) : [] };
}

export function ddl(t) {
  const out = [`CREATE TABLE ${t.name} (${t.cols.map((c) => [c.name, c.type, ...c.mods].join(' ')).join(', ')})`];
  for (const e of t.extras) {
    out.push(`CREATE ${e.unique ? 'UNIQUE ' : ''}INDEX ${e.name} ON ${t.name} (${e.cols.map((c) => c.name).join(', ')})`);
  }
  return out;
}

export function sql() {
  throw new Error('sql`` не используется в коде бота');
}
