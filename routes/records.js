const express = require('express');
const { db } = require('../lib/firebaseAdmin');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const templates = db.collection('templates');
const records = db.collection('records');

router.use(requireAuth);

router.post('/', async (req, res, next) => {
  try {
    const { templateId, data } = req.body || {};
    if (!templateId || !data) return res.status(400).json({ error: 'templateId and data are required.' });

    const templateDoc = await templates.doc(templateId).get();
    if (!templateDoc.exists || templateDoc.data().userId !== req.user.id) {
      return res.status(404).json({ error: 'Sheet not found.' });
    }

    const now = new Date().toISOString();
    const docRef = await records.add({
      templateId,
      userId: req.user.id,
      dataJson: JSON.stringify(data),
      createdAt: now,
      updatedAt: now,
    });

    res.json({ record: { id: docRef.id, templateId, data } });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { templateId } = req.query;
    if (!templateId) return res.status(400).json({ error: 'templateId query param is required.' });

    const snap = await records
      .where('templateId', '==', templateId)
      .where('userId', '==', req.user.id)
      .get();

    const list = snap.docs
      .map((d) => {
        const r = d.data();
        return { id: d.id, data: JSON.parse(r.dataJson), createdAt: r.createdAt, updatedAt: r.updatedAt };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

    res.json({ records: list });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const { data } = req.body || {};
    if (!data) return res.status(400).json({ error: 'data is required.' });

    const ref = records.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().userId !== req.user.id) {
      return res.status(404).json({ error: 'Record not found.' });
    }

    await ref.update({ dataJson: JSON.stringify(data), updatedAt: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const ref = records.doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists || doc.data().userId !== req.user.id) {
      return res.status(404).json({ error: 'Record not found.' });
    }
    await ref.delete();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
