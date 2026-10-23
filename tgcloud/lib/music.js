// Поиск песни по фрагменту текста (Genius API) и распознавание по звуку (AudD).
import { fetch, FormData, InputFile } from 'sdk';

// Возвращает [{ artist, title }] — только названия, без текстов песен.
export async function geniusSearch(token, fragment, limit = 6) {
  const res = await fetch(`https://api.genius.com/search?q=${encodeURIComponent(fragment)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Genius HTTP ${res.status}`);
  const data = await res.json();
  const results = [];
  for (const hit of data?.response?.hits || []) {
    const r = hit.result || {};
    const artist = String(r.primary_artist?.name || '').trim();
    const title = String(r.title || '').trim();
    if (artist && title) results.push({ artist, title });
    if (results.length >= limit) break;
  }
  return results;
}

// Распознаёт трек из голосового, кружка или аудио. Возвращает { artist, title } или null.
// AudD: https://audd.io — токен в настройке audd_token.
export async function recognize(token, bytes, filename) {
  const form = new FormData();
  form.append('api_token', token);
  form.append('file', new InputFile(bytes, filename));
  const res = await fetch('https://api.audd.io/', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`AudD HTTP ${res.status}`);
  const data = await res.json();
  if (data?.status !== 'success') {
    throw new Error(`AudD: ${data?.error?.error_message || 'ошибка'}`);
  }
  const r = data.result;
  if (!r?.title) return null;
  return { artist: r.artist || '', title: r.title };
}
