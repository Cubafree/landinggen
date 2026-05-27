const Database = require('better-sqlite3');
const path = require('path');
const { DATA_DIR } = require('./paths');

const db = new Database(path.join(DATA_DIR, 'landings.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS landings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slug         TEXT UNIQUE NOT NULL,
    promo_code   TEXT NOT NULL,
    redirect_url TEXT NOT NULL,
    cta_text     TEXT NOT NULL,
    title        TEXT NOT NULL,
    subtitle     TEXT    DEFAULT '',
    image_prompt TEXT    DEFAULT '',
    image_filename TEXT  DEFAULT '',
    image_status TEXT    DEFAULT 'none',
    panel_side   TEXT    DEFAULT 'right',
    layer_order  TEXT    DEFAULT 'logo,title,subtitle,promo,cta',
    created_at   TEXT    DEFAULT (datetime('now')),
    active       INTEGER DEFAULT 1
  )
`);

// ── Safe migrations for existing databases ────────────────────────────────────
const migrations = [
  `ALTER TABLE landings ADD COLUMN image_status  TEXT DEFAULT 'none'`,
  `ALTER TABLE landings ADD COLUMN panel_side    TEXT DEFAULT 'right'`,
  `ALTER TABLE landings ADD COLUMN layer_order   TEXT DEFAULT 'logo,title,subtitle,promo,cta'`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* column already exists */ }
}

// Back-fill: existing rows with an image → mark as 'ready'
db.exec(`UPDATE landings SET image_status = 'ready'
         WHERE image_filename != '' AND image_status = 'none'`);

module.exports = db;
