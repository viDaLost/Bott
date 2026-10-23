# Сервер cobalt для бота Bott

Эта ветка — отдельное приложение: сервер [cobalt](https://github.com/imputnet/cobalt),
через который бот на Telegram Serverless скачивает видео с YouTube, Instagram, VK, X и других сайтов.
Код самого бота — в ветке `claude/telegram-serverless`.

## Запуск на Timeweb Cloud (App Platform), можно с телефона

1. **Придумайте ключ** — UUID v4, например сгенерируйте на <https://www.uuidgenerator.net/version4>.
   Это пароль между ботом и сервером, никому его не показывайте.
2. Timeweb Cloud → **Apps → Создать** → тип **Dockerfile** → репозиторий `Bott`, ветка **`cobalt-server`**.
   Если старое приложение бота ещё есть — его можно удалить (бот теперь живёт в Telegram Serverless).
3. **Порт приложения — `9000`.**
4. **Переменные окружения:**
   - `BOT_API_KEY` — ключ из шага 1;
   - `API_URL` — адрес приложения, который Timeweb покажет после создания (например `https://xxxx.timeweb.app/`).
     Если адрес известен только после первого деплоя — добавьте переменную и передеплойте.
5. Дождитесь деплоя. Откройте адрес приложения в браузере — должен показаться JSON с `"cobalt"`.
6. В чате с ботом (вы владелец):
   ```
   /set cobalt_url https://xxxx.timeweb.app
   /set cobalt_key ваш-ключ
   ```
   Сообщение с ключом бот сразу удалит. Проверьте: пришлите ссылку на Instagram или YouTube.

## Если YouTube или Instagram отвечают «нужен вход»

Серверы в дата-центрах часто блокируются. cobalt умеет работать с cookies: задайте переменную
`COOKIES_JSON` в формате cobalt (см. [документацию](https://github.com/imputnet/cobalt/blob/main/docs/examples/cookies.example.json)),
например `{"instagram":["sessionid=…; ds_user_id=…; csrftoken=…"]}`. Используйте отдельный, не основной аккаунт.
