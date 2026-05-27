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
  const isGptImage = model.startsWith('gpt-image-');

  const params = {
    model,
    prompt,
    n: 1,
    size: isGptImage ? '1536x1024' : '1792x1024',
    quality: isGptImage ? 'high' : 'hd',
  };

  if (!isGptImage) {
    params.response_format = 'url';
  }

  console.log(`[img] Requesting image — model=${model} size=${params.size} quality=${params.quality}`);
  console.log(`[img] Prompt: ${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}`);

  const t0 = Date.now();
  const response = await getOpenAI().images.generate(params);
  console.log(`[img] OpenAI responded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const image = response.data[0];
  const filename = `bg_${Date.now()}.png`;
  const filepath = path.join(UPLOADS_DIR, filename);

  if (image.b64_json) {
    const buf = Buffer.from(image.b64_json, 'base64');
    fs.writeFileSync(filepath, buf);
    console.log(`[img] Saved base64 image → ${filepath} (${(buf.length / 1024).toFixed(0)} KB)`);
  } else if (image.url) {
    console.log(`[img] Downloading image from URL…`);
    const res = await axios.get(image.url, { responseType: 'arraybuffer' });
    fs.writeFileSync(filepath, res.data);
    console.log(`[img] Downloaded and saved → ${filepath} (${(res.data.byteLength / 1024).toFixed(0)} KB)`);
  } else {
    throw new Error('OpenAI returned neither b64_json nor url — check model/params');
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
  try {
    const { title, subtitle, promo_code, redirect_url, cta_text, image_prompt } = req.body;

    console.log(`[create] New landing request — promo_code=${promo_code}`);

    if (!title || !promo_code || !redirect_url || !cta_text) {
      console.warn('[create] Missing required fields', { title: !!title, promo_code: !!promo_code, redirect_url: !!redirect_url, cta_text: !!cta_text });
      return res.status(400).send('Missing required fields');
    }

    // Build a unique slug — use INSERT OR IGNORE as the final safety net
    let slug = slugify(promo_code);
    const existing = db.prepare('SELECT id FROM landings WHERE slug = ?').get(slug);
    if (existing) {
      slug = `${slug}-${Date.now()}`;
      console.log(`[create] Slug collision — using ${slug}`);
    }
    console.log(`[create] Slug: ${slug}`);

    let image_filename = '';
    if (image_prompt && image_prompt.trim()) {
      if (!process.env.OPENAI_API_KEY) {
        console.warn('[create] OPENAI_API_KEY is not set — skipping image generation');
      } else {
        console.log('[create] Starting image generation…');
        try {
          image_filename = await generateImage(image_prompt.trim());
          console.log(`[create] Image ready: ${image_filename}`);
        } catch (err) {
          console.error('[create] Image generation failed:');
          console.error(err);
        }
      }
    } else {
      console.log('[create] No image prompt — landing will use gradient background');
    }

    // INSERT OR IGNORE + explicit slug uniqueness: never crashes on duplicate
    const result = db.prepare(`
      INSERT OR IGNORE INTO landings
        (slug, promo_code, redirect_url, cta_text, title, subtitle, image_prompt, image_filename)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(slug, promo_code, redirect_url, cta_text, title, subtitle || '', image_prompt || '', image_filename);

    if (result.changes === 0) {
      // Extremely unlikely after the check above, but handle gracefully
      console.warn(`[create] INSERT skipped — slug "${slug}" already exists`);
    } else {
      console.log(`[create] Landing saved → /${slug}`);
    }

    res.redirect('/admin');
  } catch (err) {
    // Catch-all: log the full error and return 500 instead of crashing the process
    console.error('[create] Unhandled error in /create route:');
    console.error(err);
    res.status(500).send(`
      <h2>Something went wrong</h2>
      <pre>${err.message}</pre>
      <p><a href="/admin">← Back to admin</a></p>
    `);
  }
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
