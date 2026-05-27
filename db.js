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
    created_at TEXT DEFAULT (datetime('now')),
    active INTEGER DEFAULT 1
  )
`);

module.exports = db;
