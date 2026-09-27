"""SQLite-хранилище: ключи для кнопок и file_id уже отправленных файлов.

Всё хранится в одном файле (DB_PATH), поэтому кнопки продолжают работать
после перезапуска, а повторный запрос того же видео/трека отправляется
мгновенно — Telegram пересылает файл по file_id без скачивания.
"""
import logging
import sqlite3
import time
import uuid

import config

log = logging.getLogger(__name__)

KEY_TTL = 30 * 24 * 3600  # сколько живут кнопки
FILE_TTL = 180 * 24 * 3600  # сколько помним file_id

_SCHEMA = """
CREATE TABLE IF NOT EXISTS keys (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL,
    created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
    source  TEXT NOT NULL,
    kind    TEXT NOT NULL,
    file_id TEXT NOT NULL,
    title   TEXT,
    created REAL NOT NULL,
    PRIMARY KEY (source, kind)
);
"""


class Storage:
    def __init__(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        # Бот однопоточный (asyncio), запросы короткие — синхронного sqlite3 достаточно
        self._db = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(_SCHEMA)
        self.prune()

    def prune(self) -> None:
        now = time.time()
        self._db.execute("DELETE FROM keys WHERE created < ?", (now - KEY_TTL,))
        self._db.execute("DELETE FROM files WHERE created < ?", (now - FILE_TTL,))

    # ---------------------------------------------------------- кнопки
    # callback_data в Telegram ограничена 64 байтами, поэтому ссылки и запросы храним тут.

    def put(self, value: str) -> str:
        row = self._db.execute(
            "SELECT key FROM keys WHERE value = ? AND created > ? LIMIT 1",
            (value, time.time() - KEY_TTL / 2),
        ).fetchone()
        if row:
            return row[0]
        key = uuid.uuid4().hex[:12]
        self._db.execute("INSERT INTO keys VALUES (?, ?, ?)", (key, value, time.time()))
        return key

    def get(self, key: str) -> str | None:
        row = self._db.execute(
            "SELECT value FROM keys WHERE key = ? AND created > ?", (key, time.time() - KEY_TTL)
        ).fetchone()
        return row[0] if row else None

    # ---------------------------------------------------------- file_id

    def get_file(self, sources: list[str], kind: str) -> tuple[str, str | None] | None:
        """Ищет file_id по любому из идентификаторов источника (ссылка, extractor:id)."""
        for source in sources:
            row = self._db.execute(
                "SELECT file_id, title FROM files WHERE source = ? AND kind = ? AND created > ?",
                (source, kind, time.time() - FILE_TTL),
            ).fetchone()
            if row:
                return row[0], row[1]
        return None

    def save_file(self, sources: list[str], kind: str, file_id: str, title: str | None) -> None:
        now = time.time()
        self._db.executemany(
            "INSERT OR REPLACE INTO files VALUES (?, ?, ?, ?, ?)",
            [(s, kind, file_id, title, now) for s in dict.fromkeys(sources) if s],
        )

    def forget_file(self, file_id: str) -> None:
        self._db.execute("DELETE FROM files WHERE file_id = ?", (file_id,))


db = Storage(config.DB_PATH)
