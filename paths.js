/**
 * Central path configuration.
 * DATA_DIR points to the persistent volume on Railway (/data)
 * and falls back to a local ./data folder for development.
 */
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// Ensure directories exist on startup
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Log paths so Railway logs show where data is stored
console.log(`[paths] DATA_DIR  = ${DATA_DIR}${process.env.DATA_DIR ? '' : '  ⚠️  DATA_DIR not set — data will be lost on redeploy!'}`);
console.log(`[paths] DB        = ${path.join(DATA_DIR, 'landings.db')}`);
console.log(`[paths] UPLOADS   = ${UPLOADS_DIR}`);

module.exports = { DATA_DIR, UPLOADS_DIR };
