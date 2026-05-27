require('dotenv').config();
const express = require('express');
const basicAuth = require('express-basic-auth');
const path = require('path');
const { UPLOADS_DIR } = require('./paths');

// Keep the process alive on unhandled async errors — log and continue
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception:', err);
});

require('./db');

const adminRouter = require('./routes/admin');
const landingRouter = require('./routes/landing');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));

// Serve generated images from the persistent data volume
app.use('/uploads', express.static(UPLOADS_DIR));

// Health check — Railway uses this to confirm the app is up
app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

app.use('/admin', basicAuth({
  users: { [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASS || 'changeme123' },
  challenge: true,
  realm: 'Landing Generator',
}), adminRouter);

app.use('/', landingRouter);

app.listen(PORT, () => {
  console.log(`LandingGen running at ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
});
