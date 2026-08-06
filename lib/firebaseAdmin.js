// Single shared Firestore connection, built from a Firebase service account.
//
// Firestore (not SQLite) is what makes this app deployable on Vercel: Vercel's
// serverless functions get a fresh, read-only filesystem on every invocation,
// so a file-based database like better-sqlite3 can't persist data between
// requests there. Firestore is a normal network database, so it works the
// same way locally and on Vercel.

const admin = require('firebase-admin');

if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    console.error(
      'Missing Firebase credentials. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, ' +
        'and FIREBASE_PRIVATE_KEY (see .env.example) before starting the server.'
    );
    process.exit(1);
  }

  // Most places you paste an env var (Vercel's dashboard, a .env file) store
  // a multi-line private key with literal "\n" characters instead of real
  // newlines. Turn those back into real newlines before handing it to the
  // Firebase SDK, or auth will fail with a cryptic "invalid PEM" error.
  privateKey = privateKey.replace(/\\n/g, '\n');

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

const db = admin.firestore();

module.exports = { admin, db };
