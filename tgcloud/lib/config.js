// Настройки бота. В Telegram Serverless нет переменных окружения, поэтому
// несекретные параметры лежат здесь, а токены сторонних сервисов владелец
// задаёт прямо в чате командой /set (они хранятся в базе, см. lib/settings.js).

// Telegram ID владельцев: им доступны /set, /allow, /deny, /setup и /stats.
// Узнать свой ID — команда /id у этого бота.
export const OWNER_IDS = [1288379477];

// Кому разрешён бот (ID через запятую). Пусто и в базе никого не добавлено
// командой /allow — бот доступен всем. Владельцам доступ открыт всегда.
export const ALLOWED_USERS = [];

// Максимальный размер отправляемого файла. Bot API принимает до 50 МБ,
// а файл целиком проходит через память изолята — больше ставить нельзя.
export const MAX_FILE_MB = 49;

// Максимальная длительность ролика/трека в секундах (0 — без ограничения).
export const MAX_DURATION = 3 * 3600;

// Сколько загрузок один пользователь может запускать одновременно.
export const MAX_ACTIVE_PER_USER = 2;

// Загрузка, которая не закончилась за это время, считается оборвавшейся
// (например, платформа остановила обработчик) и не мешает новым.
export const JOB_STALE_SEC = 15 * 60;

// Лестница качества: если видео не влезает в лимит, пробуем ниже.
export const VIDEO_QUALITIES = ['720', '480', '360', '240'];
// То же для MP3 (кбит/с).
export const AUDIO_BITRATES = ['128', '96', '64'];

// Адрес cobalt по умолчанию; обычно его задают из чата: /set cobalt_url https://…
// Для YouTube, Instagram, VK и других сайтов, кроме TikTok, нужен cobalt:
// https://github.com/imputnet/cobalt — свой сервер или чужой с API-ключом.
export const DEFAULT_COBALT_URL = '';

// Сколько живут записи в базе.
export const KEY_TTL_SEC = 30 * 24 * 3600; // кнопки
export const FILE_TTL_SEC = 180 * 24 * 3600; // кэш file_id
export const SEARCH_TTL_SEC = 2 * 3600; // результаты поиска для листания
export const UPDATE_TTL_SEC = 24 * 3600; // защита от повторной доставки апдейтов

// Поиск музыки
export const PAGE_SIZE = 8;
export const MAX_RESULTS = 200;
