// Состояние одной загрузки: этап, прогресс, отмена и сообщение со статусом.
//
// Обработчик в Serverless — это один вызов функции, поэтому кнопка «Отмена»
// приходит отдельным вызовом и лишь помечает загрузку в базе. Идущая загрузка
// замечает пометку при очередном обновлении прогресса (раз в несколько секунд).
import { api } from 'sdk';
import { getJob } from './storage.js';
import { fmtMb, kb } from './text.js';

export class DownloadError extends Error {
  // Ошибка с текстом, который можно показать пользователю.
}

export class TooLarge extends DownloadError {
  // Файл больше лимита — можно попробовать качество пониже.
}

export class Cancelled extends Error {
  constructor() {
    super('Загрузка отменена');
  }
}

const TICK_MS = 3000;

const PHASE_TEXT = {
  probing: '🔎 Получаю информацию…',
  starting: '⬇️ Начинаю загрузку…',
  processing: '⚙️ Обрабатываю…',
  uploading: '📤 Отправляю в Telegram…',
};

export class Job {
  constructor({ id, chatId, statusMessageId = null, kind = 'v' }) {
    this.id = id;
    this.chatId = chatId;
    this.statusMessageId = statusMessageId;
    this.kind = kind;
    // probing → starting → downloading → processing → uploading
    this.phase = 'probing';
    this.downloaded = 0;
    this.total = null;
    this.speed = null;
    this.part = 0; // номер скачиваемого файла (у карусели и при смене качества)
    this.unit = 'bytes'; // 'photos' — прогресс в штуках
    this.note = ''; // доп. строка, например «пробую 480p»
    this.cancelled = false;
    this.lastText = null;
    this.lastTick = 0;
  }

  setPhase(phase) {
    this.phase = phase;
  }

  check() {
    if (this.cancelled) throw new Cancelled();
  }

  render() {
    if (this.cancelled) return '⏳ Отменяю…';
    let text;
    if (this.phase !== 'downloading') {
      text = PHASE_TEXT[this.phase] || '⏳ Подождите…';
    } else if (this.unit === 'photos') {
      text = `📷 Скачиваю: ${this.downloaded} из ${this.total}`;
    } else {
      const head = '⬇️ Скачиваю' + (this.part > 1 ? ` (попытка ${this.part})` : '');
      let line;
      if (this.total) {
        const pct = Math.min(this.downloaded / this.total, 1);
        const filled = Math.round(pct * 10);
        line = `${'▓'.repeat(filled)}${'░'.repeat(10 - filled)} ${Math.round(pct * 100)}%\n`
          + `${fmtMb(this.downloaded)} / ${fmtMb(this.total)} МБ`;
      } else {
        line = `${fmtMb(this.downloaded)} МБ`;
      }
      if (this.speed) line += ` · ${fmtMb(this.speed)} МБ/с`;
      text = `${head}\n${line}`;
    }
    return this.note ? `${text}\n<i>${this.note}</i>` : text;
  }

  keyboard() {
    if (this.phase === 'uploading' || this.cancelled) return undefined;
    return kb([[['✖️ Отмена', `c:${this.id}`]]]);
  }

  // Раз в TICK_MS: проверяет отмену в базе и обновляет сообщение со статусом.
  // force — обновить сразу (смена этапа).
  async tick(force = false) {
    const t = Date.now();
    if (!force && t - this.lastTick < TICK_MS) {
      this.check();
      return;
    }
    this.lastTick = t;
    try {
      const row = await getJob(this.id);
      if (row && row.state === 'cancelled') this.cancelled = true;
    } catch (e) {
      console.warn('Не удалось проверить отмену', e);
    }
    await this.updateStatus();
    this.check();
  }

  async updateStatus() {
    if (!this.statusMessageId) return;
    const text = this.render();
    if (text === this.lastText) return;
    try {
      if (this.phase !== 'probing') {
        await api.sendChatAction({
          chat_id: this.chatId,
          action: this.kind === 'v' ? 'upload_video' : 'upload_document',
        });
      }
      await api.editMessageText({
        chat_id: this.chatId,
        message_id: this.statusMessageId,
        text,
        parse_mode: 'HTML',
        reply_markup: this.keyboard(),
      });
      this.lastText = text;
    } catch (e) {
      // 400 «message is not modified», 429 — пропускаем этот тик, прогресс не критичен
      if (e?.code !== 400 && e?.code !== 429) console.warn('Не удалось обновить статус', e);
    }
  }
}
