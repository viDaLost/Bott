"""Запасной путь для TikTok через публичный сервис tikwm.com.

TikTok часто блокирует IP дата-центров (ошибка «Your IP address is blocked»),
и yt-dlp с сервера ничего скачать не может. TikWM скачивает TikTok со своих
серверов и отдаёт прямые ссылки: видео без водяного знака, фото из каруселей
и звук. Бесплатный лимит — примерно 1 запрос в секунду.
"""
import asyncio
import logging
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

import aiohttp

import config
from downloader import (
    Cancelled,
    DownloadError,
    Job,
    Result,
    _embed_cover,
    _ffmpeg,
    _make_thumb,
    _new_workdir,
    queue_slot,
)

log = logging.getLogger(__name__)

API_URL = "https://www.tikwm.com/api/"
BASE_URL = "https://www.tikwm.com"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/136.0 Safari/537.36"
)
MIN_INTERVAL = 1.1  # бесплатный лимит TikWM — 1 запрос в секунду
MAX_PHOTOS = 30

_api_lock = asyncio.Lock()
_last_call = 0.0


def is_tiktok(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host == "tiktok.com" or host.endswith(".tiktok.com")


@dataclass
class Post:
    id: str
    title: str
    author: str
    duration: int | None
    cover: str | None
    video: str | None  # без водяного знака
    video_size: int | None
    hd_video: str | None
    hd_size: int | None
    music: str | None
    music_title: str | None
    music_author: str | None
    music_cover: str | None
    images: list[str] = field(default_factory=list)

    @property
    def source(self) -> str:
        # тот же формат, что у yt-dlp (extractor_key:id), чтобы кэш file_id был общим
        return f"TikTok:{self.id}"


@dataclass
class Album:
    paths: list[Path]
    workdir: Path
    caption: str

    def cleanup(self) -> None:
        shutil.rmtree(self.workdir, ignore_errors=True)


def _abs(url: str | None) -> str | None:
    if not url:
        return None
    return BASE_URL + url if url.startswith("/") else url


def _session() -> aiohttp.ClientSession:
    return aiohttp.ClientSession(
        timeout=aiohttp.ClientTimeout(total=None, sock_connect=20, sock_read=60),
        headers={"User-Agent": USER_AGENT},
    )


def parse_post(data: dict) -> Post:
    music_info = data.get("music_info") or {}
    author = data.get("author") or {}
    return Post(
        id=str(data.get("id") or ""),
        title=(data.get("title") or "").strip() or "TikTok",
        author=author.get("nickname") or author.get("unique_id") or "",
        duration=int(data["duration"]) if data.get("duration") else None,
        cover=_abs(data.get("origin_cover") or data.get("cover")),
        video=_abs(data.get("play")),
        video_size=data.get("size") or None,
        hd_video=_abs(data.get("hdplay")),
        hd_size=data.get("hd_size") or None,
        music=_abs(data.get("music") or music_info.get("play")),
        music_title=music_info.get("title"),
        music_author=music_info.get("author"),
        music_cover=_abs(music_info.get("cover")),
        images=[_abs(u) for u in (data.get("images") or []) if u],
    )


async def fetch_post(url: str) -> Post:
    """Спрашивает у TikWM информацию о посте (с учётом лимита 1 запрос/с)."""
    global _last_call
    async with _session() as session:
        for attempt in range(3):
            async with _api_lock:
                wait = _last_call + MIN_INTERVAL - time.monotonic()
                if wait > 0:
                    await asyncio.sleep(wait)
                try:
                    async with session.get(API_URL, params={"url": url, "hd": "1"}) as resp:
                        data = await resp.json(content_type=None)
                except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as e:
                    log.warning("TikWM недоступен: %r", e)
                    raise DownloadError("Запасной сервис TikWM сейчас недоступен.") from e
                finally:
                    _last_call = time.monotonic()

            if data.get("code") == 0 and data.get("data"):
                return parse_post(data["data"])
            msg = str(data.get("msg") or "неизвестная ошибка")
            if "limit" in msg.lower() and attempt < 2:
                continue  # упёрлись в лимит — следующая попытка после паузы
            log.warning("TikWM ответил ошибкой: %s", msg)
            raise DownloadError(f"TikWM не смог получить пост: {msg}")
    raise DownloadError("TikWM перегружен, попробуйте через минуту.")


async def _download(session: aiohttp.ClientSession, url: str, dest: Path, job: Job,
                    limit: int, track_progress: bool = True) -> Path:
    async with session.get(url) as resp:
        if resp.status >= 400:
            raise DownloadError(f"Не удалось скачать файл из TikTok (HTTP {resp.status}).")
        total = resp.content_length
        if total and total > limit:
            raise DownloadError(f"Файл больше {config.MAX_FILE_MB} МБ.")
        if track_progress:
            job.phase = "downloading"
            job.part += 1
            job.downloaded, job.total, job.speed = 0, total, None
        started, done = time.monotonic(), 0
        with dest.open("wb") as f:
            async for chunk in resp.content.iter_chunked(64 * 1024):
                if job.cancelled:
                    raise Cancelled
                done += len(chunk)
                if done > limit:
                    raise DownloadError(f"Файл больше {config.MAX_FILE_MB} МБ.")
                f.write(chunk)
                if track_progress:
                    job.downloaded = done
                    job.speed = done / max(time.monotonic() - started, 0.001)
    return dest


def _video_dims(path: Path) -> tuple[int | None, int | None]:
    try:
        proc = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(path)],
                              capture_output=True, text=True, timeout=30)
    except (subprocess.SubprocessError, OSError):
        return None, None
    m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", proc.stderr)
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)


def _pick_video(post: Post, limit: int) -> str:
    if post.hd_video and post.hd_size and post.hd_size <= limit:
        return post.hd_video
    if post.video and (not post.video_size or post.video_size <= limit):
        return post.video
    if post.hd_video and not post.hd_size:
        return post.hd_video
    if post.video or post.hd_video:
        raise DownloadError(f"Видео больше {config.MAX_FILE_MB} МБ.")
    raise DownloadError("В этом посте нет видео.")


async def download_video(post: Post, job: Job) -> Result:
    limit = config.MAX_FILE_MB * 1024 * 1024
    url = _pick_video(post, limit)
    async with queue_slot(job):
        workdir = _new_workdir()
        try:
            async with _session() as session:
                path = await _download(session, url, workdir / f"{post.id or 'video'}.mp4", job, limit)
                if post.cover:
                    try:
                        await _download(session, post.cover, workdir / "source_cover.jpg", job,
                                        5 * 1024 * 1024, track_progress=False)
                    except (DownloadError, aiohttp.ClientError, asyncio.TimeoutError):
                        pass  # без превью тоже можно
            job.check()
            job.phase = "processing"
            width, height = await asyncio.to_thread(_video_dims, path)
            thumb = await asyncio.to_thread(_make_thumb, workdir, False)
            return Result(path=path, workdir=workdir, title=post.title, duration=post.duration,
                          width=width, height=height, thumb=thumb)
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            shutil.rmtree(workdir, ignore_errors=True)
            raise DownloadError("Не удалось скачать видео из TikTok, попробуйте позже.") from e
        except BaseException:
            shutil.rmtree(workdir, ignore_errors=True)
            raise


def _to_mp3(src: Path, out: Path, title: str, artist: str) -> bool:
    return _ffmpeg("-i", str(src), "-vn", "-map", "0:a", "-b:a", "192k",
                   "-metadata", f"title={title}", "-metadata", f"artist={artist}", str(out))


async def download_audio(post: Post, job: Job) -> Result:
    limit = config.MAX_FILE_MB * 1024 * 1024
    title = post.music_title or post.title
    artist = post.music_author or post.author
    async with queue_slot(job):
        workdir = _new_workdir()
        try:
            async with _session() as session:
                if post.music:
                    src = await _download(session, post.music, workdir / "source_audio", job, limit)
                else:
                    # у поста нет отдельного звука — достаём звук из видео
                    src = await _download(session, _pick_video(post, limit), workdir / "source_video", job, limit)
                cover = post.music_cover or post.cover
                if cover:
                    try:
                        await _download(session, cover, workdir / "source_cover.jpg", job,
                                        5 * 1024 * 1024, track_progress=False)
                    except (DownloadError, aiohttp.ClientError, asyncio.TimeoutError):
                        pass
            job.check()
            job.phase = "processing"
            path = workdir / "audio.mp3"
            if not await asyncio.to_thread(_to_mp3, src, path, title, artist):
                raise DownloadError("Не удалось получить звук из этого TikTok.")
            src.unlink(missing_ok=True)
            if path.stat().st_size > limit:
                raise DownloadError(f"Аудио больше {config.MAX_FILE_MB} МБ.")
            path = await asyncio.to_thread(_embed_cover, path, workdir, limit)
            thumb = await asyncio.to_thread(_make_thumb, workdir, True)
            return Result(path=path, workdir=workdir, title=title, performer=artist,
                          duration=post.duration, thumb=thumb)
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            shutil.rmtree(workdir, ignore_errors=True)
            raise DownloadError("Не удалось скачать звук из TikTok, попробуйте позже.") from e
        except BaseException:
            shutil.rmtree(workdir, ignore_errors=True)
            raise


def _is_jpeg_or_png(path: Path) -> bool:
    head = path.read_bytes()[:8]
    return head.startswith(b"\xff\xd8") or head.startswith(b"\x89PNG")


async def download_photos(post: Post, job: Job) -> Album:
    """Фото из карусели. Telegram не принимает webp как фото, поэтому конвертируем в jpeg."""
    urls = post.images[:MAX_PHOTOS]
    async with queue_slot(job):
        workdir = _new_workdir()
        try:
            paths = []
            async with _session() as session:
                job.phase, job.unit = "downloading", "photos"
                job.downloaded, job.total = 0, len(urls)
                for i, url in enumerate(urls, 1):
                    job.check()
                    raw = await _download(session, url, workdir / f"raw_{i:02d}", job,
                                          10 * 1024 * 1024, track_progress=False)
                    job.downloaded = i  # для фото прогресс — в штуках
                    paths.append(raw)
            job.phase = "processing"
            result = []
            for i, raw in enumerate(paths, 1):
                if _is_jpeg_or_png(raw):
                    result.append(raw.rename(workdir / f"photo_{i:02d}.jpg"))
                    continue
                out = workdir / f"photo_{i:02d}.jpg"
                if await asyncio.to_thread(_ffmpeg, "-i", str(raw), "-q:v", "2", str(out), timeout=60):
                    result.append(out)
            if not result:
                raise DownloadError("Не удалось скачать фото из этого поста.")
            caption = post.title if post.title != "TikTok" else ""
            return Album(paths=result, workdir=workdir, caption=caption)
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            shutil.rmtree(workdir, ignore_errors=True)
            raise DownloadError("Не удалось скачать фото из TikTok, попробуйте позже.") from e
        except BaseException:
            shutil.rmtree(workdir, ignore_errors=True)
            raise
