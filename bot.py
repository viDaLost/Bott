"""Универсальный бот: видео с YouTube/Instagram/TikTok + поиск и скачивание музыки."""
import asyncio
import html
import logging
import re
import shutil
import uuid

from aiogram import BaseMiddleware, Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer
from aiogram.enums import ChatAction, ParseMode
from aiogram.exceptions import TelegramBadRequest, TelegramRetryAfter
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
    Cancelled,
    DownloadError,
    Job,
    download_audio,
    download_video,
    probe,
    search_youtube,
    source_ids,
)
from music import genius_search, recognize_file, shazam_available
from storage import db

log = logging.getLogger("bott")
router = Router()


# ------------------------------------------------------------------ утилиты

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
        rows.append([(short(query, 60), f"a:{db.put('ytsearch1:' + query)}")])
    await status.edit_text("Возможно, это одна из этих песен 👇", reply_markup=kb(rows))


# ------------------------------------------------------------------ ссылки и поиск

@router.message(F.text.regexp(URL_RE))
async def on_link(message: Message):
    url = URL_RE.search(message.text).group(0)
    key = db.put(url)
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
        rows.append([(label, f"a:{db.put(r['url'])}")])
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
        reply_markup=kb([[("⬇️ Скачать MP3", f"a:{db.put('ytsearch1:' + query)}")]]),
    )


# ------------------------------------------------------------------ скачивание

jobs: dict[str, Job] = {}

PHASE_TEXT = {
    "probing": "🔎 Получаю информацию…",
    "starting": "⬇️ Начинаю загрузку…",
    "processing": "⚙️ Обрабатываю…",
    "uploading": "📤 Отправляю…",
}


def fmt_mb(size: float) -> str:
    return f"{size / 2**20:.1f}"


def render_status(job: Job) -> str:
    if job.cancelled:
        return "⏳ Отменяю…"
    if job.phase == "queued":
        ahead = sum(1 for j in jobs.values() if j.phase == "queued" and j.created < job.created)
        return f"⏳ В очереди, перед вами: {ahead}" if ahead else "⏳ В очереди…"
    if job.phase != "downloading":
        return PHASE_TEXT.get(job.phase, "⏳ Подождите…")

    head = "⬇️ Скачиваю" + (f" (часть {job.part})" if job.part > 1 else "")
    if job.total:
        pct = min(job.downloaded / job.total, 1)
        filled = round(pct * 10)
        line = f"{'▓' * filled}{'░' * (10 - filled)} {pct:.0%}\n{fmt_mb(job.downloaded)} / {fmt_mb(job.total)} МБ"
    else:
        line = f"{fmt_mb(job.downloaded)} МБ"
    if job.speed:
        line += f" · {fmt_mb(job.speed)} МБ/с"
    return f"{head}\n{line}"


def cancel_kb(job: Job) -> InlineKeyboardMarkup | None:
    if job.phase == "uploading" or job.cancelled:
        return None
    return kb([[("✖️ Отмена", f"c:{job.id}")]])


async def show_progress(bot: Bot, status: Message, job: Job, action: ChatAction, stop: asyncio.Event):
    """Раз в 3 секунды обновляет сообщение со статусом и показывает «отправляет файл…»."""
    last = render_status(job)  # с этим текстом сообщение уже отправлено
    while True:
        try:
            await asyncio.wait_for(stop.wait(), 3)
            return
        except asyncio.TimeoutError:
            pass
        text = render_status(job)
        try:
            if job.phase not in ("queued", "probing"):
                await bot.send_chat_action(status.chat.id, action)
            if text != last:
                await status.edit_text(text, reply_markup=cancel_kb(job))
                last = text
        except TelegramRetryAfter as e:
            await asyncio.sleep(e.retry_after)
        except Exception:
            pass


async def send_cached(bot: Bot, chat_id: int, kind: str, sources: list[str]) -> bool:
    """Если этот файл уже отправлялся, пересылает его по file_id без скачивания."""
    hit = db.get_file(sources, kind)
    if not hit:
        return False
    file_id, title = hit
    try:
        if kind == "v":
            await bot.send_video(
                chat_id, file_id,
                caption=html.escape(short(title, 900)) if title else None,
                supports_streaming=True,
            )
        else:
            await bot.send_audio(chat_id, file_id)
    except TelegramBadRequest as e:
        # например, бот пересоздан с другим токеном — file_id больше не действует
        log.warning("file_id из кэша не подошёл (%s), скачиваю заново", e)
        db.forget_file(file_id)
        return False
    db.save_file(sources, kind, file_id, title)  # запоминаем и новые варианты ссылки
    return True


async def fetch_and_send(bot: Bot, chat_id: int, job: Job, kind: str, target: str) -> None:
    meta = await probe(target, job)
    sources = [target, *source_ids(meta)]
    if await send_cached(bot, chat_id, kind, sources):
        return

    result = await (download_video(meta, job) if kind == "v" else download_audio(meta, job))
    try:
        job.check()
        job.phase = "uploading"
        thumb = FSInputFile(result.thumb) if result.thumb else None
        if kind == "v":
            msg = await bot.send_video(
                chat_id,
                FSInputFile(result.path, filename=safe_filename(result.title) + result.path.suffix),
                caption=html.escape(short(result.title, 900)),
                duration=result.duration,
                width=result.width,
                height=result.height,
                thumbnail=thumb,
                supports_streaming=True,
            )
            sent = msg.video or msg.document
        else:
            msg = await bot.send_audio(
                chat_id,
                FSInputFile(result.path, filename=safe_filename(result.title) + ".mp3"),
                title=short(result.title, 64),
                performer=short(result.performer, 64) or None,
                duration=result.duration,
                thumbnail=thumb,
            )
            sent = msg.audio or msg.document
        if sent:
            db.save_file(sources, kind, sent.file_id, result.title)
    finally:
        result.cleanup()


@router.callback_query(F.data.regexp(r"^[va]:"))
async def on_download(call: CallbackQuery, bot: Bot):
    kind, key = call.data.split(":", 1)
    target = db.get(key)
    if not target:
        await call.answer("Кнопка устарела — отправьте ссылку или запрос заново.", show_alert=True)
        return
    await call.answer()

    chat_id = call.message.chat.id
    if await send_cached(bot, chat_id, kind, [target]):
        return

    job = Job(call.from_user.id)
    jobs[job.id] = job
    status = await bot.send_message(chat_id, render_status(job), reply_markup=cancel_kb(job))
    action = ChatAction.UPLOAD_VIDEO if kind == "v" else ChatAction.UPLOAD_DOCUMENT
    stop = asyncio.Event()
    progress = asyncio.create_task(show_progress(bot, status, job, action, stop))
    job.task = asyncio.create_task(fetch_and_send(bot, chat_id, job, kind, target))

    outcome = None
    try:
        await job.task
    except Cancelled:
        outcome = "🚫 Загрузка отменена."
    except asyncio.CancelledError:
        if not job.cancelled:
            raise
        outcome = "🚫 Загрузка отменена."
    except DownloadError as e:
        outcome = "❌ " + html.escape(str(e))
    except Exception:
        log.exception("Download/send failed for %s", target)
        outcome = "❌ Что-то пошло не так. Попробуйте позже."
    finally:
        stop.set()
        await progress
        jobs.pop(job.id, None)

    try:
        if outcome:
            await status.edit_text(outcome)
        else:
            await status.delete()
    except TelegramBadRequest:
        pass


@router.callback_query(F.data.startswith("c:"))
async def on_cancel(call: CallbackQuery):
    job = jobs.get(call.data[2:])
    if not job:
        await call.answer("Загрузка уже завершена.")
        return
    if call.from_user.id != job.user_id:
        await call.answer("Отменить может только тот, кто запустил загрузку.", show_alert=True)
        return
    if job.phase == "uploading":
        await call.answer("Файл уже отправляется — отменить нельзя.")
        return
    job.cancel()
    # Пока ждём очереди, поток ещё не запущен — задачу можно просто прервать
    if job.phase == "queued" and job.task:
        job.task.cancel()
    await call.answer("Отменяю…")


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
