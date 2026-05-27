const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const db = require('../db');

const template = fs.readFileSync(
  path.join(__dirname, '..', 'templates', 'landing.html'),
  'utf-8'
);

const LOGO_URL = '/public/logo.svg';

/** Convert #rrggbb → { r, g, b } */
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** Generate CSS custom properties for the accent color and its opacity variants */
function generateAccentVars(hex) {
  const color = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#6c47ff';
  const { r, g, b } = hexToRgb(color);
  // Dark version for atmospheric glow blobs
  const dr = Math.round(r * 0.35);
  const dg = Math.round(g * 0.20);
  const db_ = Math.round(b * 0.65);
  return [
    `--accent: ${color}`,
    `--accent-a06: rgba(${r},${g},${b},0.06)`,
    `--accent-a12: rgba(${r},${g},${b},0.12)`,
    `--accent-a45: rgba(${r},${g},${b},0.45)`,
    `--accent-a65: rgba(${r},${g},${b},0.65)`,
    `--accent-dark: rgb(${dr},${dg},${db_})`,
  ].join('; ');
}

/** Build ordered HTML elements for the landing panel. */
function buildElements(landing) {
  const order = (landing.layer_order || 'logo,title,subtitle,promo,cta').split(',');

  const parts = {
    logo: `
      <img class="logo" src="${LOGO_URL}" alt="Logo"
           onerror="this.style.display='none'"/>`,

    title: `
      <h1 class="title" dir="auto">${escHtml(landing.title)}</h1>`,

    subtitle: landing.subtitle ? `
      <p class="promo-label" dir="auto">${escHtml(landing.subtitle)}</p>` : '',

    promo: `
      <div class="promo-box" onclick="copyPromo()" title="Copy promo code">
        <span class="copy-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </span>
        <span class="promo-code" id="promoCode">${escHtml(landing.promo_code)}</span>
      </div>`,

    cta: `
      <div class="cta-wrapper">
        <span class="cta-arrow"    aria-hidden="true">&#9664;</span>
        <a class="cta-btn" href="${escHtml(landing.redirect_url)}" rel="noopener">
          ${escHtml(landing.cta_text)}
        </a>
        <span class="cta-arrow r" aria-hidden="true">&#9654;</span>
      </div>`,
  };

  return order
    .filter(k => parts[k] !== undefined && parts[k] !== '')
    .map(k => parts[k])
    .join('\n');
}

router.get('/', (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;padding:2rem">
    <h1>Landing Generator</h1><p><a href="/admin">Admin Panel →</a></p>
  </body></html>`);
});

router.get('/:slug', (req, res) => {
  const landing = db.prepare(
    'SELECT * FROM landings WHERE slug = ? AND active = 1'
  ).get(req.params.slug);

  if (!landing) return res.status(404).send('Not found');

  const bgUrl        = landing.image_filename ? `/uploads/${landing.image_filename}` : '';
  const panelSide    = landing.panel_side === 'left' ? 'panel-left' : 'panel-right';
  const elementsHtml = buildElements(landing);
  const accentVars   = generateAccentVars(landing.accent_color);
  const accentBlock  = `<style>:root{${accentVars}}</style>`;

  const html = template
    .replace(/\{\{TITLE\}\}/g,           escHtml(landing.title))
    .replace(/\{\{BG_IMAGE_URL\}\}/g,    bgUrl)
    .replace(/\{\{HAS_IMAGE\}\}/g,       bgUrl ? 'has-image' : 'no-image')
    .replace(/\{\{PANEL_SIDE\}\}/g,      panelSide)
    .replace(/\{\{ELEMENTS_HTML\}\}/g,   elementsHtml)
    .replace(/\{\{ACCENT_STYLE_BLOCK\}\}/g, accentBlock);

  res.send(html);
});

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = router;
