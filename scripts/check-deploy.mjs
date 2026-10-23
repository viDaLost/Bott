// Сверяет задеплоенные модули с локальной папкой tgcloud/ (запускается в CI).
// Нужен, потому что @tgcloud/cli 0.2.0 иногда падает уже после успешного деплоя
// при записи локального снимка — так видно, дошёл ли код до облака.
import fs from 'node:fs';
import path from 'node:path';
import { getFiles } from '../node_modules/@tgcloud/cli/src/api/endpoints.js';

const token = process.env.TGCLOUD_TOKEN;
if (!token) {
  console.log('TGCLOUD_TOKEN не задан — проверка пропущена.');
  process.exit(0);
}

function localModules(dir = 'tgcloud', out = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) localModules(p, out);
    else if (p.endsWith('.js') && !p.endsWith(path.join('endpoints', 'probe.js'))) {
      out[path.relative('tgcloud', p).replace(/\\/g, '/').replace(/\.js$/, '')] = fs.readFileSync(p, 'utf-8');
    }
  }
  return out;
}

const remote = await getFiles(token);
const modules = remote.canonical_modules || {};
const local = localModules();
console.log(`Ревизия в облаке: ${remote.revision}, модулей: ${Object.keys(modules).length}`);

let problems = 0;
for (const [name, code] of Object.entries(local)) {
  const value = modules[name];
  if (value === undefined) {
    console.log(`✗ ${name}: нет в облаке`);
    problems++;
  } else if (typeof value !== 'string') {
    console.log(`? ${name}: сервер вернул ${JSON.stringify(value)} вместо кода`);
  } else if (value.trim() !== code.trim()) {
    console.log(`≠ ${name}: в облаке другая версия (${value.length} символов, локально ${code.length})`);
    problems++;
  } else {
    console.log(`✓ ${name}`);
  }
}
for (const name of Object.keys(modules)) {
  if (!(name in local)) console.log(`! ${name}: есть в облаке, но нет локально`);
}
if (problems) {
  console.log(`\nНе совпадает модулей: ${problems}`);
  process.exit(1);
}
console.log('\nКод в облаке совпадает с репозиторием.');
