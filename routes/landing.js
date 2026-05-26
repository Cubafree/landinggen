const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const db = require('../db');

const template = fs.readFileSync(
  path.join(__dirname, '..', 'templates', 'landing.html'),
  'utf-8'
);

router.get('/', (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;padding:2rem">
    <h1>Landing Generator</h1><p><a href="/admin">Admin Panel</a></p>
  </body></html>`);
});

router.get('/:slug', (req, res) => {
  const landing = db.prepare(
    'SELECT * FROM landings WHERE slug = ? AND active = 1'
  ).get(req.params.slug);

  if (!landing) return res.status(404).send('Not found');

  const bgUrl = landing.image_filename
    ? `/uploads/${landing.image_filename}`
    : '';

  const html = template
    .replace(/\{\{TITLE\}\}/g, escHtml(landing.title))
    .replace(/\{\{SUBTITLE\}\}/g, escHtml(landing.subtitle || ''))
    .replace(/\{\{PROMO_CODE\}\}/g, escHtml(landing.promo_code))
    .replace(/\{\{REDIRECT_URL\}\}/g, escHtml(landing.redirect_url))
    .replace(/\{\{CTA_TEXT\}\}/g, escHtml(landing.cta_text))
    .replace(/\{\{BG_IMAGE_URL\}\}/g, bgUrl)
    .replace(/\{\{HAS_IMAGE\}\}/g, bgUrl ? 'has-image' : 'no-image');

  res.send(html);
});

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = router;
