"""Скачивание видео и аудио через yt-dlp (YouTube, Instagram, TikTok и сотни других сайтов)."""
import asyncio
import logging
import re
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

import yt_dlp

import config

log = logging.getLogger(__name__)

URL_RE = re.compile(r"https?://[^\s<>\"']+")
VIDEO_HEIGHTS = (720, 480, 360, 240)  # «лестница» качества, чтобы уложиться в лимит размера
AUDIO_FALLBACK_BITRATES = (128, 96, 64, 48)
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp")
COVER_NAME, THUMB_NAME = "cover.jpg", "tg_thumb.jpg"  # файлы, которые бот делает сам

_sem = asyncio.Semaphore(config.MAX_PARALLEL)


class DownloadError(Exception):
    """Ошибка с текстом, который можно показать пользователю."""


class Cancelled(Exception):
    """Пользователь нажал «Отмена»."""


class Job:
    """Состояние одной загрузки: этап, прогресс и флаг отмены.

    Прогресс обновляется из потока yt-dlp, а читается из цикла asyncio —
    простые присваивания атрибутов для этого безопасны.
    """

    def __init__(self, user_id: int):
        self.id = uuid.uuid4().hex[:10]
        self.user_id = user_id
        self.created = time.monotonic()
        # probing → queued → starting → downloading → processing → uploading
        self.phase = "probing"
        self.downloaded = 0
        self.total: int | None = None
        self.speed: float | None = None
        self.part = 0  # номер скачиваемого файла: у YouTube видео и звук идут отдельно
        self.task: asyncio.Task | None = None
        self._last_file = None
        self._cancel = threading.Event()

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def cancel(self) -> None:
        self._cancel.set()

    def check(self) -> None:
        if self.cancelled:
            raise Cancelled

    def progress_hook(self, d: dict) -> None:
        if self.cancelled:
            raise yt_dlp.utils.DownloadCancelled
        if d.get("status") == "downloading":
            if d.get("filename") != self._last_file:
                self._last_file = d.get("filename")
                self.part += 1
            self.phase = "downloading"
            self.downloaded = d.get("downloaded_bytes") or 0
            self.total = d.get("total_bytes") or d.get("total_bytes_estimate")
            self.speed = d.get("speed")

    def postprocessor_hook(self, d: dict) -> None:
        if self.cancelled:
            raise yt_dlp.utils.DownloadCancelled
        if d.get("status") == "started":
            self.phase = "processing"


@dataclass
class Result:
    path: Path
    workdir: Path
    title: str
    performer: str | None = None
    duration: int | None = None
    width: int | None = None
    height: int | None = None
    thumb: Path | None = None  # превью для Telegram (jpeg до 320px)

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


def _new_workdir() -> Path:
    workdir = config.DOWNLOAD_DIR / uuid.uuid4().hex
    workdir.mkdir(parents=True, exist_ok=True)
    return workdir


def _base_opts(workdir: Path | None, job: Job | None = None) -> dict:
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
    if job is not None:
        opts["progress_hooks"] = [job.progress_hook]
        opts["postprocessor_hooks"] = [job.postprocessor_hook]
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


def _ffmpeg(*args: str, timeout: int = 900) -> bool:
    try:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True, timeout=timeout)
        return True
    except (subprocess.SubprocessError, OSError) as e:
        log.warning("ffmpeg не справился: %s", e)
        return False


def _video_format(h: int) -> str:
    # avc1 + m4a — лучше всего воспроизводится прямо в Telegram
    return (
        f"bv*[height<=?{h}][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/"
        f"bv*[height<=?{h}]+ba/"
        f"b[height<=?{h}][ext=mp4]/"
        f"b[height<=?{h}]/"
        f"b"
    )


def _page_url(meta: dict) -> str:
    return meta.get("webpage_url") or meta.get("original_url") or meta["url"]


def source_ids(meta: dict) -> list[str]:
    """Устойчивые идентификаторы ролика: разные ссылки на одно видео дают один и тот же id."""
    ids = []
    if meta.get("extractor_key") and meta.get("id"):
        ids.append(f"{meta['extractor_key']}:{meta['id']}")
    if meta.get("webpage_url"):
        ids.append(meta["webpage_url"])
    return ids


# ---------------------------------------------------------------- метаданные

def _probe_sync(target: str, job: Job) -> dict:
    """Получает информацию о ролике без скачивания. target — ссылка или 'ytsearch1:запрос'."""
    try:
        with yt_dlp.YoutubeDL(_base_opts(None) | {"skip_download": True}) as ydl:
            meta = _first_entry(ydl.extract_info(target, download=False))
    except yt_dlp.utils.DownloadError as e:
        raise DownloadError(_humanize(e)) from e
    job.check()

    duration = meta.get("duration")
    if config.MAX_DURATION and duration and duration > config.MAX_DURATION:
        raise DownloadError("Запись слишком длинная.")
    return meta


# ---------------------------------------------------------------- обложки

def _source_image(workdir: Path) -> Path | None:
    """Обложка, которую скачал yt-dlp (а не сделанная ботом)."""
    files = [
        p for p in workdir.iterdir()
        if p.suffix.lower() in IMAGE_EXTS and p.name not in (COVER_NAME, THUMB_NAME)
    ]
    return files[0] if files else None


def _make_thumb(workdir: Path, square: bool) -> Path | None:
    """Делает из скачанной обложки превью для Telegram: jpeg не больше 320px и 200 КБ."""
    src = _source_image(workdir)
    if not src:
        return None
    out = workdir / THUMB_NAME
    if square:
        vf = "crop='min(iw,ih)':'min(iw,ih)',scale=320:320"
    else:
        vf = "scale=320:320:force_original_aspect_ratio=decrease"
    if not _ffmpeg("-i", str(src), "-vf", vf, "-frames:v", "1", "-q:v", "4", str(out), timeout=60):
        return None
    return out if out.exists() and out.stat().st_size <= 200 * 1024 else None


def _embed_cover(path: Path, workdir: Path, limit: int) -> Path:
    """Вшивает квадратную обложку в mp3. Если не получилось — возвращает файл без обложки."""
    src = _source_image(workdir)
    if not src:
        return path
    cover = workdir / COVER_NAME
    out = workdir / "with_cover.mp3"
    ok = _ffmpeg(
        "-i", str(src), "-vf", "crop='min(iw,ih)':'min(iw,ih)',scale='min(600,iw)':-2",
        "-frames:v", "1", "-q:v", "3", str(cover), timeout=60,
    ) and _ffmpeg(
        "-i", str(path), "-i", str(cover), "-map", "0:a", "-map", "1:v", "-c", "copy",
        "-id3v2_version", "3", "-metadata:s:v", "title=Album cover",
        "-metadata:s:v", "comment=Cover (front)", str(out), timeout=120,
    )
    if not ok or not out.exists() or out.stat().st_size > limit:
        out.unlink(missing_ok=True)
        return path
    path.unlink(missing_ok=True)
    return out


# ---------------------------------------------------------------- видео

def _estimate_size(fmt: dict, duration: float | None) -> float | None:
    total = 0.0
    for f in fmt.get("requested_formats") or [fmt]:
        size = f.get("filesize") or f.get("filesize_approx")
        if not size and f.get("tbr") and duration:
            size = f["tbr"] * 1000 / 8 * duration
        if not size:
            return None
        total += size
    return total


def _plan_heights(meta: dict, limit: int) -> list[int]:
    """Оставляет только те качества, которые по оценке влезают в лимит.

    Так не приходится скачивать ролик целиком, чтобы узнать, что он слишком большой.
    Если размер неизвестен — качество остаётся в списке и проверяется после скачивания.
    """
    formats = meta.get("formats")
    if not formats:
        return list(VIDEO_HEIGHTS)
    heights = []
    try:
        with yt_dlp.YoutubeDL(_base_opts(None)) as ydl:
            for h in VIDEO_HEIGHTS:
                # _select_formats — внутренний метод yt-dlp, поэтому всё обёрнуто в try
                selected = ydl._select_formats(formats, ydl.build_format_selector(_video_format(h)))
                size = _estimate_size(selected[0], meta.get("duration")) if selected else None
                # запас 5%: оценки бывают неточными, окончательно размер проверяется после скачивания
                if size is not None and size > limit * 1.05:
                    log.info("%sp ≈ %.0f МБ — больше лимита, пропускаю", h, size / 2**20)
                    continue
                heights.append(h)
    except Exception:
        log.exception("Не удалось оценить размер, перебираю качество по очереди")
        return list(VIDEO_HEIGHTS)
    return heights


def _download_video_sync(meta: dict, job: Job) -> Result:
    limit = config.MAX_FILE_MB * 1024 * 1024
    heights = _plan_heights(meta, limit)

    for height in heights:
        job.check()
        job.part = 0
        workdir = _new_workdir()
        opts = _base_opts(workdir, job) | {
            "format": _video_format(height),
            "merge_output_format": "mp4",
            "max_filesize": limit,
            "writethumbnail": True,
        }
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = _first_entry(ydl.extract_info(_page_url(meta), download=True))
            path = _pick_file(workdir, (".mp4", ".mkv", ".webm", ".mov"))
            if path and path.stat().st_size <= limit:
                job.check()
                return Result(
                    path=path,
                    workdir=workdir,
                    title=info.get("title") or "video",
                    duration=int(info["duration"]) if info.get("duration") else None,
                    width=info.get("width"),
                    height=info.get("height"),
                    thumb=_make_thumb(workdir, square=False),
                )
        except yt_dlp.utils.DownloadCancelled as e:
            shutil.rmtree(workdir, ignore_errors=True)
            raise Cancelled from e
        except yt_dlp.utils.DownloadError as e:
            shutil.rmtree(workdir, ignore_errors=True)
            raise DownloadError(_humanize(e)) from e
        except BaseException:
            shutil.rmtree(workdir, ignore_errors=True)
            raise
        shutil.rmtree(workdir, ignore_errors=True)
        log.info("Файл больше лимита в %sp, пробую качество ниже", height)

    raise DownloadError(f"Видео больше {config.MAX_FILE_MB} МБ даже в минимальном качестве.")


# ---------------------------------------------------------------- аудио

def _download_audio_sync(meta: dict, job: Job) -> Result:
    limit = config.MAX_FILE_MB * 1024 * 1024
    workdir = _new_workdir()
    opts = _base_opts(workdir, job) | {
        "format": "bestaudio/best",
        "writethumbnail": True,
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"},
            {"key": "FFmpegMetadata", "add_metadata": True},
        ],
    }
    if config.MAX_DURATION:
        opts["match_filter"] = yt_dlp.utils.match_filter_func(f"duration <=? {config.MAX_DURATION}")

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = _first_entry(ydl.extract_info(_page_url(meta), download=True))

        path = _pick_file(workdir, (".mp3",))
        if not path:
            raise DownloadError("Не удалось получить аудио (возможно, запись слишком длинная).")

        duration = int(info["duration"]) if info.get("duration") else None
        job.phase = "processing"
        if path.stat().st_size > limit:
            path = _shrink_mp3(path, workdir, duration, limit)
        job.check()
        path = _embed_cover(path, workdir, limit)

        return Result(
            path=path,
            workdir=workdir,
            title=info.get("track") or info.get("title") or "audio",
            performer=info.get("artist") or info.get("uploader") or info.get("channel"),
            duration=duration,
            thumb=_make_thumb(workdir, square=True),
        )
    except yt_dlp.utils.DownloadCancelled as e:
        shutil.rmtree(workdir, ignore_errors=True)
        raise Cancelled from e
    except yt_dlp.utils.DownloadError as e:
        shutil.rmtree(workdir, ignore_errors=True)
        raise DownloadError(_humanize(e)) from e
    except BaseException:
        shutil.rmtree(workdir, ignore_errors=True)
        raise


def _shrink_mp3(path: Path, workdir: Path, duration: int | None, limit: int) -> Path:
    """Пережимает mp3 в меньший битрейт, чтобы влезть в лимит Telegram."""
    if not duration:
        raise DownloadError("Аудио слишком большое для отправки.")
    need_kbps = int(limit * 8 / duration / 1000 * 0.93)
    bitrate = next((b for b in AUDIO_FALLBACK_BITRATES if b <= need_kbps), None)
    if not bitrate:
        raise DownloadError("Аудио слишком длинное для отправки в Telegram.")

    out = workdir / "compressed.mp3"
    if not _ffmpeg("-i", str(path), "-map", "0:a", "-map_metadata", "0", "-b:a", f"{bitrate}k", str(out)):
        raise DownloadError("Не удалось сжать аудио.")

    path.unlink(missing_ok=True)
    if out.stat().st_size > limit:
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

async def probe(target: str, job: Job) -> dict:
    job.phase = "probing"
    return await asyncio.to_thread(_probe_sync, target, job)


async def _run_queued(job: Job, func, meta: dict) -> Result:
    # Пока задача ждёт очереди (phase == "queued"), её можно отменить через task.cancel().
    # Как только phase сменилась — работает поток, и отмена идёт только через job.cancel().
    job.phase = "queued"
    async with _sem:
        job.check()
        job.phase = "starting"
        return await asyncio.to_thread(func, meta, job)


async def download_video(meta: dict, job: Job) -> Result:
    return await _run_queued(job, _download_video_sync, meta)


async def download_audio(meta: dict, job: Job) -> Result:
    return await _run_queued(job, _download_audio_sync, meta)


async def search_youtube(query: str, limit: int = 6) -> list[dict]:
    return await asyncio.to_thread(_search_sync, query, limit)
