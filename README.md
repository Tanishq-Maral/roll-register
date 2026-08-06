# Roll Register — scan student forms into Excel

A web app where a user signs up, uploads an Excel sheet, photographs a
student form/report, lets Google Vision OCR read it, reviews/corrects the
fields, and exports back to Excel with the new rows appended.

## Stack

- **Backend:** Node.js + Express
- **Database:** Firebase Firestore — chosen specifically so this app can run
  on Vercel: Vercel's serverless functions get a fresh, read-only filesystem
  on every request, so a file database (like SQLite) can't persist data
  there. Firestore is a normal network database, so it works identically
  locally and on Vercel.
- **Auth:** email + password, bcrypt-hashed, JWT stored in an httpOnly cookie
- **OCR:** Google Cloud Vision API, called from the server using a single key
  set in an env var (never touches the browser or any individual user's
  account) — see **"Staying on the free tier"** below for how usage is capped
- **Excel:** `xlsx` (SheetJS) — reads your uploaded sheet's header row and
  existing rows, and rebuilds them on export
- **Frontend:** plain HTML/CSS/JS (no build step)

## 1. Set up Firestore

1. Go to https://console.firebase.google.com and create a project (or reuse
   an existing one).
2. Open **Build → Firestore Database → Create database**, and start it in
   **Native mode** (any region is fine).
3. Go to **Project settings (gear icon) → Service accounts → Generate new
   private key**. This downloads a JSON file — keep it private, it's a
   credential. You'll need three values out of it in the next step:
   `project_id`, `client_email`, and `private_key`.

## 2. Get a Google Vision API key

1. Create/select a project at https://console.cloud.google.com
2. Enable the **Cloud Vision API**.
3. Create an API key under **APIs & Services → Credentials**.
4. (Recommended) restrict the key to the Vision API only.

This one key is shared by every user of your deployment — it's an app-level
setting, not something each person enters themselves.

## 3. Configure environment variables

```bash
cd roll-register
npm install
cp .env.example .env
```

Open `.env` and fill in:
- `JWT_SECRET` — a long random string, e.g.
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- `GOOGLE_VISION_API_KEY` — from step 2.
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` —
  from the service account JSON in step 1. Keep the `\n` escapes in the
  private key as-is in the `.env` file; the app converts them to real
  newlines itself.
- `MONTHLY_OCR_LIMIT` — see below. Defaults to `500`.

## 4. Run it locally

```bash
npm start
```

Then open **http://localhost:3000** — you'll land on the sign-in page.

## 5. Deploy to Vercel

This repo already includes a `vercel.json`, so deployment is just:

```bash
npm install -g vercel   # if you don't have it
vercel
```

or connect the repo in the Vercel dashboard (**New Project → Import**). Either
way, before the first deploy (or right after, then redeploy), add the same
variables from your `.env` as **Environment Variables** in the Vercel project
settings: `JWT_SECRET`, `GOOGLE_VISION_API_KEY`, `FIREBASE_PROJECT_ID`,
`FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `MONTHLY_OCR_LIMIT`, and set
`NODE_ENV=production`. For `FIREBASE_PRIVATE_KEY`, paste it into Vercel's
value field with the `\n` escapes intact, same as in `.env`.

Camera capture (`getUserMedia`) needs a secure context — Vercel serves
everything over HTTPS by default, so this works out of the box once deployed.

## Staying on the free tier (the 500-scan cap)

Google Cloud Vision's free tier is **1,000 requests/month**, and this app
enforces a shared, app-wide cap of **500 requests/month by default** — half
the free allowance — so normal use shouldn't come close to being billed, even
with several users combined.

How it works:

- Every scan ("Extract text") is one Vision API call. Regardless of which
  user makes it, that call is counted against **one shared monthly counter**
  stored in Firestore (`usage/{YYYY-MM}`), not a per-user counter.
- Before each call, the server reserves one unit of that counter inside a
  Firestore transaction. If the cap has already been reached, the request is
  rejected with a clear message and **the Vision API is never called** — so
  it's not possible to exceed the cap, even if multiple users scan at the
  same instant (see `lib/quota.js` for exactly how the transaction prevents
  that race condition).
- The counter resets automatically on the 1st of each month (it's keyed by
  calendar month, so a new month just starts a fresh counter — no cron job
  needed).
- The current month's usage is shown on the dashboard ("Shared OCR quota this
  month"), and is also available at `GET /api/scans/usage`.
- The limit is one env var: `MONTHLY_OCR_LIMIT` (default `500`). Raise it if
  you want to use more of the 1,000 free requests, but leave some margin —
  Google's console can take a little time to reflect same-day usage, so a
  cap set exactly at 1,000 risks a slow response there costing you a charge.

## 6. Using the app

1. **Create an account** (or sign in, if you already have one) — every page
   except the sign-in/sign-up screens requires an active session.
2. **Upload a sheet:** pick an existing `.xlsx` file. Its first row is read as
   the field names to fill (e.g. `Name`, `Roll No`, `Class`, `Marks`); any
   rows already in the sheet are kept and will reappear in your export.
3. **Scan a form:** on a sheet's "Scan a form" page, take a photo with your
   camera or upload one. Click **Extract text**. Matched fields are filled in
   automatically: the header text from your sheet is located verbatim in the
   scanned image (tolerating small OCR misreads), and everything between one
   label and the next becomes that field's value — see
   `utils/fieldMatcher.js`.
4. **Review:** anything not auto-matched is left blank. Click a field, then
   click the matching line in the "Extracted text" panel to fill it in one
   click, or just type the correction directly.
5. **Save this record**, then scan the next form — repeat for a whole batch.
6. **View saved records** for a sheet: edit any cell inline, delete rows you
   don't want, and hit **Export to Excel** to download the original sheet
   with your new rows appended.

## Notes & limits

- Only one Google Vision API key is needed, shared by every user of this
  deployment and never sent to the browser.
- Every page other than sign-in/sign-up requires an authenticated session.
  This is enforced in three places: the server refuses to even serve
  `dashboard.html`/`scan.html`/`records.html` without a valid session cookie
  (`server.js`'s `pageAuthGuard`), every API route re-checks it
  (`middleware/auth.js`), and the frontend redirects to `/login.html` if a
  logged-out user's session expires mid-visit.
- Each user's sheets and records are private to their account (enforced at
  the database query level, not just the UI).
- File upload limits: 10 MB for images, 10 MB for Excel files (adjust in
  `routes/scans.js` / `routes/templates.js` if needed). Uploaded files are
  processed in memory and never written to disk — required for Vercel's
  serverless functions, which don't offer persistent disk storage.
- `NODE_ENV=production` marks the auth cookie `secure`, so it's only sent
  over HTTPS — make sure it's set in your Vercel project's env vars.

## Project structure

```
roll-register/
  server.js                # Express app; exports the app for Vercel, listens locally
  vercel.json               # Vercel build/routing config
  lib/
    firebaseAdmin.js        # Firestore connection (service account credentials)
    quota.js                 # shared monthly Vision API cap (see above)
  middleware/
    auth.js                  # JWT cookie check
  utils/
    ocr.js                    # Google Vision API call
    fieldMatcher.js            # ordered label matching (bbox-based lines, typo tolerance)
    excel.js                   # read/write .xlsx files
  routes/
    auth.js, templates.js, scans.js, records.js
  public/                   # frontend (static, no build step)
    login.html, register.html, dashboard.html, scan.html, records.html
    css/style.css
    js/api.js, dashboard.js, scan.js, records.js
```

## Firestore data model

- `users/{id}` — `name`, `email`, `passwordHash`, `createdAt`
- `templates/{id}` — one per uploaded Excel sheet: `userId`, `name`,
  `originalFilename`, `sheetName`, `headers` (array), `existingRowsJson`
  (JSON-encoded — Firestore doesn't support arrays-of-arrays), `createdAt`
- `records/{id}` — one per saved/reviewed scan: `templateId`, `userId`,
  `dataJson` (JSON-encoded), `createdAt`, `updatedAt`
- `usage/{YYYY-MM}` — one doc per calendar month: `count` (the shared Vision
  API call counter described above)
