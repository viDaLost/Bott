import { table, integer, text, index, uniqueIndex } from 'sdk/db';

// Таблицы базы. После изменений: npx tgcloud push, затем npx tgcloud migrate.
// Время везде — unix-секунды.

// callback_data в Telegram ограничена 64 байтами, поэтому ссылки и запросы
// для кнопок хранятся здесь, а в кнопке — только короткий ключ.
export const keys = table('keys', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  created: integer('created').notNull(),
}, (t) => ({
  createdIdx: index('idx_keys_created').on(t.created),
}));

// Кэш file_id: повторный запрос того же видео/трека отправляется без скачивания.
export const files = table('files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(), // ссылка или устойчивый id (youtube:…, tiktok:…)
  kind: text('kind').notNull(), // v — видео, a — аудио
  fileId: text('file_id').notNull(),
  title: text('title'),
  created: integer('created').notNull(),
}, (t) => ({
  sourceKindIdx: uniqueIndex('uidx_files_source_kind').on(t.source, t.kind),
  fileIdIdx: index('idx_files_file_id').on(t.fileId),
  createdIdx: index('idx_files_created').on(t.created),
}));

// Результаты поиска музыки — чтобы листать страницы без повторного поиска.
export const searches = table('searches', {
  id: text('id').primaryKey(),
  query: text('query').notNull(),
  results: text('results').notNull(), // JSON-массив {id, title, duration, channel}
  continuation: text('continuation'), // токен следующей пачки результатов YouTube
  created: integer('created').notNull(),
}, (t) => ({
  createdIdx: index('idx_searches_created').on(t.created),
}));

// Загрузки: статус для очереди, отмены и защиты от повторного запуска.
export const jobs = table('jobs', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  chatId: integer('chat_id').notNull(),
  state: text('state').notNull(), // active | cancelled | done
  created: integer('created').notNull(),
}, (t) => ({
  userStateIdx: index('idx_jobs_user_state').on(t.userId, t.state),
  createdIdx: index('idx_jobs_created').on(t.created),
}));

// Токены сторонних сервисов и прочие настройки, заданные владельцем через /set.
export const settings = table('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updated: integer('updated').notNull(),
});

// Пользователи, которым владелец открыл доступ командой /allow.
export const allowedUsers = table('allowed_users', {
  userId: integer('user_id').primaryKey(),
  added: integer('added').notNull(),
});

// update_id уже обработанных апдейтов: повторная доставка не запускает загрузку дважды.
export const updates = table('updates', {
  id: integer('id').primaryKey(),
  created: integer('created').notNull(),
}, (t) => ({
  createdIdx: index('idx_updates_created').on(t.created),
}));
