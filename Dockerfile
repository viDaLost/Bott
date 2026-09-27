FROM python:3.12-slim

# ffmpeg — склейка видео/аудио и конвертация в mp3
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
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
CMD ["sh", "-c", "pip install -q -U --no-cache-dir 'yt-dlp[default]' || true; exec python bot.py"]
