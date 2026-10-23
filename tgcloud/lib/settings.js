// Настройки, которые владелец меняет из чата (/set ключ значение), и проверка доступа.
import { ALLOWED_USERS, DEFAULT_COBALT_URL, OWNER_IDS } from './config.js';
import { allowedUserIds, getSettings } from './storage.js';

// Что можно задать через /set. secret — значение не показывается в /settings.
export const SETTING_KEYS = {
  cobalt_url: { secret: false, about: 'адрес cobalt API для YouTube, Instagram, VK и др.' },
  cobalt_key: { secret: true, about: 'API-ключ cobalt (если сервер его требует)' },
  genius_token: { secret: true, about: 'Genius Client Access Token для /lyrics' },
  audd_token: { secret: true, about: 'токен AudD для распознавания музыки' },
  youtube_key: { secret: true, about: 'ключ YouTube Data API — запасной путь поиска' },
};

// Изолят может переживать несколько вызовов, поэтому кэш живёт недолго:
// изменения через /set подхватываются не позже чем через CACHE_MS.
const CACHE_MS = 30 * 1000;
let cache = null;
let cachedAt = 0;

export async function settings() {
  if (!cache || Date.now() - cachedAt > CACHE_MS) {
    try {
      cache = await getSettings();
    } catch (e) {
      console.warn('Не удалось прочитать настройки', e);
      cache = cache || {};
    }
    cachedAt = Date.now();
  }
  return {
    cobaltUrl: (cache.cobalt_url || DEFAULT_COBALT_URL || '').replace(/\/+$/, ''),
    cobaltKey: cache.cobalt_key || '',
    geniusToken: cache.genius_token || '',
    auddToken: cache.audd_token || '',
    youtubeKey: cache.youtube_key || '',
  };
}

export function resetSettingsCache() {
  cache = null;
}

export function isOwner(userId) {
  return OWNER_IDS.includes(Number(userId));
}

export async function isAllowed(userId) {
  if (isOwner(userId)) return true;
  let fromDb = [];
  try {
    fromDb = await allowedUserIds();
  } catch (e) {
    console.warn('Не удалось прочитать список доступа', e);
  }
  const allowed = [...ALLOWED_USERS, ...fromDb];
  return allowed.length === 0 || allowed.includes(Number(userId));
}
