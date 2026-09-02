const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// DB_PATH should point to a Railway Volume mount (e.g. /data/bot.db)
// so the code->file_id mapping survives redeploys/restarts.
// If no volume is attached, this still works but resets on every deploy.
const DB_PATH = process.env.DB_PATH || './data/bot.db';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    code TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    file_type TEXT NOT NULL,
    caption TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sponsor_channels (
    channel_id TEXT PRIMARY KEY,
    title TEXT,
    invite_link TEXT
  );
`);

module.exports = {
  // files
  saveFile: (code, file_id, file_type, caption) =>
    db.prepare('INSERT INTO files (code, file_id, file_type, caption) VALUES (?, ?, ?, ?)')
      .run(code, file_id, file_type, caption || null),

  getFile: (code) =>
    db.prepare('SELECT * FROM files WHERE code = ?').get(code),

  // sponsor channels
  addChannel: (channel_id, title, invite_link) =>
    db.prepare(
      'INSERT INTO sponsor_channels (channel_id, title, invite_link) VALUES (?, ?, ?) ' +
      'ON CONFLICT(channel_id) DO UPDATE SET title=excluded.title, invite_link=excluded.invite_link'
    ).run(channel_id, title || null, invite_link || null),

  removeChannel: (channel_id) =>
    db.prepare('DELETE FROM sponsor_channels WHERE channel_id = ?').run(channel_id),

  listChannels: () =>
    db.prepare('SELECT * FROM sponsor_channels').all(),
};
