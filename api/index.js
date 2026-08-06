// Vercel treats any file under /api as a serverless function. Exporting the
// Express app directly works because Express apps are themselves valid
// (req, res) request handlers - Vercel's Node runtime calls this exactly
// like it would call a plain handler function.
module.exports = require('../server');
