// Instagram без cobalt: публичный GraphQL-запрос сайта по коду поста
// (тот же, что выполняет страница поста в браузере), затем страница
// встраивания (/embed/), затем открытые зеркала InstaFix. Работает для
// открытых постов; закрытые и «18+» — нет.
import { fetch } from 'sdk';
import { DownloadError } from '../job.js';
import { instagramShortcode } from '../links.js';
import { USER_AGENT } from '../transfer.js';

const GRAPHQL_URL = 'https://www.instagram.com/graphql/query';
const DOC_ID = '8845758582119845'; // PolarisPostActionLoadPostQueryQuery
const APP_ID = '936619743392459';
const LSD = 'AVqbxe3J_YA';

function caption(media) {
  const text = media.edge_media_to_caption?.edges?.[0]?.node?.text || '';
  return text.trim() || null;
}

// xdt_shortcode_media → { title, items: [{ type: 'video' | 'photo', url }] }
export function parseMedia(media) {
  if (!media) return null;
  const nodes = media.edge_sidecar_to_children?.edges?.map((e) => e.node) || [media];
  const items = nodes
    .map((n) => (n.is_video && n.video_url
      ? { type: 'video', url: n.video_url }
      : n.display_url ? { type: 'photo', url: n.display_url } : null))
    .filter(Boolean);
  return items.length ? { title: caption(media), author: media.owner?.username || null, items } : null;
}

async function viaGraphql(code) {
  const body = `variables=${encodeURIComponent(JSON.stringify({ shortcode: code }))}`
    + `&doc_id=${DOC_ID}&lsd=${LSD}`;
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
      'X-IG-App-ID': APP_ID,
      'X-FB-LSD': LSD,
      'X-ASBD-ID': '129477',
      'Sec-Fetch-Site': 'same-origin',
      Referer: `https://www.instagram.com/p/${code}/`,
    },
    body,
  });
  if (!res.ok) throw new Error(`Instagram GraphQL HTTP ${res.status}`);
  const data = await res.json();
  return parseMedia(data?.data?.xdt_shortcode_media);
}

function unescapeJson(s) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
  }
}

// Страница встраивания: в ней бывает video_url (для роликов) и картинка поста.
export function parseEmbed(html) {
  // JSON внутри страницы бывает экранирован дважды: \"video_url\":\"https:\\/\\/…\"
  const decoded = html.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
  const video = /"video_url":"([^"]+)"/.exec(decoded);
  if (video) return { title: null, author: null, items: [{ type: 'video', url: unescapeJson(video[1]) }] };
  const img = /class="EmbeddedMediaImage"[^>]*src="([^"]+)"/.exec(html);
  if (img) return { title: null, author: null, items: [{ type: 'photo', url: img[1].replace(/&amp;/g, '&') }] };
  return null;
}

async function viaEmbed(code) {
  const res = await fetch(`https://www.instagram.com/p/${code}/embed/captioned/`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`Instagram embed HTTP ${res.status}`);
  return parseEmbed(await res.text());
}

// Открытые зеркала InstaFix (github.com/Wikidepia/InstaFix): отдают страницу с
// og:video / og:image для превью в мессенджерах, а /videos/… ведёт прямо на файл.
const INSTAFIX_HOSTS = ['kkinstagram.com', 'vxinstagram.com', 'uuinstagram.com', 'ddinstagram.com', 'instagramez.com'];

function metaContent(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i');
  const alt = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i');
  const m = re.exec(html) || alt.exec(html);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

export function parseInstafix(html, host) {
  const abs = (u) => (u && u.startsWith('/') ? `https://${host}${u}` : u);
  const video = abs(metaContent(html, 'og:video') || metaContent(html, 'og:video:secure_url') || metaContent(html, 'twitter:player:stream'));
  const image = abs(metaContent(html, 'og:image'));
  const title = metaContent(html, 'og:description') || null;
  if (video) return { title, author: null, items: [{ type: 'video', url: video }] };
  if (image) return { title, author: null, items: [{ type: 'photo', url: image }] };
  return null;
}

async function viaInstafix(code) {
  for (const host of INSTAFIX_HOSTS) {
    try {
      const res = await fetch(`https://${host}/p/${code}/`, {
        // зеркала отдают метатеги только «ботам-превьюшникам»
        headers: { 'User-Agent': 'TelegramBot (like TwitterBot)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const post = parseInstafix(await res.text(), host);
      if (post) return post;
    } catch (e) {
      console.warn(`InstaFix ${host}:`, e?.message);
    }
  }
  return null;
}

export async function fetchInstagram(url) {
  let code = instagramShortcode(url);
  if (!code) {
    // короткие ссылки вида instagram.com/share/… ведут редиректом на пост
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      code = instagramShortcode(res.url);
    } catch {
      // ниже — понятная ошибка
    }
  }
  if (!code) throw new DownloadError('Не понял ссылку на Instagram — пришлите ссылку на пост или Reels.');

  for (const attempt of [viaGraphql, viaEmbed, viaInstafix]) {
    try {
      const post = await attempt(code);
      if (post) return { ...post, source: `instagram:${code}` };
    } catch (e) {
      console.warn('Instagram:', e?.message);
    }
  }
  throw new DownloadError('Instagram не отдал этот пост: он закрытый, удалён или Instagram ограничил доступ с сервера.');
}
