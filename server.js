require('dotenv').config();

if (!process.env.JWT_SECRET) {
  console.error('Missing JWT_SECRET. Copy .env.example to .env and set one before starting the server.');
  process.exit(1);
}

if (!process.env.GOOGLE_VISION_API_KEY) {
  console.error(
    'Missing GOOGLE_VISION_API_KEY. Copy .env.example to .env and set your Google Cloud Vision API key before starting the server.'
  );
  process.exit(1);
}

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const path = require('path');

const authRoutes = require('./routes/auth');
const templateRoutes = require('./routes/templates');
const scanRoutes = require('./routes/scans');
const recordRoutes = require('./routes/records');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// These pages require a signed-in session. API routes enforce this
// independently (see middleware/auth.js) - this just stops a signed-out
// visitor from ever being served the page itself, rather than relying on
// client-side JS to redirect them after the fact.
const PROTECTED_PAGES = new Set(['/dashboard.html', '/scan.html', '/records.html']);

function pageAuthGuard(req, res, next) {
  if (!PROTECTED_PAGES.has(req.path)) return next();

  const token = req.cookies && req.cookies.token;
  if (!token) return res.redirect('/login.html');

  try {
    jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) {
    res.redirect('/login.html');
  }
}

app.use(pageAuthGuard);

app.use('/api/auth', authRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/scans', scanRoutes);
app.use('/api/records', recordRoutes);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/dashboard.html'));

// Multer / JSON parse / unexpected errors all land here.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong on the server.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Student OCR -> Excel app running at http://localhost:${PORT}`);
});
