const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { db } = require('../lib/firebaseAdmin');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const users = db.collection('users');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, process.env.JWT_SECRET, {
    expiresIn: '7d',
  });
}

function setAuthCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

router.post('/register', loginLimiter, async (req, res, next) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are all required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const existingSnap = await users.where('email', '==', normalizedEmail).limit(1).get();
    if (!existingSnap.empty) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const hash = bcrypt.hashSync(password, 10);
    const trimmedName = String(name).trim();
    const docRef = await users.add({
      name: trimmedName,
      email: normalizedEmail,
      passwordHash: hash,
      createdAt: new Date().toISOString(),
    });

    const user = { id: docRef.id, email: normalizedEmail, name: trimmedName };
    setAuthCookie(res, signToken(user));
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const snap = await users
      .where('email', '==', String(email).toLowerCase().trim())
      .limit(1)
      .get();

    if (snap.empty) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const doc = snap.docs[0];
    const data = doc.data();
    if (!bcrypt.compareSync(password, data.passwordHash)) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    const user = { id: doc.id, email: data.email, name: data.name };
    setAuthCookie(res, signToken(user));
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const doc = await users.doc(req.user.id).get();
    if (!doc.exists) return res.status(404).json({ error: 'User not found.' });
    const data = doc.data();
    res.json({ user: { id: doc.id, name: data.name, email: data.email } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
