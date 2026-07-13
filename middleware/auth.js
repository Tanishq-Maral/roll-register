const jwt = require('jsonwebtoken');

// Protects both API routes (returns JSON 401) and page routes (redirects to login).
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) {
    return res.status(401).json({ error: 'Please sign in to continue.' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session expired. Please sign in again.' });
  }
}

module.exports = { requireAuth };
