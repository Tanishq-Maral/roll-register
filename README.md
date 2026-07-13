# Roll Register — scan student forms into Excel

A small multi-user web app: sign up, upload an Excel sheet, photograph a
student form/report, let Google Vision OCR read it, review/correct the
fields, and export back to Excel with the new rows appended.

## Stack

- **Backend:** Node.js + Express
- **Database:** SQLite (via `better-sqlite3`) — a single file at `data/app.db`, no separate DB server needed
- **Auth:** email + password, bcrypt-hashed, JWT stored in an httpOnly cookie
- **OCR:** Google Cloud Vision API, called from the server using a single key set in `.env` (never touches the browser or any individual user's account)
- **Excel:** `xlsx` (SheetJS) — reads your uploaded sheet's header row and existing rows, and rebuilds them on export
- **Frontend:** plain HTML/CSS/JS (no build step)

## 1. Prerequisites

- Node.js 18 or later (`node -v` to check)
- A Google Cloud Vision API key for the server to use (shared by all users of
  this deployment, not something each user enters themselves):
  1. Create/select a project at https://console.cloud.google.com
  2. Enable the **Cloud Vision API**
  3. Create an API key under **APIs & Services → Credentials**
  4. (Recommended) restrict the key to the Vision API only

## 2. Install and configure

```bash
cd student-ocr-app
npm install
cp .env.example .env
```

Open `.env` and set:
- `JWT_SECRET` — a long random string, e.g.
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- `GOOGLE_VISION_API_KEY` — the Vision API key from step 1. The server won't
  start without this.

## 3. Run it

```bash
npm start
```

Then open **http://localhost:3000** — you'll land on the sign-in page.

## 4. Using the app

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

- Only one Google Vision API key is needed, in `.env` — it's shared by every
  user of this deployment and never touches the browser.
- Every page other than sign-in/sign-up requires an authenticated session.
  This is enforced in three places: the server refuses to even serve
  `dashboard.html`/`scan.html`/`records.html` without a valid session cookie
  (`server.js`'s `pageAuthGuard`), every API route re-checks it
  (`middleware/auth.js`), and the frontend redirects to `/login.html` if a
  logged-out user's session expires mid-visit.
- Each user's sheets and records are private to their account (enforced at
  the database query level, not just the UI).
- File upload limits: 10 MB for images, 10 MB for Excel files (adjust in
  `routes/scans.js` / `routes/templates.js` if needed).
- For production use behind HTTPS, set `NODE_ENV=production` in `.env` so
  the auth cookie is marked `secure`.
- Camera capture (`getUserMedia`) requires a secure context — it works on
  `localhost` for local development, but needs HTTPS once you deploy.
- Database and uploaded files live in `data/` and `uploads/` — back those up
  if you care about the data; deleting `data/app.db` resets the app.

## Project structure

```
student-ocr-app/
  server.js              # Express app entry point
  db/
    schema.sql            # table definitions
    db.js                 # SQLite connection
  middleware/
    auth.js                # JWT cookie check
  utils/
    ocr.js                 # Google Vision API call
    fieldMatcher.js         # ordered label matching (bbox-based lines, typo tolerance)
    excel.js                # read/write .xlsx files
  routes/
    auth.js, templates.js, scans.js, records.js
  public/                 # frontend (static, no build step)
    login.html, register.html, dashboard.html, scan.html, records.html
    css/style.css
    js/api.js, dashboard.js, scan.js, records.js
```