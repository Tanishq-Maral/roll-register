const express = require('express');
const multer = require('multer');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');
const { parseTemplate, buildWorkbook } = require('../utils/excel');

const router = express.Router();

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

// Upload an existing Excel sheet. Its header row becomes the fields to fill.
router.post('/', upload.single('file'), (req, res) => {
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

  const info = db
    .prepare(
      `INSERT INTO templates (user_id, name, original_filename, sheet_name, headers_json, existing_rows_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user.id,
      name,
      req.file.originalname,
      parsed.sheetName,
      JSON.stringify(parsed.headers),
      JSON.stringify(parsed.existingRows)
    );

  res.json({
    template: {
      id: info.lastInsertRowid,
      name,
      headers: parsed.headers,
      existingRowCount: parsed.existingRows.length,
    },
  });
});

router.get('/', (req, res) => {
  const rows = db
    .prepare(
      'SELECT id, name, sheet_name, headers_json, existing_rows_json, created_at FROM templates WHERE user_id = ? ORDER BY created_at DESC'
    )
    .all(req.user.id);

  const templates = rows.map((r) => ({
    id: r.id,
    name: r.name,
    sheetName: r.sheet_name,
    headers: JSON.parse(r.headers_json),
    existingRowCount: JSON.parse(r.existing_rows_json).length,
    createdAt: r.created_at,
  }));
  res.json({ templates });
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM templates WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Sheet not found.' });
  res.json({
    template: {
      id: row.id,
      name: row.name,
      sheetName: row.sheet_name,
      headers: JSON.parse(row.headers_json),
      existingRowCount: JSON.parse(row.existing_rows_json).length,
      createdAt: row.created_at,
    },
  });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM templates WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Sheet not found.' });
  res.json({ ok: true });
});

// Download: original header + original rows + every reviewed record saved so far.
router.get('/:id/export', (req, res) => {
  const row = db.prepare('SELECT * FROM templates WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Sheet not found.' });

  const headers = JSON.parse(row.headers_json);
  const existingRows = JSON.parse(row.existing_rows_json);
  const records = db
    .prepare('SELECT data_json FROM records WHERE template_id = ? AND user_id = ? ORDER BY created_at ASC')
    .all(row.id, req.user.id)
    .map((r) => JSON.parse(r.data_json));

  const buffer = buildWorkbook(headers, existingRows, records, row.sheet_name);
  const filename = `${row.name.replace(/[^a-z0-9-_ ]/gi, '_')}_export.xlsx`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

module.exports = router;
