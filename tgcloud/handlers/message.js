// Каждое входящее сообщение: команды, ссылки, поиск музыки, распознавание.
import { handleMessage } from '../lib/bot.js';

export default async function (message, ctx) {
  await handleMessage(message, ctx);
}
