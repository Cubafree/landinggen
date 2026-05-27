const Database = require('better-sqlite3');
const path = require('path');
const { DATA_DIR } = require('./paths');

const db = new Database(path.join(DATA_DIR, 'landings.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS landings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    promo_code TEXT NOT NULL,
    redirect_url TEXT NOT NULL,
    cta_text TEXT NOT NULL,
    title TEXT NOT NULL,
    subtitle TEXT DEFAULT '',
    image_prompt TEXT DEFAULT '',
    image_filename TEXT DEFAULT '',
    image_status TEXT DEFAULT 'none',
    created_at TEXT DEFAULT (datetime('now')),
    active INTEGER DEFAULT 1
  )
`);

// Safe migration for databases created before image_status was added
try {
  db.exec(`ALTER TABLE landings ADD COLUMN image_status TEXT DEFAULT 'none'`);
  // Back-fill: rows that have an image are 'ready', rest stay 'none'
  db.exec(`UPDATE landings SET image_status = 'ready' WHERE image_filename != '' AND image_status = 'none'`);
} catch (_) {
  // Column already exists — nothing to do
}

module.exports = db;
