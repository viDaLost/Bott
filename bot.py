"""Универсальный бот: видео с YouTube/Instagram/TikTok + поиск и скачивание музыки."""
import asyncio
import html
import logging
import re
import shutil
import time
import uuid
from collections import OrderedDict

from aiogram import BaseMiddleware, Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer
from aiogram.enums import ChatAction, ParseMode
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import (
    CallbackQuery,
    FSInputFile,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
)
from aiohttp import web

import config
from downloader import (
    URL_RE,
    DownloadError,
    download_audio,
    download_video,
    is_busy,
    search_youtube,
)
from music import genius_search, recognize_file, shazam_available

log = logging.getLogger("bott")
router = Router()


# ------------------------------------------------------------------ утилиты

class TTLCache:
    """callback_data в Telegram ограничена 64 байтами, поэтому ссылки храним тут."""

    def __init__(self, maxsize: int = 5000, ttl: int = 6 * 3600):
        self.maxsize, self.ttl = maxsize, ttl
        self._data: OrderedDict[str, tuple[float, str]] = OrderedDict()

    def put(self, value: str) -> str:
        key = uuid.uuid4().hex[:12]
        self._data[key] = (time.monotonic(), value)
        while len(self._data) > self.maxsize:
            self._data.popitem(last=False)
        return key

    def get(self, key: str) -> str | None:
        item = self._data.get(key)
        if not item:
            return None
        ts, value = item
        if time.monotonic() - ts > self.ttl:
            self._data.pop(key, None)
            return None
        return value


cache = TTLCache()


def fmt_duration(sec) -> str:
    if not sec:
        return ""
    sec = int(sec)
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def short(text: str | None, n: int) -> str:
    text = (text or "").strip()
    return text if len(text) <= n else text[: n - 1] + "…"


def safe_filename(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\n\r\t]+', " ", name).strip()
    return short(name, 80) or "file"


def kb(rows: list[list[tuple[str, str]]]) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text=t, callback_data=d) for t, d in row] for row in rows]
    )


# ------------------------------------------------------------------ доступ

class AccessMiddleware(BaseMiddleware):
    async def __call__(self, handler, event, data):
        if config.ALLOWED_USERS:
            user = data.get("event_from_user")
            if not user or user.id not in config.ALLOWED_USERS:
                if isinstance(event, CallbackQuery):
                    await event.answer("⛔ Доступ закрыт", show_alert=True)
                elif isinstance(event, Message):
                    await event.answer(f"⛔ Доступ закрыт. Ваш ID: <code>{user.id if user else '?'}</code>")
                return None
        return await handler(event, data)


router.message.outer_middleware(AccessMiddleware())
router.callback_query.outer_middleware(AccessMiddleware())


# ------------------------------------------------------------------ команды

def help_text() -> str:
    lines = [
        "👋 <b>Привет! Я умею:</b>",
        "",
        "🎬 <b>Скачивать видео</b> — пришлите ссылку на YouTube, Instagram, TikTok "
        "(и многие другие сайты), затем выберите «Видео» или «Аудио MP3».",
        "",
        "🎵 <b>Искать музыку по названию</b> — просто напишите название песни "
        "или используйте <code>/music название</code>.",
    ]
    if config.GENIUS_TOKEN:
        lines += ["", "📝 <b>Искать по строчке из песни</b> — <code>/lyrics фрагмент текста</code>."]
    if shazam_available():
        lines += ["", "🎧 <b>Распознавать музыку</b> — пришлите голосовое, кружок или аудио с песней."]
    lines += ["", f"Лимит файла: {config.MAX_FILE_MB} МБ."]
    return "\n".join(lines)


@router.message(CommandStart())
@router.message(Command("help"))
async def cmd_start(message: Message):
    await message.answer(help_text(), disable_web_page_preview=True)


@router.message(Command("music"))
async def cmd_music(message: Message, command: CommandObject):
    if not command.args:
        await message.answer("Напишите так: <code>/music исполнитель название</code>")
        return
    await do_search(message, command.args)


@router.message(Command("lyrics"))
async def cmd_lyrics(message: Message, command: CommandObject):
    if not config.GENIUS_TOKEN:
        await message.answer("Поиск по тексту не настроен: добавьте GENIUS_TOKEN в переменные окружения.")
        return
    if not command.args:
        await message.answer("Напишите так: <code>/lyrics строчка из песни</code>")
        return

    status = await message.answer("🔎 Ищу песню по фрагменту текста…")
    try:
        hits = await genius_search(command.args)
    except Exception:
        log.exception("Genius search failed")
        await status.edit_text("Не удалось выполнить поиск, попробуйте позже.")
        return
    if not hits:
        await status.edit_text("Ничего не нашёл 😕 Попробуйте другой фрагмент.")
        return

    rows = []
    for h in hits:
        query = f"{h['artist']} - {h['title']}"
        rows.append([(short(query, 60), f"a:{cache.put('ytsearch1:' + query)}")])
    await status.edit_text("Возможно, это одна из этих песен 👇", reply_markup=kb(rows))


# ------------------------------------------------------------------ ссылки и поиск

@router.message(F.text.regexp(URL_RE))
async def on_link(message: Message):
    url = URL_RE.search(message.text).group(0)
    key = cache.put(url)
    await message.reply(
        "Что скачать?",
        reply_markup=kb([[("🎬 Видео", f"v:{key}"), ("🎵 Аудио MP3", f"a:{key}")]]),
    )


@router.message(F.text & ~F.text.startswith("/"))
async def on_text(message: Message):
    await do_search(message, message.text.strip())


async def do_search(message: Message, query: str):
    status = await message.answer(f"🔎 Ищу: <i>{html.escape(short(query, 100))}</i>")
    try:
        results = await search_youtube(query, 6)
    except Exception:
        log.exception("Search failed")
        await status.edit_text("Не удалось выполнить поиск, попробуйте позже.")
        return
    if not results:
        await status.edit_text("Ничего не найдено 😕")
        return

    rows = []
    for r in results:
        label = short(r["title"], 48)
        if d := fmt_duration(r["duration"]):
            label = f"{label} · {d}"
        rows.append([(label, f"a:{cache.put(r['url'])}")])
    await status.edit_text("Выберите трек 👇", reply_markup=kb(rows))


# ------------------------------------------------------------------ распознавание

@router.message(F.voice | F.audio | F.video_note)
async def on_voice(message: Message, bot: Bot):
    if not shazam_available():
        await message.reply("Распознавание музыки не установлено на сервере.")
        return

    media = message.voice or message.audio or message.video_note
    if media.file_size and media.file_size > 20 * 1024 * 1024 and not config.BOT_API_URL:
        await message.reply("Файл слишком большой для распознавания (максимум 20 МБ).")
        return

    status = await message.reply("🎧 Слушаю…")
    workdir = config.DOWNLOAD_DIR / uuid.uuid4().hex
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        src = workdir / "input"
        await bot.download(media, destination=src)
        track = await recognize_file(src, workdir)
    except Exception:
        log.exception("Recognition failed")
        track = None
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    if not track or not track["title"]:
        await status.edit_text("Не удалось распознать трек 😕")
        return

    query = f"{track['artist']} - {track['title']}".strip(" -")
    await status.edit_text(
        f"Похоже, это <b>{html.escape(query)}</b>",
        reply_markup=kb([[("⬇️ Скачать MP3", f"a:{cache.put('ytsearch1:' + query)}")]]),
    )


# ------------------------------------------------------------------ скачивание

@router.callback_query(F.data.regexp(r"^[va]:"))
async def on_download(call: CallbackQuery, bot: Bot):
    kind, key = call.data.split(":", 1)
    target = cache.get(key)
    if not target:
        await call.answer("Кнопка устарела — отправьте ссылку или запрос заново.", show_alert=True)
        return
    await call.answer()

    chat_id = call.message.chat.id
    queued = is_busy()
    status = await bot.send_message(chat_id, "⏳ В очереди…" if queued else "⏳ Скачиваю…")

    action = ChatAction.UPLOAD_VIDEO if kind == "v" else ChatAction.UPLOAD_DOCUMENT
    stop = asyncio.Event()

    async def keep_action():
        while not stop.is_set():
            try:
                await bot.send_chat_action(chat_id, action)
            except Exception:
                pass
            try:
                await asyncio.wait_for(stop.wait(), 4.5)
            except asyncio.TimeoutError:
                pass

    action_task = asyncio.create_task(keep_action())
    result = None
    try:
        if kind == "v":
            result = await download_video(target)
            await status.edit_text("📤 Отправляю…")
            await bot.send_video(
                chat_id,
                FSInputFile(result.path, filename=safe_filename(result.title) + result.path.suffix),
                caption=html.escape(short(result.title, 900)),
                duration=result.duration,
                width=result.width,
                height=result.height,
                supports_streaming=True,
            )
        else:
            result = await download_audio(target)
            await status.edit_text("📤 Отправляю…")
            await bot.send_audio(
                chat_id,
                FSInputFile(result.path, filename=safe_filename(result.title) + ".mp3"),
                title=short(result.title, 64),
                performer=short(result.performer, 64) or None,
                duration=result.duration,
            )
        await status.delete()
    except DownloadError as e:
        await status.edit_text("❌ " + html.escape(str(e)))
    except Exception:
        log.exception("Download/send failed for %s", target)
        await status.edit_text("❌ Что-то пошло не так. Попробуйте позже.")
    finally:
        stop.set()
        await action_task
        if result:
            result.cleanup()


# ------------------------------------------------------------------ запуск

async def health(_request):
    return web.Response(text="ok")


async def start_health_server():
    app = web.Application()
    app.router.add_get("/", health)
    app.router.add_get("/health", health)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", config.PORT).start()
    log.info("Health-check слушает порт %s", config.PORT)


def cleanup_tmp():
    for p in config.DOWNLOAD_DIR.iterdir():
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)


async def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    if not config.BOT_TOKEN:
        raise SystemExit("Переменная окружения BOT_TOKEN не задана")

    cleanup_tmp()

    session_kwargs = {"timeout": 900}
    if config.BOT_API_URL:
        session_kwargs["api"] = TelegramAPIServer.from_base(config.BOT_API_URL)
    bot = Bot(
        config.BOT_TOKEN,
        session=AiohttpSession(**session_kwargs),
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )
    dp = Dispatcher()
    dp.include_router(router)

    await start_health_server()
    await bot.delete_webhook(drop_pending_updates=True)
    me = await bot.get_me()
    log.info("Бот @%s запущен. Cookies: %s, прокси: %s", me.username,
             "да" if config.COOKIES_FILE else "нет", "да" if config.PROXY else "нет")
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
