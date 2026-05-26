require('dotenv').config();
const express = require('express');
const basicAuth = require('express-basic-auth');
const path = require('path');

require('./db');

const adminRouter = require('./routes/admin');
const landingRouter = require('./routes/landing');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/admin', basicAuth({
  users: { [process.env.ADMIN_USER || 'admin']: process.env.ADMIN_PASS || 'changeme123' },
  challenge: true,
  realm: 'Landing Generator',
}), adminRouter);

app.use('/', landingRouter);

app.listen(PORT, () => {
  console.log(`LandingGen running at ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
});
