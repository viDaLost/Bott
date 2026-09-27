"""Поиск песни по фрагменту текста (Genius API) и распознавание по звуку (Shazam)."""
import asyncio
import logging
from pathlib import Path

import aiohttp

import config

log = logging.getLogger(__name__)

try:
    from shazamio import Shazam
except ImportError:  # библиотека необязательная
    Shazam = None


def shazam_available() -> bool:
    return Shazam is not None


async def genius_search(fragment: str, limit: int = 6) -> list[dict]:
    """Возвращает список {'artist', 'title'} — только названия, без текста песен."""
    headers = {"Authorization": f"Bearer {config.GENIUS_TOKEN}"}
    timeout = aiohttp.ClientTimeout(total=15)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(
            "https://api.genius.com/search", params={"q": fragment}, headers=headers
        ) as resp:
            resp.raise_for_status()
            data = await resp.json()

    results = []
    for hit in data.get("response", {}).get("hits", []):
        res = hit.get("result") or {}
        artist = (res.get("primary_artist") or {}).get("name", "").strip()
        title = (res.get("title") or "").strip()
        if artist and title:
            results.append({"artist": artist, "title": title})
        if len(results) >= limit:
            break
    return results


async def recognize_file(src: Path, workdir: Path) -> dict | None:
    """Распознаёт трек из голосового/аудио/кружка. Возвращает {'artist', 'title'} или None."""
    if Shazam is None:
        return None

    sample = workdir / "sample.wav"
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(src),
        "-t", "20", "-ac", "1", "-ar", "44100", str(sample),
    )
    await proc.wait()
    if proc.returncode != 0 or not sample.exists():
        return None

    shazam = Shazam()
    recognize = getattr(shazam, "recognize", None) or getattr(shazam, "recognize_song")
    data = await recognize(str(sample))
    track = (data or {}).get("track")
    if not track:
        return None
    return {"artist": track.get("subtitle") or "", "title": track.get("title") or ""}
