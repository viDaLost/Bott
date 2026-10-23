FROM python:3.12-slim

# Без предупреждений pip про root и новую версию — они засоряли логи при каждом старте
ENV PIP_ROOT_USER_ACTION=ignore \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# ffmpeg — склейка видео/аудио и конвертация в mp3
# curl — им App Platform проверяет /health изнутри контейнера; без него деплой падает как unhealthy
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Deno — JS-движок, который нужен yt-dlp для YouTube
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Распознавание музыки (необязательно: если не соберётся, бот всё равно запустится)
RUN pip install --no-cache-dir shazamio || echo "shazamio не установлен — распознавание будет отключено"

COPY . .

ENV PYTHONUNBUFFERED=1 \
    PORT=8080
EXPOSE 8080

# При каждом старте обновляем yt-dlp — сайты часто меняются
# curl-cffi — имитация настоящего браузера: без неё TikTok и часть других сайтов отвечают 403
CMD ["sh", "-c", "pip install -q -U --no-cache-dir 'yt-dlp[default,curl-cffi]' || true; exec python bot.py"]
