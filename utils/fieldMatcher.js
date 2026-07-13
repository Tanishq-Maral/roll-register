// Maps OCR'd words onto the header row of a user's Excel sheet.
//
// Assumptions, guaranteed by the caller (see routes/scans.js):
//   1. Every header in `headers` appears verbatim, as a label, somewhere in
//      the image (there may be other, unrelated text before the first
//      label - e.g. a title or letterhead - which is simply ignored).
//   2. The labels appear in the image in the same left-to-right,
//      top-to-bottom order as the headers appear in the Excel sheet.
//
// Given that, there is no need to guess which word means what: we rebuild
// the lines of the document from each word's bounding box, walk through
// them in reading order, and for each header (in order) take everything
// between the end of its label and the start of the next header's label as
// its value. If a header's label is immediately followed by the next
// header's label (i.e. no value in between), the value is left blank.
//
// OCR is imperfect, though, so two failure modes are handled explicitly:
//   - A label may be misspelled by the OCR engine (a dropped/added/swapped
//     letter). Label matching tolerates small character-level edit distance
//     for this reason - this is noise tolerance, not synonym/concept
//     guessing: it still has to be (almost) the same word.
//   - A label may fail to be extracted at all. In that case that header's
//     value is left blank, and - importantly - every other, correctly
//     extracted header is still matched and filled in properly; a missing
//     label in the middle does not break the rest of the sequence.

// Strips punctuation/whitespace while keeping the token's actual letters
// and digits, in ANY script/language - not just a-z0-9. This must be
// Unicode-aware: a plain a-z0-9 filter would silently reduce every
// Devanagari, Arabic, CJK, etc. token to an empty string, since none of
// those characters fall in that ASCII range, which breaks matching
// entirely for non-Latin-script labels.
function normalizeToken(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function tokenizeHeader(header) {
  return String(header || '')
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
}

// Damerau-Levenshtein edit distance (optimal string alignment variant)
// between two normalized tokens: insertions, deletions, substitutions, and
// adjacent transpositions each cost 1. Transpositions are included because
// swapped-adjacent-letters (e.g. "Nmae" for "Name") are one of the most
// common OCR misreads, and without it such a swap would otherwise wrongly
// cost 2 edits under plain Levenshtein and fall outside tolerance.
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        best = Math.min(best, dp[i - 2][j - 2] + 1); // adjacent transposition
      }
      dp[i][j] = best;
    }
  }
  return dp[m][n];
}

// Is `extractedToken` close enough to `headerToken` to count as the same
// word? This is NOT synonym/concept guessing - it only tolerates the kind
// of small character-level noise OCR introduces (a dropped/added/swapped
// letter) on what is still meant to be the exact same word. Short tokens
// require an exact match, since a 1-character edit on a short word (e.g.
// "no" vs "on") is far more likely to be a different word than a typo.
function tokensMatch(headerToken, extractedToken) {
  if (!headerToken || !extractedToken) return false;
  if (headerToken === extractedToken) return true;

  const maxLen = Math.max(headerToken.length, extractedToken.length);
  if (maxLen <= 3) return false;

  const allowedDistance = maxLen <= 6 ? 1 : 2;
  return editDistance(headerToken, extractedToken) <= allowedDistance;
}

// Group words into lines purely from their vertical position (bounding box
// y-coordinates), then order the words within each line left-to-right.
//
// @param {{text:string, x0:number, y0:number, x1:number, y1:number}[]} words
// @returns {Array<Array<{text:string, x0:number, y0:number, x1:number, y1:number}>>}
function buildLines(words) {
  if (!words.length) return [];

  const withCenters = words.map((w) => ({
    ...w,
    yCenter: (w.y0 + w.y1) / 2,
    height: Math.max(w.y1 - w.y0, 1),
  }));

  const avgHeight =
    withCenters.reduce((sum, w) => sum + w.height, 0) / withCenters.length;
  // Two words belong to the same line if their vertical centers are within
  // this many pixels of each other. Scaled to the text size in this image
  // so it works for both small and large fonts/resolutions.
  const threshold = avgHeight * 0.6;

  const sorted = [...withCenters].sort((a, b) => a.yCenter - b.yCenter);

  const lines = [];
  let current = null;
  for (const word of sorted) {
    if (current && Math.abs(word.yCenter - current.avgYCenter) <= threshold) {
      current.words.push(word);
      current.avgYCenter =
        current.words.reduce((sum, w) => sum + w.yCenter, 0) / current.words.length;
    } else {
      current = { words: [word], avgYCenter: word.yCenter };
      lines.push(current);
    }
  }

  lines.sort((a, b) => a.avgYCenter - b.avgYCenter);
  lines.forEach((line) => line.words.sort((a, b) => a.x0 - b.x0));

  return lines.map((line) => line.words);
}

// Flatten the grouped lines into one reading-order sequence of tokens,
// remembering which line each token came from and its normalized form
// (used for matching headers regardless of punctuation/case).
function flattenTokens(lines) {
  const tokens = [];
  lines.forEach((line, lineIdx) => {
    line.forEach((word) => {
      tokens.push({ text: word.text, norm: normalizeToken(word.text), lineIdx });
    });
  });
  return tokens;
}

// Find the first place, at or after `fromIdx`, where `headerTokens` occurs
// as a contiguous run inside `tokens`. Returns { start, end } (end exclusive)
// or null if no such run exists.
function findLabelMatch(tokens, headerTokens, fromIdx) {
  if (!headerTokens.length) return null;
  for (let i = fromIdx; i <= tokens.length - headerTokens.length; i++) {
    let ok = true;
    for (let j = 0; j < headerTokens.length; j++) {
      if (!tokensMatch(headerTokens[j], tokens[i + j].norm)) {
        ok = false;
        break;
      }
    }
    if (ok) return { start: i, end: i + headerTokens.length };
  }
  return null;
}

/**
 * @param {{text:string, x0:number, y0:number, x1:number, y1:number}[]} words
 *   Words returned by ocr.js, each with a pixel bounding box.
 * @param {string[]} headers - the Excel sheet's header row, in the same
 *   order their matching labels appear in the image.
 * @returns {{ mapped: Record<string,string>, lines: string[] }}
 */
function mapWordsToHeaders(words, headers) {
  const lines = buildLines(words);
  const tokens = flattenTokens(lines);

  // Step 1: locate each header's label in the token stream, in order.
  // Searching always resumes from where the previous *found* label ended,
  // which is what enforces "headers and labels appear in the same order".
  const matches = [];
  let searchFrom = 0;
  for (const header of headers) {
    const headerTokens = tokenizeHeader(header);
    const match = findLabelMatch(tokens, headerTokens, searchFrom);
    if (match) {
      matches.push({ header, start: match.start, end: match.end });
      searchFrom = match.end;
    } else {
      // Label not found at all (shouldn't happen given the guarantee, but
      // fail safe rather than fuzzy-guess): leave it unmatched.
      matches.push({ header, start: -1, end: -1 });
    }
  }

  // Step 2: for each matched header, the value is every token between the
  // end of its own label and the start of the *next found* header's label.
  // If those two points are adjacent (or the same), the value is blank.
  const mapped = {};
  matches.forEach((m, i) => {
    if (m.start === -1) {
      mapped[m.header] = '';
      return;
    }

    let nextStart = tokens.length;
    for (let j = i + 1; j < matches.length; j++) {
      if (matches[j].start !== -1) {
        nextStart = matches[j].start;
        break;
      }
    }

    const valueTokens = tokens.slice(m.end, Math.max(nextStart, m.end));
    mapped[m.header] = valueTokens
      .map((t) => t.text)
      .join(' ')
      .replace(/^[:\-–,.\s]+/, '')
      .trim();
  });

  const lineStrings = lines.map((line) => line.map((w) => w.text).join(' '));
  return { mapped, lines: lineStrings };
}

module.exports = { mapWordsToHeaders, buildLines };
