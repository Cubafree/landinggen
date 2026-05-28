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

/**
 * Wraps the user's short scene description with a full cinematic prompt.
 * The accent color is woven into the lighting/particle palette.
 * Right ~40% of the frame is kept dark for the landing panel overlay.
 */
function buildImagePrompt(scene, accentColor) {
  return `
${scene}.
Hyper-realistic cinematic sports photography, 8K ultra-HD, award-winning editorial.
Dynamic action composition, dramatic stadium floodlights with anamorphic lens flares.
Glowing neon particle streams and light trails in ${accentColor} tones radiating from the action.
Electric energy sparks, motion blur on fast-moving elements, bokeh crowd in background.
Atmospheric depth of field, volumetric light rays cutting through stadium haze.
Rich Hollywood colour grading — deep shadows, vibrant midtones, high contrast.
The right 20–25% of the frame softly fades into a deep ${accentColor}-tinted atmosphere — preserve colour richness, do not go pure black.
Photorealistic, Canon EOS R5 85 mm f/1.4 aesthetic, no text, no logos, no watermarks.
`.trim();
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
      image_prompt, panel_side, layer_order, accent_color,
    } = req.body;
    console.log(`[create] promo_code=${promo_code}`);

    if (!title || !promo_code || !redirect_url || !cta_text) {
      return res.status(400).send('Missing required fields');
    }

    // Validate field lengths
    if (title.length > 500 || (subtitle && subtitle.length > 500) ||
        cta_text.length > 200 || redirect_url.length > 2000 ||
        (image_prompt && image_prompt.length > 2000)) {
      return res.status(400).send('One or more fields exceed maximum length');
    }

    // Validate redirect_url — only http/https allowed (no javascript:, data:, etc.)
    try {
      const u = new URL(redirect_url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    } catch {
      return res.status(400).send('redirect_url must be a valid http/https URL');
    }

    // Validate layer_order — only known layer keys
    const VALID_LAYERS = new Set(['logo', 'title', 'subtitle', 'promo', 'cta']);
    const sanitizedLayers = (layer_order || 'logo,title,subtitle,promo,cta')
      .split(',').map(l => l.trim()).filter(l => VALID_LAYERS.has(l));
    const lOrder = sanitizedLayers.length ? sanitizedLayers.join(',') : 'logo,title,subtitle,promo,cta';

    // Rate-limit image generation — max 3 pending at once
    if (image_prompt && image_prompt.trim() && process.env.OPENAI_API_KEY) {
      const pending = db.prepare(`SELECT COUNT(*) as n FROM landings WHERE image_status = 'pending'`).get().n;
      if (pending >= 3) {
        return res.status(429).send('Too many images generating — wait for current ones to finish');
      }
    }

    let slug = slugify(promo_code);
    if (db.prepare('SELECT id FROM landings WHERE slug = ?').get(slug)) {
      slug = `${slug}-${Date.now()}`;
      console.log(`[create] Slug collision — using ${slug}`);
    }

    const accentColor  = /^#[0-9a-f]{6}$/i.test(accent_color) ? accent_color : '#6c47ff';
    const hasPrompt    = image_prompt && image_prompt.trim() && process.env.OPENAI_API_KEY;
    const image_status = hasPrompt ? 'pending' : 'none';
    const pSide        = (panel_side === 'left') ? 'left' : 'right';

    // Build full cinematic prompt from user's short scene description
    const finalPrompt = hasPrompt
      ? buildImagePrompt(image_prompt.trim(), accentColor)
      : '';

    const result = db.prepare(`
      INSERT OR IGNORE INTO landings
        (slug, promo_code, redirect_url, cta_text, title, subtitle,
         image_prompt, image_filename, image_status, panel_side, layer_order, accent_color)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)
    `).run(slug, promo_code, redirect_url, cta_text, title, subtitle || '',
           image_prompt || '', image_status, pSide, lOrder, accentColor);

    if (result.changes === 0) {
      console.warn(`[create] INSERT skipped — slug "${slug}" already exists`);
      return res.redirect('/admin');
    }

    const landingId = result.lastInsertRowid;
    console.log(`[create] Landing saved → /${slug} (id=${landingId}, accent=${accentColor}, image_status=${image_status})`);

    if (hasPrompt) {
      console.log(`[create] Image generation started in background`);
      generateImageBackground(landingId, slug, finalPrompt);
    } else if (image_prompt && !process.env.OPENAI_API_KEY) {
      console.warn('[create] OPENAI_API_KEY not set — skipping image generation');
    }

    res.redirect('/admin');
  } catch (err) {
    console.error('[create] Unhandled error:', err);
    res.status(500).send(
      `<h2>Something went wrong</h2><p><a href="/admin">← Back to admin</a></p>`
    );
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
    logo:     `<span class="sk-handle">⠿</span><img src="/public/logo.svg" class="sk-logo-img" alt="Logo">`,
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
          <input name="title" placeholder="احصل على مكافأة 4000 درهم" required maxlength="500">
        </label>

        <label>Подзаголовок
          <input name="subtitle" placeholder="برموكود:" maxlength="500">
        </label>

        <label>Промокод *
          <input name="promo_code" placeholder="RIFINO50" required maxlength="100"
                 oninput="this.value=this.value.toUpperCase()">
        </label>

        <label>Redirect URL *
          <input name="redirect_url" type="url"
                 placeholder="https://1xbet.com/register?promo=RIFINO50" required maxlength="2000">
        </label>

        <label>Кнопка CTA *
          <input name="cta_text" placeholder="سجل الان" required maxlength="200">
        </label>

        <!-- input OUTSIDE label so label click doesn't auto-open color picker -->
        <input type="color" name="accent_color" id="accentColorInput" value="#6c47ff"
               style="position:absolute;opacity:0;width:0;height:0;pointer-events:none">
        <div class="label-text">Акцентный цвет</div>
        <div class="color-swatches">
          <span class="color-swatch active" data-color="#6c47ff" style="background:#6c47ff" title="Фиолетовый"></span>
          <span class="color-swatch" data-color="#e63946" style="background:#e63946" title="Красный"></span>
          <span class="color-swatch" data-color="#f59e0b" style="background:#f59e0b" title="Золотой"></span>
          <span class="color-swatch" data-color="#10b981" style="background:#10b981" title="Зелёный"></span>
          <span class="color-swatch" data-color="#0ea5e9" style="background:#0ea5e9" title="Синий"></span>
          <span class="color-swatch" data-color="#f97316" style="background:#f97316" title="Оранжевый"></span>
          <span class="color-swatch color-swatch-custom" id="customColorSwatch" title="Свой цвет"></span>
        </div>
        <span class="color-hex" id="accentHex">#6C47FF</span>
        <p class="hint" style="margin-bottom:14px">Цвет акцента передаётся в промпт и все UI-элементы лендинга</p>

        <label>Сцена для изображения
          <textarea name="image_prompt" rows="3"
            placeholder="футболист бьёт по мячу на стадионе&#10;боксёр в углу ринга, прожекторы&#10;гонщик Формулы 1 на повороте"></textarea>
          <span class="hint">Опишите сцену кратко — стиль, частицы и кинематограф добавляются автоматически · генерация ~2 мин</span>
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
    // ── Accent color picker ───────────────────────────────────────────────────
    (function() {
      const input        = document.getElementById('accentColorInput');
      const hexLabel     = document.getElementById('accentHex');
      const presets      = document.querySelectorAll('.color-swatch:not(.color-swatch-custom)');
      const customSwatch = document.getElementById('customColorSwatch');

      function applyAccent(color, isCustom) {
        input.value          = color;
        hexLabel.textContent = color.toUpperCase();
        hexLabel.style.color = color;
        // Live-update canvas chips
        document.querySelectorAll('.sk-layer-promo').forEach(el => el.style.borderColor = color);
        document.querySelectorAll('.sk-layer-cta').forEach(el => el.style.background = color);
        // Active state
        presets.forEach(s => s.classList.toggle('active', !isCustom && s.dataset.color === color));
        if (isCustom) {
          customSwatch.classList.add('active');
          customSwatch.style.background = color;
        } else {
          customSwatch.classList.remove('active');
          customSwatch.style.background = ''; // restore rainbow gradient
        }
      }

      // Preset swatches
      presets.forEach(s => s.addEventListener('click', () => applyAccent(s.dataset.color, false)));

      // Custom swatch → open native OS picker
      customSwatch.addEventListener('click', () => input.click());

      // Native picker value change → apply as custom color
      input.addEventListener('input', e => applyAccent(e.target.value, true));
    })();

    // ── Poll for pending images ───────────────────────────────────────────────
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
