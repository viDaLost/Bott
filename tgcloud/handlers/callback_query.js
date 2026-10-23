// Нажатия inline-кнопок: скачать видео/аудио, листать поиск, отменить загрузку.
import { handleCallback } from '../lib/bot.js';

export default async function (callbackQuery, ctx) {
  await handleCallback(callbackQuery, ctx);
}
