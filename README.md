# Bott — универсальный бот для скачивания видео и музыки

Telegram-бот на **aiogram 3** + **yt-dlp** + **ffmpeg**.

## Возможности

- 🎬 Скачивание видео по ссылке: YouTube, Instagram, TikTok и сотни других сайтов (всё, что поддерживает yt-dlp). Можно получить видео или только аудио в MP3.
- 🎵 Поиск музыки по названию: просто напишите название или `/music название`, выберите трек из списка.
- 📝 Поиск по строчке из песни: `/lyrics фрагмент` (через Genius API, нужен `GENIUS_TOKEN`).
- 🎧 Распознавание музыки из голосового, кружка или аудио (Shazam).
- Автоматический подбор качества видео (720p → 480p → 360p → 240p), чтобы уложиться в лимит Telegram.
- Очередь загрузок (по умолчанию 2 одновременно) — важно для сервера с 1 ГБ RAM.
- Ограничение доступа по Telegram ID.

## Деплой на Timeweb Cloud (App Platform)

1. Создайте бота у [@BotFather](https://t.me/BotFather) и скопируйте токен.
2. В Timeweb Cloud → Apps → создайте приложение из этого репозитория, тип — **Dockerfile**.
3. В **Настройки деплоя → Переменные окружения** добавьте минимум `BOT_TOKEN`. Остальные переменные — в `.env.example`.
4. Порт приложения — `8080` (там отвечает health-check).
5. Задеплойте и посмотрите «Логи приложения»: должна появиться строка `Бот @имя запущен`.

Узнать свой Telegram ID для `ALLOWED_USERS` можно у бота [@userinfobot](https://t.me/userinfobot) — или просто напишите своему боту, когда `ALLOWED_USERS` уже задан: он покажет ваш ID в сообщении об отказе.

## Если YouTube или Instagram не скачиваются

Сервер находится в дата-центре, и YouTube часто отвечает «Sign in to confirm you're not a bot», а Instagram требует вход. Решение — cookies:

1. В браузере на компьютере установите расширение **Get cookies.txt LOCALLY**.
2. Зайдите на youtube.com (и/или instagram.com) под **отдельным, не основным** аккаунтом и экспортируйте cookies в `cookies.txt`.
3. Закодируйте файл в base64:
   - Linux/macOS: `base64 -w0 cookies.txt` (на macOS: `base64 -i cookies.txt`)
   - Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cookies.txt"))`
4. Вставьте полученную строку в переменную `COOKIES_B64` и передеплойте.

Если не помогает — задайте `PROXY` (например, `socks5://user:pass@host:1080`) с резидентным IP.

## Лимит 50 МБ

Обычный Bot API не даёт боту отправлять файлы больше 50 МБ. Бот сам понижает качество видео и битрейт MP3. Чтобы снять лимит (до 2 ГБ), нужен свой [Local Bot API Server](https://github.com/tdlib/telegram-bot-api) и переменная `BOT_API_URL` — но на 1 ГБ RAM это тесно, лучше отдельный VPS.

## Локальный запуск

```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt shazamio
cp .env.example .env   # и впишите BOT_TOKEN
python bot.py
```

Нужны установленные `ffmpeg` и (для YouTube) `deno`.

## Структура

| Файл | Назначение |
|---|---|
| `bot.py` | Обработчики Telegram, очередь, отправка файлов, health-check |
| `downloader.py` | Скачивание видео/аудио и поиск через yt-dlp |
| `music.py` | Поиск по тексту (Genius) и распознавание (Shazam) |
| `config.py` | Настройки из переменных окружения |
| `Dockerfile` | Образ с ffmpeg, deno и автообновлением yt-dlp |

## Важно

Скачивание контента может нарушать правила площадок и авторские права. Бот рассчитан на личное использование; при публичном доступе возможны жалобы и блокировки.
