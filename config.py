"""Настройки бота. Всё берётся из переменных окружения (или файла .env)."""
import base64
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _int_set(value: str) -> set[int]:
    return {int(x) for x in value.replace(" ", "").split(",") if x}


# --- Обязательные ---
BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()

# --- Необязательные ---
# Список Telegram ID через запятую. Пусто = бот доступен всем.
ALLOWED_USERS = _int_set(os.getenv("ALLOWED_USERS", ""))

# Токен Genius API для поиска песни по фрагменту текста (https://genius.com/api-clients)
GENIUS_TOKEN = os.getenv("GENIUS_TOKEN", "").strip()

# Адрес своего Local Bot API Server (снимает лимит 50 МБ). Пусто = обычный api.telegram.org
BOT_API_URL = os.getenv("BOT_API_URL", "").strip()

# Максимальный размер отправляемого файла в МБ
MAX_FILE_MB = int(os.getenv("MAX_FILE_MB", "1900" if BOT_API_URL else "49"))

# Максимальная длительность ролика/трека в секундах (0 = без ограничения)
MAX_DURATION = int(os.getenv("MAX_DURATION", "10800"))

# Сколько загрузок выполнять одновременно (на 1 ГБ RAM больше 2 ставить не стоит)
MAX_PARALLEL = int(os.getenv("MAX_PARALLEL", "2"))

# Порт для health-check (App Platform проверяет, что приложение отвечает)
PORT = int(os.getenv("PORT", "8080"))

# Прокси для yt-dlp, например socks5://user:pass@host:1080
PROXY = os.getenv("PROXY", "").strip() or None

# Временная папка для загрузок
DOWNLOAD_DIR = Path(os.getenv("DOWNLOAD_DIR", "/tmp/bott"))
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)


def _prepare_cookies() -> str | None:
    """Cookies нужны YouTube/Instagram, если они блокируют IP сервера.

    Можно указать путь к файлу (COOKIES_FILE) или положить содержимое
    cookies.txt в base64 в переменную COOKIES_B64 — удобно для App Platform.
    """
    path = os.getenv("COOKIES_FILE", "").strip()
    if path and Path(path).exists():
        return path
    b64 = os.getenv("COOKIES_B64", "").strip()
    if b64:
        target = DOWNLOAD_DIR / "cookies.txt"
        target.write_bytes(base64.b64decode(b64))
        return str(target)
    return None


COOKIES_FILE = _prepare_cookies()
