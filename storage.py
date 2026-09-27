"""Хранилище: ключи для кнопок и file_id уже отправленных файлов.

Благодаря ему кнопки продолжают работать после перезапуска, а повторный
запрос того же видео/трека отправляется мгновенно — Telegram пересылает
файл по file_id без скачивания.

Два варианта хранения (SQL одинаковый — оба это SQLite):
- Cloudflare D1, если заданы CF_ACCOUNT_ID, CF_D1_DATABASE_ID и CF_API_TOKEN —
  данные живут в облаке и не теряются при передеплое;
- иначе локальный файл DB_PATH.
"""
import asyncio
import logging
import sqlite3
import time
import uuid

import aiohttp

import config

log = logging.getLogger(__name__)

KEY_TTL = 30 * 24 * 3600  # сколько живут кнопки
FILE_TTL = 180 * 24 * 3600  # сколько помним file_id

_SCHEMA = [
    """CREATE TABLE IF NOT EXISTS keys (
        key     TEXT PRIMARY KEY,
        value   TEXT NOT NULL,
        created REAL NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS files (
        source  TEXT NOT NULL,
        kind    TEXT NOT NULL,
        file_id TEXT NOT NULL,
        title   TEXT,
        created REAL NOT NULL,
        PRIMARY KEY (source, kind)
    )""",
]


class StorageError(Exception):
    pass


class _LocalBackend:
    name = "локальный SQLite"

    def __init__(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        # Бот однопоточный (asyncio), запросы короткие — синхронного sqlite3 достаточно
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")

    async def query(self, sql: str, params: tuple = ()) -> list[dict]:
        return [dict(row) for row in self._db.execute(sql, params).fetchall()]

    async def close(self) -> None:
        self._db.close()


class _D1Backend:
    """Cloudflare D1 через REST API: POST .../d1/database/{id}/query."""

    name = "Cloudflare D1"

    def __init__(self, account_id: str, database_id: str, token: str):
        self._url = (
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
            f"/d1/database/{database_id}/query"
        )
        self._token = token
        self._session: aiohttp.ClientSession | None = None

    async def query(self, sql: str, params: tuple = ()) -> list[dict]:
        if self._session is None:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=15),
                headers={"Authorization": f"Bearer {self._token}"},
            )
        body = {"sql": sql, "params": list(params)}
        for attempt in (1, 2):  # один повтор при сетевом сбое или ошибке 5xx
            try:
                async with self._session.post(self._url, json=body) as resp:
                    if resp.status >= 500:
                        raise StorageError(f"D1 недоступна: HTTP {resp.status}")
                    data = await resp.json(content_type=None)
            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, StorageError) as e:
                if attempt == 1:
                    continue
                if isinstance(e, StorageError):
                    raise
                raise StorageError(f"D1 недоступна: {e!r}") from e
            if not data.get("success"):
                raise StorageError(f"D1 ответила ошибкой: {data.get('errors')}")
            return data["result"][0].get("results") or []

    async def close(self) -> None:
        if self._session is not None:
            await self._session.close()


class Storage:
    def __init__(self, backend):
        self._b = backend

    @property
    def backend_name(self) -> str:
        return self._b.name

    async def init(self) -> None:
        for sql in _SCHEMA:
            await self._b.query(sql)
        await self.prune()

    async def close(self) -> None:
        await self._b.close()

    async def prune(self) -> None:
        now = time.time()
        await self._b.query("DELETE FROM keys WHERE created < ?", (now - KEY_TTL,))
        await self._b.query("DELETE FROM files WHERE created < ?", (now - FILE_TTL,))

    # ---------------------------------------------------------- кнопки
    # callback_data в Telegram ограничена 64 байтами, поэтому ссылки и запросы храним тут.

    async def put_many(self, values: list[str]) -> list[str]:
        """Сохраняет значения одним запросом (для D1 это один сетевой вызов) и возвращает ключи."""
        if not values:
            return []
        now = time.time()
        keys = [uuid.uuid4().hex[:12] for _ in values]
        marks = ", ".join("(?, ?, ?)" for _ in values)
        params = [p for k, v in zip(keys, values) for p in (k, v, now)]
        await self._b.query(f"INSERT INTO keys VALUES {marks}", tuple(params))
        return keys

    async def put(self, value: str) -> str:
        return (await self.put_many([value]))[0]

    async def get(self, key: str) -> str | None:
        rows = await self._b.query(
            "SELECT value FROM keys WHERE key = ? AND created > ?", (key, time.time() - KEY_TTL)
        )
        return rows[0]["value"] if rows else None

    # ---------------------------------------------------------- file_id
    # Кэш — не главное: если база недоступна, бот просто скачает файл заново.

    async def get_file(self, sources: list[str], kind: str) -> tuple[str, str | None] | None:
        """Ищет file_id по любому из идентификаторов источника (ссылка, extractor:id)."""
        sources = [s for s in dict.fromkeys(sources) if s]
        if not sources:
            return None
        marks = ", ".join("?" * len(sources))
        try:
            rows = await self._b.query(
                f"SELECT source, file_id, title FROM files "
                f"WHERE source IN ({marks}) AND kind = ? AND created > ?",
                (*sources, kind, time.time() - FILE_TTL),
            )
        except StorageError:
            log.exception("Не удалось прочитать кэш file_id")
            return None
        if not rows:
            return None
        # приоритет — в порядке sources
        best = min(rows, key=lambda r: sources.index(r["source"]))
        return best["file_id"], best["title"]

    async def save_file(self, sources: list[str], kind: str, file_id: str, title: str | None) -> None:
        sources = [s for s in dict.fromkeys(sources) if s]
        if not sources:
            return
        now = time.time()
        values = ", ".join("(?, ?, ?, ?, ?)" for _ in sources)
        params = [p for s in sources for p in (s, kind, file_id, title, now)]
        try:
            await self._b.query(f"INSERT OR REPLACE INTO files VALUES {values}", tuple(params))
        except StorageError:
            log.exception("Не удалось сохранить file_id в кэш")

    async def forget_file(self, file_id: str) -> None:
        try:
            await self._b.query("DELETE FROM files WHERE file_id = ?", (file_id,))
        except StorageError:
            log.exception("Не удалось удалить file_id из кэша")


def _make_backend():
    if config.CF_ACCOUNT_ID and config.CF_D1_DATABASE_ID and config.CF_API_TOKEN:
        return _D1Backend(config.CF_ACCOUNT_ID, config.CF_D1_DATABASE_ID, config.CF_API_TOKEN)
    return _LocalBackend(config.DB_PATH)


db = Storage(_make_backend())
