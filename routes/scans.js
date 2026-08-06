const express = require('express');
const multer = require('multer');
const { db } = require('../lib/firebaseAdmin');
const { requireAuth } = require('../middleware/auth');
const { extractTextFromImage } = require('../utils/ocr');
const { mapWordsToHeaders } = require('../utils/fieldMatcher');
const { reserveOcrCall, getUsage } = require('../lib/quota');

const router = express.Router();
const templates = db.collection('templates');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Please upload an image file.'));
  },
});

router.use(requireAuth);

// Lets the frontend show "X / 500 scans used this month" on the dashboard.
router.get('/usage', async (req, res, next) => {
  try {
    const usage = await getUsage();
    res.json({ usage });
  } catch (err) {
    next(err);
  }
});

router.post('/extract', upload.single('image'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded.' });

    const { templateId } = req.body || {};
    if (!templateId) return res.status(400).json({ error: 'templateId is required.' });

    const templateDoc = await templates.doc(templateId).get();
    if (!templateDoc.exists || templateDoc.data().userId !== req.user.id) {
      return res.status(404).json({ error: 'Sheet not found.' });
    }

    // Reserve one unit of the shared monthly Vision API quota BEFORE calling
    // the API. See lib/quota.js for why this has to happen first rather than
    // after a successful call.
    let usage;
    try {
      usage = await reserveOcrCall();
    } catch (err) {
      if (err.code === 'QUOTA_EXCEEDED') return res.status(429).json({ error: err.message });
      throw err;
    }

    try {
      const base64 = req.file.buffer.toString('base64');
      const { rawText, words } = await extractTextFromImage(base64, process.env.GOOGLE_VISION_API_KEY);
      const headers = templateDoc.data().headers;
      const { mapped, lines } = mapWordsToHeaders(words, headers);
      res.json({ rawText, lines, mapped, usage: { count: usage.count, limit: usage.limit } });
    } catch (err) {
      res.status(502).json({ error: err.message || 'Text extraction failed.' });
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
