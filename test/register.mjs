// Подменяет модули платформы ('sdk', 'sdk/db') локальными заглушками,
// чтобы код из tgcloud/ можно было проверять обычным `node --test`.
import { register } from 'node:module';

register('./loader.mjs', import.meta.url);
