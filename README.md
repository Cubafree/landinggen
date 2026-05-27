# Landing Generator

Auto-generate and publish promo landing pages via a simple admin form.  
Manager fills in a title, promo code, redirect URL, CTA text and an OpenAI image prompt → landing is live at `/{slug}` immediately.

---

## Deploy to Railway

### 1. Create a new project

[railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → select this repo.

Railway will detect the `Dockerfile` automatically.

---

### 2. Add a Persistent Volume

> **Critical.** Without a volume the SQLite database and generated images are deleted on every deploy.

1. Inside your Railway service → **Volumes** tab → **Add Volume**
2. **Mount path:** `/data`
3. Click **Deploy** to apply

---

### 3. Set environment variables

Railway service → **Variables** tab → add the following:

| Variable | Value | Notes |
|---|---|---|
| `OPENAI_API_KEY` | `sk-...` | Required for image generation |
| `OPENAI_IMAGE_MODEL` | `dall-e-3` | Or `gpt-image-1` |
| `ADMIN_USER` | `admin` | Login for /admin |
| `ADMIN_PASS` | *(strong password)* | **Change this!** |
| `BASE_URL` | `https://your-app.up.railway.app` | Your Railway public URL |
| `DATA_DIR` | `/data` | Matches the volume mount path |

> `PORT` is injected by Railway automatically — do not set it.

---

### 4. Add a custom domain (optional)

Railway service → **Settings** → **Domains** → **Generate Domain** or add your own.  
Update `BASE_URL` to the new domain.

---

### 5. Deploy

Railway redeploys automatically on every `git push`.  
To trigger a manual redeploy: **Deployments** tab → **Redeploy**.

---

## Local development

```bash
cp .env.example .env
# Fill in OPENAI_API_KEY and ADMIN_PASS
# Leave DATA_DIR empty — data goes to ./data/ automatically

npm install
npm start
# → http://localhost:3000/admin
```

---

## How it works

```
/admin          Admin panel (Basic Auth)
  └─ POST /admin/create
       1. Calls OpenAI Images API with the manager's prompt
       2. Downloads and saves the image to DATA_DIR/uploads/
       3. Writes the landing record to DATA_DIR/landings.db
       4. Redirects back to /admin — landing is now live

/:slug          Serves the generated landing page
/uploads/:file  Serves generated background images
/healthz        Health check (used by Railway)
```

---

## Folder structure

```
server.js              Express entry point
paths.js               Central DATA_DIR / UPLOADS_DIR config
db.js                  SQLite initialisation
routes/
  admin.js             Admin CRUD + OpenAI image generation
  landing.js           Landing page serving
templates/
  landing.html         RTL-ready landing page template
public/
  admin.css            Admin panel styles
railway.toml           Railway build + deploy config
Dockerfile             Node 20 Alpine + native build deps
docker-compose.yml     Local Docker alternative
```
