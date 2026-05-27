const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { OpenAI } = require('openai');
const db = require('../db');
const { UPLOADS_DIR } = require('../paths');

let _openai = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function generateImage(prompt) {
  const model = process.env.OPENAI_IMAGE_MODEL || 'dall-e-3';

  // gpt-image-1 and gpt-image-2 use base64 and don't accept response_format.
  // dall-e-2 and dall-e-3 return a temporary URL.
  const isGptImage = model.startsWith('gpt-image-');

  const params = {
    model,
    prompt,
    n: 1,
    // gpt-image-*: 1536x1024 landscape, dall-e-3: 1792x1024
    size: isGptImage ? '1536x1024' : '1792x1024',
    // gpt-image-*: low/medium/high/auto  |  dall-e-3: standard/hd
    quality: isGptImage ? 'high' : 'hd',
  };

  if (!isGptImage) {
    // Only dall-e-* support response_format
    params.response_format = 'url';
  }

  const response = await getOpenAI().images.generate(params);
  const image = response.data[0];

  const filename = `bg_${Date.now()}.png`;
  const filepath = path.join(UPLOADS_DIR, filename);

  if (image.b64_json) {
    // gpt-image-* always returns base64
    fs.writeFileSync(filepath, Buffer.from(image.b64_json, 'base64'));
  } else if (image.url) {
    // dall-e-* returns a temporary URL — download it
    const res = await axios.get(image.url, { responseType: 'arraybuffer' });
    fs.writeFileSync(filepath, res.data);
  }

  return filename;
}

router.get('/', (req, res) => {
  const landings = db.prepare(
    'SELECT * FROM landings ORDER BY created_at DESC'
  ).all();

  const baseUrl = process.env.BASE_URL || `http://${req.headers.host}`;
  res.send(renderAdmin(landings, baseUrl));
});

router.post('/create', async (req, res) => {
  const { title, subtitle, promo_code, redirect_url, cta_text, image_prompt } = req.body;

  if (!title || !promo_code || !redirect_url || !cta_text) {
    return res.status(400).send('Missing required fields');
  }

  let slug = slugify(promo_code);
  const existing = db.prepare('SELECT id FROM landings WHERE slug = ?').get(slug);
  if (existing) {
    slug = `${slug}-${Date.now()}`;
  }

  let image_filename = '';
  if (image_prompt && image_prompt.trim() && process.env.OPENAI_API_KEY) {
    try {
      image_filename = await generateImage(image_prompt.trim());
    } catch (err) {
      console.error('Image generation failed:', err.message);
    }
  }

  db.prepare(`
    INSERT INTO landings (slug, promo_code, redirect_url, cta_text, title, subtitle, image_prompt, image_filename)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slug, promo_code, redirect_url, cta_text, title, subtitle || '', image_prompt || '', image_filename);

  res.redirect('/admin');
});

router.post('/toggle/:id', (req, res) => {
  db.prepare('UPDATE landings SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE id = ?').run(req.params.id);
  res.redirect('/admin');
});

router.post('/delete/:id', (req, res) => {
  const landing = db.prepare('SELECT image_filename FROM landings WHERE id = ?').get(req.params.id);
  if (landing && landing.image_filename) {
    const fp = path.join(UPLOADS_DIR, landing.image_filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.prepare('DELETE FROM landings WHERE id = ?').run(req.params.id);
  res.redirect('/admin');
});

function renderAdmin(landings, baseUrl) {
  const rows = landings.map(l => `
    <tr class="${l.active ? '' : 'inactive'}">
      <td>
        <a href="${baseUrl}/${l.slug}" target="_blank" class="url-link">
          /${l.slug}
        </a>
      </td>
      <td class="mono">${escHtml(l.promo_code)}</td>
      <td>${escHtml(l.title)}</td>
      <td class="mono">${escHtml(l.cta_text)}</td>
      <td class="date">${l.created_at.slice(0, 16)}</td>
      <td>
        <span class="badge ${l.active ? 'badge-active' : 'badge-inactive'}">
          ${l.active ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td class="actions">
        <a href="${baseUrl}/${l.slug}" target="_blank" class="btn-sm btn-preview">Preview</a>
        <form method="POST" action="/admin/toggle/${l.id}" style="display:inline">
          <button class="btn-sm btn-toggle">${l.active ? 'Deactivate' : 'Activate'}</button>
        </form>
        <form method="POST" action="/admin/delete/${l.id}" style="display:inline"
              onsubmit="return confirm('Delete /${l.slug}?')">
          <button class="btn-sm btn-delete">Delete</button>
        </form>
      </td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Landing Generator — Admin</title>
  <link rel="stylesheet" href="/public/admin.css">
</head>
<body>
  <div class="layout">
    <aside class="sidebar">
      <h1 class="logo">Landing<br>Generator</h1>

      <form method="POST" action="/admin/create" id="createForm">
        <h2>New Landing</h2>

        <label>Title *
          <input name="title" placeholder="احصل على مكافأة 4000 درهم" required>
        </label>

        <label>Subtitle
          <input name="subtitle" placeholder="برموكود:">
        </label>

        <label>Promo Code *
          <input name="promo_code" placeholder="RIFINO50" required style="text-transform:uppercase"
                 oninput="this.value=this.value.toUpperCase()">
        </label>

        <label>Redirect URL *
          <input name="redirect_url" type="url" placeholder="https://1xbet.com/register?promo=RIFINO50" required>
        </label>

        <label>CTA Button Text *
          <input name="cta_text" placeholder="سجل الان" required>
        </label>

        <label>Image Prompt (OpenAI)
          <textarea name="image_prompt" rows="4"
            placeholder="football player kicking ball, dramatic stadium lights, blue purple cinematic atmosphere, photorealistic, 8k"></textarea>
          <span class="hint">Leave empty to use a solid background</span>
        </label>

        <button type="submit" class="btn-create" id="submitBtn">
          <span class="btn-text">Generate &amp; Publish</span>
          <span class="btn-loading" hidden>Generating image…</span>
        </button>
      </form>
    </aside>

    <main class="content">
      <div class="content-header">
        <h2>Published Landings <span class="count">${landings.length}</span></h2>
      </div>

      ${landings.length === 0 ? '<div class="empty">No landings yet. Create your first one!</div>' : `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>URL</th>
              <th>Promo Code</th>
              <th>Title</th>
              <th>CTA</th>
              <th>Created</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      `}
    </main>
  </div>

  <script>
    document.getElementById('createForm').addEventListener('submit', function() {
      const btn = document.getElementById('submitBtn');
      btn.querySelector('.btn-text').hidden = true;
      btn.querySelector('.btn-loading').hidden = false;
      btn.disabled = true;
    });
  </script>
</body>
</html>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = router;
