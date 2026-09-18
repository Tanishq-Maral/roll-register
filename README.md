# Student OCR Excel App

A web application for converting student forms into structured spreadsheet rows. A user uploads an existing Excel sheet, uses a camera or image upload to capture student forms, extracts text with Google Cloud Vision, reviews or corrects the detected fields, saves records, and downloads an Excel export containing the original rows plus the new records.

## Contents

- [Product workflow](#product-workflow)
- [Architecture](#architecture)
- [Technology choices](#technology-choices)
- [Application workflow](#application-workflow)
- [OCR and field matching](#ocr-and-field-matching)
- [Excel processing](#excel-processing)
- [API reference](#api-reference)
- [Data model](#data-model)
- [Security and limits](#security-and-limits)
- [Project structure](#project-structure)
- [Local setup](#local-setup)
- [Vercel deployment](#vercel-deployment)
- [Known limitations and legacy files](#known-limitations-and-legacy-files)

## Product workflow

1. Register or sign in.
2. Upload an `.xlsx` or `.xls` workbook.
3. The first worksheet's first row becomes the list of fields to fill.
4. Open the sheet's scan page and capture or upload a student form image.
5. The server sends the image to Google Cloud Vision and matches OCR text to the sheet headers.
6. Review the automatic values, choose extracted lines for manual assignment, or type corrections.
7. Save the reviewed student record.
8. Edit or delete saved records from the records page.
9. Export the sheet as a new `.xlsx` file containing the original rows followed by saved records.

## Architecture

The application is a single CommonJS Node.js process with an Express HTTP layer and a static, no-build-step browser frontend.

```text
Browser
  |
  | HTML pages and fetch requests with httpOnly JWT cookie
  v
Express app (server.js)
  |-- pageAuthGuard -> protected HTML pages
  |-- /api/auth      -> registration, login, logout, current user
  |-- /api/templates -> Excel upload, sheet metadata, delete, export
  |-- /api/scans    -> OCR quota, image OCR, field mapping
  |-- /api/records  -> create, list, edit, delete records
  |-- public/       -> static HTML, CSS, and browser JavaScript
  |
  |-- Firebase Admin SDK -> Firestore
  |-- Google Cloud Vision API -> document text detection
  |-- xlsx -> in-memory workbook parsing and export
```

### Request lifecycle

1. `server.js` loads environment variables and validates the required JWT and Vision settings at startup.
2. Helmet, cookie parsing, JSON parsing, and URL-encoded body parsing are installed.
3. `pageAuthGuard` protects `dashboard.html`, `scan.html`, and `records.html` before those files are served.
4. API routers independently run `middleware/auth.js`, so API access cannot bypass the page guard.
5. Routes read and write Firestore through `lib/firebaseAdmin.js`.
6. Uploads use Multer memory storage. Images and workbooks are processed in memory and are not persisted to disk.
7. The final Express error handler converts unexpected failures into JSON error responses.

The same Express app is exported by `api/index.js`. Locally, `server.js` calls `app.listen()`; on Vercel, the platform imports the app as a serverless request handler.

## Technology choices

| Technology | Use | Why it is used |
| --- | --- | --- |
| Node.js 18+ | Server runtime | Provides the JavaScript runtime and built-in `fetch` used by the Vision integration. |
| Express | HTTP server and routing | Keeps page serving, API routing, middleware, and error handling in one small server. |
| Plain HTML, CSS, and browser JavaScript | Frontend | No bundler or build pipeline is required, which keeps local and Vercel deployment simple. |
| Firebase Admin SDK and Firestore | Persistence | A network database works with Vercel's serverless filesystem, which is not a durable application database. |
| JSON Web Tokens and cookies | Sessions | A signed, stateless session can be checked by both page and API requests. |
| bcryptjs | Password hashing | Passwords are stored as bcrypt hashes rather than plaintext. |
| Google Cloud Vision | OCR | Provides document text detection plus word bounding boxes needed for label-to-value matching. |
| `xlsx` (SheetJS) | Excel parsing and export | Reads the first worksheet and produces a downloadable workbook without a separate spreadsheet service. |
| Multer | Multipart uploads | Handles image and workbook uploads with memory storage and a 10 MB file limit. |
| Helmet | HTTP security headers | Adds common browser security headers at the Express boundary. |
| express-rate-limit | Auth abuse protection | Limits registration and login attempts by IP address. |

## Application workflow

### Authentication

The login and registration pages call `/api/auth`. Successful registration or login creates a JWT containing the user identity and sets it in an httpOnly cookie named `token`. The cookie lasts seven days, uses `SameSite=Lax`, and is marked `secure` when `NODE_ENV=production`.

`middleware/auth.js` verifies the cookie on protected API routes and attaches the authenticated user to `req.user`. The frontend also calls `/api/auth/me` and redirects to the login page if a session expires.

### Template upload

`POST /api/templates` accepts a multipart field named `file` and an optional `name`. `utils/excel.js` reads only the first worksheet:

- Row 1 becomes the trimmed, non-empty header list.
- Remaining rows are retained as existing data.
- The parsed sheet name and original filename are stored as metadata.
- Existing rows are serialized as JSON because Firestore does not support the required nested array shape directly.

A template is the reusable definition of a sheet and its fields. It is not the original workbook file; the workbook is parsed and then discarded.

### Scan and review

The scan page loads a user's template, captures an image with `getUserMedia` or accepts an image upload, and sends it to `/api/scans/extract`.

Before upload, the browser resizes the image to a maximum dimension of 1800 pixels and JPEG quality `0.85`. The server validates that the file is an image, checks template ownership, reserves one shared OCR quota unit, calls Vision, and maps the response to the template headers.

The response contains:

- `rawText`: flat text returned by Vision.
- `lines`: OCR text grouped into lines for manual selection.
- `mapped`: values automatically assigned to headers.
- `usage`: current count and configured limit.

The user can accept, edit, or replace every mapped value before saving it as a record.

### Records and export

Saved records belong to both the authenticated user and the template. The records page renders them in header order, saves inline edits on blur, and supports deletion.

Export creates a fresh workbook containing:

1. The stored headers.
2. The original rows from the uploaded sheet.
3. Saved records ordered by creation time and projected into header order.

Exports are always `.xlsx` files. They preserve row data, but not the original workbook's formatting, formulas, column widths, additional worksheets, or other workbook metadata.

## OCR and field matching

`utils/ocr.js` calls Google Cloud Vision's `DOCUMENT_TEXT_DETECTION` endpoint using the server-side `GOOGLE_VISION_API_KEY`. It extracts each detected word and its bounding box, then returns both structured words and flat text.

`utils/fieldMatcher.js` performs the application-specific mapping:

1. Words are grouped into lines using their vertical center and sorted left to right.
2. Header and OCR tokens are normalized using Unicode-aware letters and digits.
3. Headers are matched as ordered contiguous token sequences.
4. Matching uses Damerau-Levenshtein tolerance. Tokens of length 3 or less must match exactly; lengths 4-6 allow one edit; longer tokens allow two edits.
5. A matched field's value is the text after its label and before the next successfully matched header.
6. Missing headers remain blank, and later headers can still be matched.

This approach is designed for forms whose labels correspond to the uploaded sheet's header row. It is not a general-purpose document understanding model.

## Excel processing

`utils/excel.js` reads only the first worksheet. The first row becomes the headers and all later rows are retained. Blank header cells are removed and header text is trimmed.

For export, `buildWorkbook()` creates a new workbook from the stored headers, original rows, and saved records. Each record is projected into the same header order, with missing fields exported as empty strings. The output format is always `.xlsx`, even when the input was `.xls`.

## API reference

All template, scan, and record endpoints require the `token` cookie. Authentication endpoints are public except `/api/auth/me`.

### Authentication endpoints

| Method | Endpoint | Input | Result |
| --- | --- | --- | --- |
| `POST` | `/api/auth/register` | JSON: `name`, `email`, `password`; password must be at least 8 characters | Creates a user, sets the session cookie, returns `user`. |
| `POST` | `/api/auth/login` | JSON: `email`, `password` | Verifies credentials, sets the session cookie, returns `user`. |
| `POST` | `/api/auth/logout` | None | Clears the session cookie and returns `{ ok: true }`. |
| `GET` | `/api/auth/me` | Session cookie | Returns the current user. |

### Template endpoints

| Method | Endpoint | Input | Result |
| --- | --- | --- | --- |
| `POST` | `/api/templates` | Multipart `file` and optional `name`; max 10 MB; `.xlsx` or `.xls` | Parses the first worksheet and creates a template. |
| `GET` | `/api/templates` | None | Lists the current user's templates, newest first. |
| `GET` | `/api/templates/:id` | Template ID | Returns owned template metadata. |
| `DELETE` | `/api/templates/:id` | Template ID | Deletes the template and its records. |
| `GET` | `/api/templates/:id/export` | Template ID | Downloads a rebuilt `.xlsx` workbook. |

### Scan endpoints

| Method | Endpoint | Input | Result |
| --- | --- | --- | --- |
| `GET` | `/api/scans/usage` | None | Returns the current UTC month, shared count, limit, and remaining quota. |
| `POST` | `/api/scans/extract` | Multipart image field `image` and form field `templateId`; max 10 MB | Reserves quota, runs OCR, maps fields, and returns OCR text, lines, mapped data, and usage. |

### Record endpoints

| Method | Endpoint | Input | Result |
| --- | --- | --- | --- |
| `POST` | `/api/records` | JSON: `templateId`, `data` | Creates a reviewed record after checking template ownership. |
| `GET` | `/api/records?templateId=:id` | Template ID query parameter | Lists owned records oldest first. |
| `PUT` | `/api/records/:id` | JSON: `data` | Updates an owned record. |
| `DELETE` | `/api/records/:id` | Record ID | Deletes an owned record. |

Errors use JSON in the form `{ "error": "message" }`. An image upload that reaches Vision but fails there returns HTTP 502; an exhausted shared quota returns HTTP 429.

## Data model

The active application database is Firestore:

```text
users/{userId}
  name, email, passwordHash, createdAt

templates/{templateId}
  userId, name, originalFilename, sheetName, headers,
  existingRowsJson, createdAt

records/{recordId}
  templateId, userId, dataJson, createdAt, updatedAt

usage/{YYYY-MM}
  count, updatedAt
```

Ownership is checked in route handlers, not only in the UI:

- Template reads, scans, exports, and deletion require `template.userId === req.user.id`.
- Records are created with the authenticated user's ID.
- Record lists query both `templateId` and `userId`.
- Record updates and deletion require a matching `userId`.
- Template deletion explicitly deletes related records because Firestore has no relational cascade delete.

The `usage/{YYYY-MM}` document is shared by the deployment. A Firestore transaction reserves a count before each Vision call, so simultaneous users cannot reserve more than the configured monthly limit. A failed Vision call does not refund its reservation.

## Security and limits

- `JWT_SECRET` and the Vision API key are required at startup.
- Passwords use bcrypt with cost factor 10.
- JWT sessions expire after seven days and use httpOnly cookies.
- Production cookies use the `secure` flag.
- Helmet is enabled, with CSP disabled in the current server configuration.
- Login and registration share an IP-based limit of 20 attempts per 15 minutes.
- Image and workbook uploads are limited to 10 MB.
- JSON request bodies are limited to 2 MB.
- The shared monthly OCR cap defaults to 500 calls and is configured with `MONTHLY_OCR_LIMIT`.
- Uploaded files are held in memory and are not written to the local `uploads/` directory.
- `getUserMedia` requires a secure context; use HTTPS in deployed environments.

The app does not currently provide general rate limiting for OCR, uploads, record operations, or other APIs. It also has no explicit CSRF token mechanism, no token revocation list after logout, and limited server-side validation for registration fields. These are important considerations before exposing a production deployment to an untrusted or high-volume audience.

## Project structure

```text
student-ocr-app/
|-- server.js                 Express app, middleware, routes, static files
|-- api/index.js              Vercel entry point exporting the Express app
|-- vercel.json               Vercel build and catch-all routing configuration
|-- package.json              Runtime dependencies and npm scripts
|-- .env.example              Environment variable template
|-- lib/
|   |-- firebaseAdmin.js       Firestore Admin SDK initialization
|   `-- quota.js               Transactional shared OCR quota
|-- middleware/
|   `-- auth.js                JWT cookie authentication middleware
|-- routes/
|   |-- auth.js                Registration, login, logout, current user
|   |-- templates.js           Excel templates and export
|   |-- scans.js               OCR upload and usage endpoints
|   `-- records.js             Saved record CRUD
|-- utils/
|   |-- ocr.js                 Google Vision request and word extraction
|   |-- fieldMatcher.js        OCR line grouping and header mapping
|   |-- excel.js               Workbook parsing and rebuilding
|   |-- asyncHandler.js        Async wrapper, currently unused
|   `-- usageLimiter.js        Legacy SQLite-era limiter, currently unused
|-- db/
|   |-- db.js                  Legacy SQLite-era database helper, unused
|   `-- schema.sql              Legacy SQLite schema, unused by active routes
|-- public/
|   |-- login.html             Sign-in page
|   |-- register.html          Registration page
|   |-- dashboard.html         Template list and OCR usage
|   |-- scan.html              Camera/upload OCR and review page
|   |-- records.html           Record editing and export page
|   |-- css/style.css          Shared styling
|   `-- js/                    API, dashboard, scan, and records controllers
`-- uploads/.gitkeep           Placeholder directory; runtime uploads stay in memory
```

## Local setup

### Prerequisites

- Node.js 18 or newer.
- A Firebase project with Firestore enabled in Native mode.
- A Firebase service account with `project_id`, `client_email`, and `private_key`.
- A Google Cloud project with the Cloud Vision API enabled and an API key.

### Configure and run

From the project directory:

```bash
npm install
copy .env.example .env
npm start
```

On macOS or Linux, use `cp .env.example .env` instead of `copy`.

Set these values in `.env`:

| Variable | Required | Description |
| --- | --- | --- |
| `JWT_SECRET` | Yes | Long random value used to sign sessions. |
| `GOOGLE_VISION_API_KEY` | Yes | Server-side Google Cloud Vision API key. |
| `FIREBASE_PROJECT_ID` | Yes | Firebase project ID. |
| `FIREBASE_CLIENT_EMAIL` | Yes | Service account client email. |
| `FIREBASE_PRIVATE_KEY` | Yes | Service account private key; keep `\\n` escapes in dotenv values. |
| `MONTHLY_OCR_LIMIT` | No | Shared monthly Vision-call cap; defaults to `500`. |
| `PORT` | No | Local port; defaults to `3000`. |
| `NODE_ENV` | No | Set to `production` for secure production cookies. |

Generate a JWT secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Open `http://localhost:3000` after the server starts. The root route redirects to `dashboard.html`; unauthenticated visitors are redirected by the page guard to `login.html`.

For development with Node's file watcher:

```bash
npm run dev
```

## Vercel deployment

The included `vercel.json` builds `server.js` with `@vercel/node`, sends all requests to that Express app, and includes `public/**` in the deployment.

1. Import the repository into Vercel or run `vercel` from the project directory.
2. Add `JWT_SECRET`, `GOOGLE_VISION_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, and `FIREBASE_PRIVATE_KEY` as Vercel environment variables.
3. Optionally configure `MONTHLY_OCR_LIMIT`; set `NODE_ENV=production`.
4. Redeploy after changing environment variables.

Paste `FIREBASE_PRIVATE_KEY` with its `\\n` escapes intact. Firestore is used instead of a local database because serverless instances do not provide durable local storage. Vercel's HTTPS deployment also satisfies the secure-context requirement for camera capture.

## Known limitations and legacy files

- Only the first worksheet is imported.
- Exports rebuild a workbook and do not preserve original formatting, formulas, widths, additional worksheets, or workbook metadata.
- OCR mapping depends on recognizable header labels and the expected label/value layout.
- OCR quota reservations are not refunded when Vision fails.
- The current monthly limit parser should be given a valid positive number.
- `db/db.js`, `db/schema.sql`, and `utils/usageLimiter.js` describe an older SQLite design and are not imported by the active Firestore routes. SQLite is not listed as an installed dependency.
- `utils/asyncHandler.js` is present but the active route handlers use explicit `try/catch` blocks instead.
- The `uploads/` directory is retained only as a placeholder; runtime upload data is never stored there.

The authoritative behavior is defined by `server.js`, the route modules, and the utility implementations. Keep this README synchronized when endpoint names, environment variables, or persistence behavior change.
