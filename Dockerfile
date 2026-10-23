# Сервер cobalt (https://github.com/imputnet/cobalt) для бота Bott:
# скачивает видео/звук с YouTube, Instagram, VK, X и др. вместо yt-dlp.
#
# Переменные окружения (в настройках приложения Timeweb):
#   API_URL      — публичный адрес этого приложения, например https://xxx.timeweb.app/  (обязательно)
#   BOT_API_KEY  — ключ доступа для бота, UUID v4 (обязательно, иначе сервером сможет пользоваться кто угодно)
#   COOKIES_JSON — необязательно: cookies для YouTube/Instagram в формате cobalt (см. README)
FROM ghcr.io/imputnet/cobalt:11

ENV API_PORT=9000 \
    API_AUTH_REQUIRED=1 \
    API_KEY_URL=file:///tmp/keys.json

EXPOSE 9000

# Ключи и cookies берутся из переменных окружения при старте, а не хранятся в репозитории.
CMD ["sh", "-c", "\
  if [ -z \"$BOT_API_KEY\" ]; then echo 'Задайте переменную BOT_API_KEY' >&2; exit 1; fi; \
  printf '{\"%s\":{\"name\":\"bott\",\"limit\":\"unlimited\"}}' \"$BOT_API_KEY\" > /tmp/keys.json; \
  if [ -n \"$COOKIES_JSON\" ]; then printf '%s' \"$COOKIES_JSON\" > /tmp/cookies.json; export COOKIE_PATH=/tmp/cookies.json; fi; \
  exec node src/cobalt"]
