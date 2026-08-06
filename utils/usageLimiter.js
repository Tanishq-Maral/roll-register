const db = require('../db/db');

// Google's Vision API free tier is 1,000 requests/month. Default the cap
// well under that (500) so normal month-to-month usage variance can never
// accidentally tip into a billed request. Override via .env if you want a
// different safety margin.
const MONTHLY_LIMIT = parseInt(process.env.VISION_MONTHLY_LIMIT || '500', 10);

// Keys the counter by calendar month (UTC), e.g. "vision:2026-08". A new
// key naturally starts a fresh count of 0 on the 1st of each month -
// there's no cron job or reset step needed.
function currentPeriodKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `vision:${y}-${m}`;
}

// Atomically reserves one call against this month's shared quota, summed
// across every user of the app. Returns { allowed, used, limit }.
//
// This has to be a single atomic SQL statement rather than "read the
// count, check it, then write" - two requests arriving at (almost) the
// same moment, possibly on different serverless instances, must not both
// read "499" and both proceed, which would let combined usage sneak past
// the cap. The UPDATE's WHERE clause makes the increment conditional on
// still being under the limit, all in one round trip: either it updates
// (and rowsAffected is 1 - allowed) or it doesn't (rowsAffected is 0 -
// blocked), with no window in between for another request to interleave.
async function tryConsumeVisionCall() {
  const id = currentPeriodKey();
  const result = await db.run(
    `INSERT INTO usage_counters (id, count) VALUES (?, 1)
     ON CONFLICT(id) DO UPDATE SET count = count + 1 WHERE count < ?`,
    [id, MONTHLY_LIMIT]
  );
  const row = await db.get('SELECT count FROM usage_counters WHERE id = ?', [id]);
  const used = row ? row.count : 0;
  return { allowed: result.changes > 0, used, limit: MONTHLY_LIMIT };
}

// Read-only check, e.g. for a "X/500 scans used this month" display -
// does not consume a call.
async function getVisionUsage() {
  const id = currentPeriodKey();
  const row = await db.get('SELECT count FROM usage_counters WHERE id = ?', [id]);
  return { used: row ? row.count : 0, limit: MONTHLY_LIMIT };
}

module.exports = { tryConsumeVisionCall, getVisionUsage, MONTHLY_LIMIT };
