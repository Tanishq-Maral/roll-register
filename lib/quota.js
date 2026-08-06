// Enforces a shared, app-wide monthly cap on Google Vision API calls, so the
// combined usage of every user on this deployment stays under Google's free
// tier (1,000 requests/month) and nothing ever gets billed.
//
// The cap defaults to 500 - well under the 1,000 free requests - to leave a
// safety margin against any single-project other usage and to make the cap
// easy to reason about. Override it with MONTHLY_OCR_LIMIT if you want to
// use more (or less) of the free tier.
//
// One Firestore document (usage/{YYYY-MM}) holds a single running counter
// for the current calendar month. It resets automatically each month simply
// because a new document id starts being used - no cron job needed.

const { db, admin } = require('./firebaseAdmin');

const MONTHLY_LIMIT = Number(process.env.MONTHLY_OCR_LIMIT || 500);

function currentMonthKey(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// Atomically reserves one unit of this month's shared OCR quota and throws
// if the cap has already been reached.
//
// This must be called - and must succeed - BEFORE the Google Vision API is
// called, not after. Reserving first, inside a Firestore transaction, is
// what guarantees the cap can never be exceeded even if many users' scans
// land at the exact same moment: Firestore transactions serialize the
// read-check-increment so only requests that see the counter still under
// the limit are allowed to proceed, no matter how many arrive concurrently.
//
// The tradeoff: if the Vision call itself fails after a successful
// reservation (bad image, network blip, etc.), that reserved unit is not
// refunded. That's intentional - refunding on failure would reopen the race
// condition this exists to close. In practice it just means the cap is
// slightly conservative, never that it can be exceeded.
async function reserveOcrCall() {
  const monthKey = currentMonthKey();
  const ref = db.collection('usage').doc(monthKey);

  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = snap.exists ? snap.data().count || 0 : 0;

    if (count >= MONTHLY_LIMIT) {
      return { ok: false, count, limit: MONTHLY_LIMIT };
    }

    tx.set(
      ref,
      { count: count + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    return { ok: true, count: count + 1, limit: MONTHLY_LIMIT };
  });

  if (!result.ok) {
    const err = new Error(
      `This app's shared monthly OCR quota (${result.limit} scans) has been reached. ` +
        `It resets at the start of next month. Ask the app owner to raise MONTHLY_OCR_LIMIT ` +
        `if you need more headroom within Google's free tier.`
    );
    err.code = 'QUOTA_EXCEEDED';
    err.status = 429;
    throw err;
  }

  return result;
}

async function getUsage() {
  const monthKey = currentMonthKey();
  const snap = await db.collection('usage').doc(monthKey).get();
  const count = snap.exists ? snap.data().count || 0 : 0;
  return {
    month: monthKey,
    count,
    limit: MONTHLY_LIMIT,
    remaining: Math.max(0, MONTHLY_LIMIT - count),
  };
}

module.exports = { reserveOcrCall, getUsage, MONTHLY_LIMIT };
