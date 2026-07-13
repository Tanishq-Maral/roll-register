const express = require('express');
const multer = require('multer');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');
const { extractTextFromImage } = require('../utils/ocr');
const { mapWordsToHeaders } = require('../utils/fieldMatcher');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Please upload an image file.'));
  },
});

router.use(requireAuth);

router.post('/extract', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

  const { templateId } = req.body || {};
  if (!templateId) return res.status(400).json({ error: 'templateId is required.' });

  const template = db.prepare('SELECT * FROM templates WHERE id = ? AND user_id = ?').get(templateId, req.user.id);
  if (!template) return res.status(404).json({ error: 'Sheet not found.' });

  try {
    const base64 = req.file.buffer.toString('base64');
    const { rawText, words } = await extractTextFromImage(base64, process.env.GOOGLE_VISION_API_KEY);
    const headers = JSON.parse(template.headers_json);
    const { mapped, lines } = mapWordsToHeaders(words, headers);
    res.json({ rawText, lines, mapped });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Text extraction failed.' });
  }
});

module.exports = router;
