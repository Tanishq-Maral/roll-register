const express = require('express');
const multer = require('multer');
const { db } = require('../lib/firebaseAdmin');
const { requireAuth } = require('../middleware/auth');
const { parseTemplate, buildWorkbook } = require('../utils/excel');

const router = express.Router();
const templates = db.collection('templates');
const records = db.collection('records');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
    ];
    if (okTypes.includes(file.mimetype) || /\.(xlsx|xls)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Please upload an Excel file (.xlsx or .xls).'));
    }
  },
});

router.use(requireAuth);

// Deletes documents matching a query in chunks, since a single Firestore
// batch write is capped at 500 operations.
async function deleteAllMatching(query) {
  const snap = await query.get();
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 450) {
    const batch = db.batch();
    docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

// Upload an existing Excel sheet. Its header row becomes the fields to fill.
router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const name = ((req.body && req.body.name) || req.file.originalname || 'Untitled sheet').trim();

    let parsed;
    try {
      parsed = parseTemplate(req.file.buffer);
    } catch (err) {
      return res.status(400).json({ error: 'Could not read that file. Make sure it is a valid .xlsx file.' });
    }
    if (!parsed.headers.length) {
      return res
        .status(400)
        .json({ error: 'No header row found. The first row of the sheet should contain your field names.' });
    }

    const docRef = await templates.add({
      userId: req.user.id,
      name,
      originalFilename: req.file.originalname,
      sheetName: parsed.sheetName,
      headers: parsed.headers,
      // Firestore doesn't allow arrays-of-arrays as a field value, so the
      // sheet's existing rows (an array of row arrays) are kept as JSON text
      // instead - same approach the app already uses for record data.
      existingRowsJson: JSON.stringify(parsed.existingRows),
      createdAt: new Date().toISOString(),
    });

    res.json({
      template: {
        id: docRef.id,
        name,
        headers: parsed.headers,
        existingRowCount: parsed.existingRows.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    // Sorted in application code rather than via Firestore orderBy() to
    // avoid requiring a composite index - fine at this app's scale (a
    // teacher's own sheets), and it keeps first-deploy setup to just the
    // env vars in README.md.
    const snap = await templates.where('userId', '==', req.user.id).get();
    const list = snap.docs
      .map((d) => {
        const r = d.data();
        return {
          id: d.id,
          name: r.name,
          sheetName: r.sheetName,
          headers: r.headers,
          existingRowCount: JSON.parse(r.existingRowsJson || '[]').length,
          createdAt: r.createdAt,
        };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

    res.json({ templates: list });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const doc = await templates.doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.user.id) {
      return res.status(404).json({ error: 'Sheet not found.' });
    }
    const r = doc.data();
    res.json({
      template: {
        id: doc.id,
        name: r.name,
        sheetName: r.sheetName,
        headers: r.headers,
        existingRowCount: JSON.parse(r.existingRowsJson || '[]').length,
        createdAt: r.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const ref = templates.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().userId !== req.user.id) {
      return res.status(404).json({ error: 'Sheet not found.' });
    }

    // Firestore has no ON DELETE CASCADE, so the sheet's saved records have
    // to be deleted explicitly.
    await deleteAllMatching(records.where('templateId', '==', req.params.id));
    await ref.delete();

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Download: original header + original rows + every reviewed record saved so far.
router.get('/:id/export', async (req, res, next) => {
  try {
    const doc = await templates.doc(req.params.id).get();
    if (!doc.exists || doc.data().userId !== req.user.id) {
      return res.status(404).json({ error: 'Sheet not found.' });
    }
    const row = doc.data();

    const headers = row.headers;
    const existingRows = JSON.parse(row.existingRowsJson || '[]');

    const recSnap = await records
      .where('templateId', '==', req.params.id)
      .where('userId', '==', req.user.id)
      .get();
    const recordRows = recSnap.docs
      .map((d) => d.data())
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      .map((r) => JSON.parse(r.dataJson));

    const buffer = buildWorkbook(headers, existingRows, recordRows, row.sheetName);
    const filename = `${row.name.replace(/[^a-z0-9-_ ]/gi, '_')}_export.xlsx`;

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
