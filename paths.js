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

module.exports = { DATA_DIR, UPLOADS_DIR };
