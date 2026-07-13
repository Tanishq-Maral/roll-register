const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.post('/', (req, res) => {
  const { templateId, data } = req.body || {};
  if (!templateId || !data) return res.status(400).json({ error: 'templateId and data are required.' });

  const template = db.prepare('SELECT id FROM templates WHERE id = ? AND user_id = ?').get(templateId, req.user.id);
  if (!template) return res.status(404).json({ error: 'Sheet not found.' });

  const info = db
    .prepare('INSERT INTO records (template_id, user_id, data_json) VALUES (?, ?, ?)')
    .run(templateId, req.user.id, JSON.stringify(data));

  res.json({ record: { id: info.lastInsertRowid, templateId: Number(templateId), data } });
});

router.get('/', (req, res) => {
  const { templateId } = req.query;
  if (!templateId) return res.status(400).json({ error: 'templateId query param is required.' });

  const rows = db
    .prepare(
      'SELECT id, data_json, created_at, updated_at FROM records WHERE template_id = ? AND user_id = ? ORDER BY created_at ASC'
    )
    .all(templateId, req.user.id);

  res.json({
    records: rows.map((r) => ({
      id: r.id,
      data: JSON.parse(r.data_json),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

router.put('/:id', (req, res) => {
  const { data } = req.body || {};
  if (!data) return res.status(400).json({ error: 'data is required.' });

  const row = db.prepare('SELECT id FROM records WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Record not found.' });

  db.prepare("UPDATE records SET data_json = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(data),
    req.params.id
  );
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM records WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'Record not found.' });
  res.json({ ok: true });
});

module.exports = router;
