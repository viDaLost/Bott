"""Скачивание видео и аудио через yt-dlp (YouTube, Instagram, TikTok и сотни других сайтов)."""
import asyncio
import logging
import re
import shutil
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path

import yt_dlp

import config

log = logging.getLogger(__name__)

URL_RE = re.compile(r"https?://[^\s<>\"']+")
VIDEO_HEIGHTS = (720, 480, 360, 240)  # «лестница» качества, чтобы уложиться в лимит размера
AUDIO_FALLBACK_BITRATES = (128, 96, 64, 48)

_sem = asyncio.Semaphore(config.MAX_PARALLEL)


class DownloadError(Exception):
    """Ошибка с текстом, который можно показать пользователю."""


@dataclass
class Result:
    path: Path
    workdir: Path
    title: str
    performer: str | None = None
    duration: int | None = None
    width: int | None = None
    height: int | None = None

    def cleanup(self) -> None:
        shutil.rmtree(self.workdir, ignore_errors=True)


class _YtdlLogger:
    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        log.debug("yt-dlp: %s", msg)

    def error(self, msg):
        log.warning("yt-dlp: %s", msg)


def is_busy() -> bool:
    return _sem.locked()


def _new_workdir() -> Path:
    workdir = config.DOWNLOAD_DIR / uuid.uuid4().hex
    workdir.mkdir(parents=True, exist_ok=True)
    return workdir


def _base_opts(workdir: Path | None) -> dict:
    opts = {
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "logger": _YtdlLogger(),
        "restrictfilenames": True,
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 3,
        "concurrent_fragment_downloads": 1,
        "cachedir": False,
    }
    if workdir is not None:
        opts["outtmpl"] = str(workdir / "%(id)s.%(ext)s")
    if config.COOKIES_FILE:
        opts["cookiefile"] = config.COOKIES_FILE
    if config.PROXY:
        opts["proxy"] = config.PROXY
    return opts


def _humanize(err: Exception) -> str:
    text = str(err)
    low = text.lower()
    if "not a bot" in low or "sign in to confirm" in low or "403" in low:
        return "YouTube заблокировал запрос с сервера. Нужны cookies или прокси (см. README)."
    if "login" in low or "cookies" in low or "rate-limit" in low:
        return "Сайт требует авторизацию. Добавьте cookies (см. README)."
    if "unsupported url" in low:
        return "Эта ссылка не поддерживается."
    if "private" in low:
        return "Видео приватное или недоступно."
    if "unavailable" in low or "not available" in low or "removed" in low:
        return "Видео недоступно (удалено или закрыто в регионе сервера)."
    first_line = text.replace("ERROR: ", "").splitlines()[0] if text else "неизвестная ошибка"
    return "Не удалось скачать: " + first_line[:300]


def _first_entry(info: dict | None) -> dict:
    if not info:
        raise DownloadError("Ничего не найдено.")
    if "entries" in info:
        entries = [e for e in (info.get("entries") or []) if e]
        if not entries:
            raise DownloadError("Ничего не найдено.")
        return entries[0]
    return info


def _pick_file(workdir: Path, exts: tuple[str, ...]) -> Path | None:
    files = [p for p in workdir.iterdir() if p.is_file() and p.suffix.lower() in exts]
    return max(files, key=lambda p: p.stat().st_size) if files else None


def _video_format(h: int) -> str:
    # avc1 + m4a — лучше всего воспроизводится прямо в Telegram
    return (
        f"bv*[height<=?{h}][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/"
        f"bv*[height<=?{h}]+ba/"
        f"b[height<=?{h}][ext=mp4]/"
        f"b[height<=?{h}]/"
        f"b"
    )


# ---------------------------------------------------------------- видео

def _download_video_sync(url: str) -> Result:
    limit = config.MAX_FILE_MB * 1024 * 1024

    try:
        with yt_dlp.YoutubeDL(_base_opts(None) | {"skip_download": True}) as ydl:
            meta = _first_entry(ydl.extract_info(url, download=False))
    except yt_dlp.utils.DownloadError as e:
        raise DownloadError(_humanize(e)) from e

    duration = meta.get("duration")
    if config.MAX_DURATION and duration and duration > config.MAX_DURATION:
        raise DownloadError("Видео слишком длинное.")

    for height in VIDEO_HEIGHTS:
        workdir = _new_workdir()
        opts = _base_opts(workdir) | {
            "format": _video_format(height),
            "merge_output_format": "mp4",
            "max_filesize": limit,
        }
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = _first_entry(ydl.extract_info(url, download=True))
        except yt_dlp.utils.DownloadError as e:
            shutil.rmtree(workdir, ignore_errors=True)
            raise DownloadError(_humanize(e)) from e

        path = _pick_file(workdir, (".mp4", ".mkv", ".webm", ".mov"))
        if path and path.stat().st_size <= limit:
            return Result(
                path=path,
                workdir=workdir,
                title=info.get("title") or "video",
                duration=int(info["duration"]) if info.get("duration") else None,
                width=info.get("width"),
                height=info.get("height"),
            )
        shutil.rmtree(workdir, ignore_errors=True)
        log.info("Файл больше лимита в %sp, пробую качество ниже", height)

    raise DownloadError(f"Видео больше {config.MAX_FILE_MB} МБ даже в минимальном качестве.")


# ---------------------------------------------------------------- аудио

def _download_audio_sync(target: str) -> Result:
    """target — ссылка или поисковый запрос вида 'ytsearch1:исполнитель - название'."""
    limit = config.MAX_FILE_MB * 1024 * 1024
    workdir = _new_workdir()
    opts = _base_opts(workdir) | {
        "format": "bestaudio/best",
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"},
            {"key": "FFmpegMetadata", "add_metadata": True},
        ],
    }
    if config.MAX_DURATION:
        opts["match_filter"] = yt_dlp.utils.match_filter_func(f"duration <=? {config.MAX_DURATION}")

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = _first_entry(ydl.extract_info(target, download=True))
    except DownloadError:
        shutil.rmtree(workdir, ignore_errors=True)
        raise
    except yt_dlp.utils.DownloadError as e:
        shutil.rmtree(workdir, ignore_errors=True)
        raise DownloadError(_humanize(e)) from e

    path = _pick_file(workdir, (".mp3",))
    if not path:
        shutil.rmtree(workdir, ignore_errors=True)
        raise DownloadError("Не удалось получить аудио (возможно, запись слишком длинная).")

    duration = int(info["duration"]) if info.get("duration") else None

    if path.stat().st_size > limit:
        path = _shrink_mp3(path, workdir, duration, limit)

    return Result(
        path=path,
        workdir=workdir,
        title=info.get("track") or info.get("title") or "audio",
        performer=info.get("artist") or info.get("uploader") or info.get("channel"),
        duration=duration,
    )


def _shrink_mp3(path: Path, workdir: Path, duration: int | None, limit: int) -> Path:
    """Пережимает mp3 в меньший битрейт, чтобы влезть в лимит Telegram."""
    if not duration:
        shutil.rmtree(workdir, ignore_errors=True)
        raise DownloadError("Аудио слишком большое для отправки.")
    need_kbps = int(limit * 8 / duration / 1000 * 0.93)
    bitrate = next((b for b in AUDIO_FALLBACK_BITRATES if b <= need_kbps), None)
    if not bitrate:
        shutil.rmtree(workdir, ignore_errors=True)
        raise DownloadError("Аудио слишком длинное для отправки в Telegram.")

    out = workdir / "compressed.mp3"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(path),
             "-map_metadata", "0", "-b:a", f"{bitrate}k", str(out)],
            check=True, timeout=900,
        )
    except (subprocess.SubprocessError, OSError) as e:
        shutil.rmtree(workdir, ignore_errors=True)
        raise DownloadError("Не удалось сжать аудио.") from e

    path.unlink(missing_ok=True)
    if out.stat().st_size > limit:
        shutil.rmtree(workdir, ignore_errors=True)
        raise DownloadError("Аудио слишком большое для отправки.")
    return out


# ---------------------------------------------------------------- поиск

def _search_sync(query: str, limit: int) -> list[dict]:
    opts = _base_opts(None) | {"skip_download": True, "extract_flat": "in_playlist"}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    results = []
    for e in (info or {}).get("entries") or []:
        if not e or not e.get("id"):
            continue
        results.append({
            "title": e.get("title") or "Без названия",
            "duration": e.get("duration"),
            "channel": e.get("channel") or e.get("uploader"),
            "url": e.get("url") if str(e.get("url", "")).startswith("http")
            else f"https://www.youtube.com/watch?v={e['id']}",
        })
    return results


# ---------------------------------------------------------------- async-обёртки

async def download_video(url: str) -> Result:
    async with _sem:
        return await asyncio.to_thread(_download_video_sync, url)


async def download_audio(target: str) -> Result:
    async with _sem:
        return await asyncio.to_thread(_download_audio_sync, target)


async def search_youtube(query: str, limit: int = 6) -> list[dict]:
    return await asyncio.to_thread(_search_sync, query, limit)
