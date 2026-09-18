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

router.post(
  '/extract',
  upload.fields([
    { name: 'images', maxCount: 10 },
    { name: 'image', maxCount: 1 },
  ]),
  async (req, res, next) => {
  try {
    const files = [
      ...((req.files && req.files.images) || []),
      ...((req.files && req.files.image) || []),
    ];
    if (!files.length) return res.status(400).json({ error: 'No image uploaded.' });

    const { templateId } = req.body || {};
    if (!templateId) return res.status(400).json({ error: 'templateId is required.' });

    const templateDoc = await templates.doc(templateId).get();
    if (!templateDoc.exists || templateDoc.data().userId !== req.user.id) {
      return res.status(404).json({ error: 'Sheet not found.' });
    }

    try {
      const allWords = [];
      const rawTexts = [];
      let usage;
      let yOffset = 0;

      for (const file of files) {
        // Reserve quota immediately before each Vision request so a batch
        // cannot call the API without accounting for every page.
        try {
          usage = await reserveOcrCall();
        } catch (err) {
          if (err.code === 'QUOTA_EXCEEDED') return res.status(429).json({ error: err.message });
          throw err;
        }

        const base64 = file.buffer.toString('base64');
        const { rawText, words } = await extractTextFromImage(base64, process.env.GOOGLE_VISION_API_KEY);
        rawTexts.push(rawText);
        words.forEach((word) => allWords.push({
          ...word,
          y0: word.y0 + yOffset,
          y1: word.y1 + yOffset,
        }));
        const pageBottom = words.reduce((max, word) => Math.max(max, word.y1), 0);
        yOffset += pageBottom + 100;
      }

      const headers = templateDoc.data().headers;
      const { mapped, lines } = mapWordsToHeaders(allWords, headers);
      res.json({ rawText: rawTexts.join('\n'), lines, mapped, usage: { count: usage.count, limit: usage.limit } });
    } catch (err) {
      res.status(502).json({ error: err.message || 'Text extraction failed.' });
    }
  } catch (err) {
    next(err);
  }
  }
);

module.exports = router;
