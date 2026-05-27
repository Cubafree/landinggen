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

const CYRILLIC_MAP = {
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'y',
  к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',
  х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
};

function slugify(text) {
  const transliterated = text.toLowerCase().split('').map(ch => CYRILLIC_MAP[ch] ?? ch).join('');
  const slug = transliterated
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `promo-${Date.now()}`;
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

  console.log(`[img] Requesting — model=${model} size=${params.size} quality=${params.quality}`);
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
    console.log(`[img] Saved → ${filepath} (${(buf.length / 1024).toFixed(0)} KB)`);
  } else if (image.url) {
    console.log(`[img] Downloading from URL…`);
    const res = await axios.get(image.url, { responseType: 'arraybuffer' });
    fs.writeFileSync(filepath, res.data);
    console.log(`[img] Downloaded → ${filepath} (${(res.data.byteLength / 1024).toFixed(0)} KB)`);
  } else {
    throw new Error('OpenAI returned neither b64_json nor url');
  }

  return filename;
}

/** Fire image generation in the background and update DB when done. */
function generateImageBackground(landingId, slug, prompt) {
  generateImage(prompt)
    .then(filename => {
      db.prepare(`
        UPDATE landings SET image_filename = ?, image_status = 'ready' WHERE id = ?
      `).run(filename, landingId);
      console.log(`[bg] ✓ Image ready for /${slug}: ${filename}`);
    })
    .catch(err => {
      db.prepare(`
        UPDATE landings SET image_status = 'failed' WHERE id = ?
      `).run(landingId);
      console.error(`[bg] ✗ Image generation failed for /${slug}:`);
      console.error(err);
    });
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const landings = db.prepare('SELECT * FROM landings ORDER BY created_at DESC').all();
  const baseUrl = process.env.BASE_URL || `http://${req.headers.host}`;
  res.send(renderAdmin(landings, baseUrl));
});

// Lightweight polling endpoint — admin panel JS calls this every 5s
router.get('/status', (req, res) => {
  const pending = db.prepare(`SELECT COUNT(*) as n FROM landings WHERE image_status = 'pending'`).get().n;
  res.json({ pending });
});

router.post('/create', async (req, res) => {
  try {
    const {
      title, subtitle, promo_code, redirect_url, cta_text,
      image_prompt, panel_side, layer_order,
    } = req.body;
    console.log(`[create] promo_code=${promo_code}`);

    if (!title || !promo_code || !redirect_url || !cta_text) {
      return res.status(400).send('Missing required fields');
    }

    let slug = slugify(promo_code);
    if (db.prepare('SELECT id FROM landings WHERE slug = ?').get(slug)) {
      slug = `${slug}-${Date.now()}`;
      console.log(`[create] Slug collision — using ${slug}`);
    }

    const hasPrompt    = image_prompt && image_prompt.trim() && process.env.OPENAI_API_KEY;
    const image_status = hasPrompt ? 'pending' : 'none';
    const pSide        = panel_side  || 'right';
    const lOrder       = layer_order || 'logo,title,subtitle,promo,cta';

    const result = db.prepare(`
      INSERT OR IGNORE INTO landings
        (slug, promo_code, redirect_url, cta_text, title, subtitle,
         image_prompt, image_filename, image_status, panel_side, layer_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
    `).run(slug, promo_code, redirect_url, cta_text, title, subtitle || '',
           image_prompt || '', image_status, pSide, lOrder);

    if (result.changes === 0) {
      console.warn(`[create] INSERT skipped — slug "${slug}" already exists`);
      return res.redirect('/admin');
    }

    const landingId = result.lastInsertRowid;
    console.log(`[create] Landing saved → /${slug} (id=${landingId}, image_status=${image_status})`);

    if (hasPrompt) {
      console.log(`[create] Image generation started in background`);
      // Don't await — respond immediately, generate in background
      generateImageBackground(landingId, slug, image_prompt.trim());
    } else if (image_prompt && !process.env.OPENAI_API_KEY) {
      console.warn('[create] OPENAI_API_KEY not set — skipping image generation');
    }

    res.redirect('/admin');
  } catch (err) {
    console.error('[create] Unhandled error:');
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

// ─── Admin HTML ───────────────────────────────────────────────────────────────

function imgStatusBadge(l) {
  switch (l.image_status) {
    case 'pending': return `<span class="badge badge-pending">⏳ Generating…</span>`;
    case 'ready':   return `<span class="badge badge-img-ready">🖼 Ready</span>`;
    case 'failed':  return `<span class="badge badge-failed">❌ Failed</span>`;
    default:        return `<span class="badge badge-none">— No image</span>`;
  }
}

// Labels match the form field names exactly
const LAYER_LABELS = {
  logo:     'ЛОГОТИП',
  title:    'ЗАГОЛОВОК',
  subtitle: 'ПОДЗАГОЛОВОК',
  promo:    'ПРОМОКОД',
  cta:      'КНОПКА CTA',
};
const DEFAULT_ORDER = 'logo,title,subtitle,promo,cta';

function renderAdmin(landings, baseUrl) {
  const hasPending = landings.some(l => l.image_status === 'pending');

  const rows = landings.map(l => `
    <tr class="${l.active ? '' : 'inactive'}">
      <td>
        <a href="${baseUrl}/${l.slug}" target="_blank" class="url-link">/${l.slug}</a>
      </td>
      <td class="mono">${escHtml(l.promo_code)}</td>
      <td>${escHtml(l.title)}</td>
      <td class="mono">${escHtml(l.cta_text)}</td>
      <td>${imgStatusBadge(l)}</td>
      <td class="date">${l.created_at.slice(0, 16)}</td>
      <td>
        <span class="badge ${l.active ? 'badge-active' : 'badge-inactive'}">
          ${l.active ? 'Active' : 'Off'}
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

  // Each chip styled to look like the actual landing element it represents
  const CHIP_INNER = {
    logo:     `<span class="sk-handle">⠿</span><span class="sk-logo-chip">1XBET</span>`,
    title:    `<span class="sk-handle">⠿</span><span>ЗАГОЛОВОК</span>`,
    subtitle: `<span class="sk-handle">⠿</span><span>подзаголовок</span>`,
    promo:    `<span class="sk-handle">⠿</span><span>ПРОМОКОД</span><span class="sk-copy-chip">⧉</span>`,
    cta:      `<span class="sk-handle">⠿</span><span>▶ КНОПКА CTA ◀</span>`,
  };
  const layerChips = DEFAULT_ORDER.split(',').map(k => `
    <div class="sk-layer sk-layer-${k}" data-layer="${k}" title="${LAYER_LABELS[k]}">
      ${CHIP_INNER[k]}
    </div>`).join('');

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

    <!-- ══ LEFT: form ══ -->
    <aside class="sidebar">
      <h1 class="logo">Landing<br>Generator</h1>

      <form method="POST" action="/admin/create" id="createForm">
        <!-- Hidden inputs updated by canvas.js via element ID -->
        <input type="hidden" name="panel_side"  id="panelSideInput"  value="right">
        <input type="hidden" name="layer_order" id="layerOrderInput" value="${DEFAULT_ORDER}">

        <h2>Контент</h2>

        <label>Заголовок *
          <input name="title" placeholder="احصل على مكافأة 4000 درهم" required>
        </label>

        <label>Подзаголовок
          <input name="subtitle" placeholder="برموكود:">
        </label>

        <label>Промокод *
          <input name="promo_code" placeholder="RIFINO50" required
                 oninput="this.value=this.value.toUpperCase()">
        </label>

        <label>Redirect URL *
          <input name="redirect_url" type="url"
                 placeholder="https://1xbet.com/register?promo=RIFINO50" required>
        </label>

        <label>Кнопка CTA *
          <input name="cta_text" placeholder="سجل الان" required>
        </label>

        <label>Image Prompt (OpenAI)
          <textarea name="image_prompt" rows="4"
            placeholder="football player kicking ball, dramatic stadium lights, blue purple cinematic, photorealistic, 8k"></textarea>
          <span class="hint">Публикуется сразу · изображение генерируется в фоне (~2 мин)</span>
        </label>

        <button type="submit" class="btn-create" id="submitBtn">
          Опубликовать лендинг
        </button>
      </form>
    </aside>

    <!-- ══ RIGHT: canvas top + history bottom ══ -->
    <main class="content">

      <!-- Layer constructor -->
      <div class="canvas-panel">
        <div class="canvas-panel-header">
          <span class="canvas-panel-title">РАСПОЛОЖЕНИЕ СЛОЁВ</span>
          <div class="sk-side-toggle">
            <button type="button" class="sk-side-btn active" data-side="right">Панель справа</button>
            <button type="button" class="sk-side-btn"        data-side="left" >Панель слева</button>
          </div>
        </div>

        <div class="sk-canvas" id="skCanvas">
          <div class="sk-image-area"><span class="sk-img-icon">🖼</span></div>
          <div class="sk-panel-area" id="skPanelArea">${layerChips}</div>
        </div>
        <p class="hint" style="margin-top:8px">Перетащите слои · позиции передаются в лендинг</p>
      </div>

      <!-- Landings history -->
      <div class="landings-panel">
        <div class="content-header">
          <h2>История генераций <span class="count">${landings.length}</span></h2>
          ${hasPending ? `<span class="generating-note">⏳ Изображение генерируется…</span>` : ''}
        </div>

        ${landings.length === 0 ? '<div class="empty">Нет лендингов. Создайте первый!</div>' : `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>URL</th>
                <th>Промокод</th>
                <th>Заголовок</th>
                <th>CTA</th>
                <th>Изображение</th>
                <th>Создан</th>
                <th>Статус</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        `}
      </div>

    </main>
  </div>

  <script src="/public/canvas.js"></script>
  <script>
    // Poll for pending images and reload when they're done
    (function poll() {
      ${hasPending ? `
      fetch('/admin/status')
        .then(r => r.json())
        .then(data => {
          if (data.pending === 0) {
            location.reload();
          } else {
            setTimeout(poll, 5000);
          }
        })
        .catch(() => setTimeout(poll, 10000));
      ` : '// No pending images'}
    })();
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
