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
// them in reading order, and try every Excel header in serialized order.
// Each field takes everything between the end of its label and the start of
// the next successfully matched label. If a label has no value, the next
// header is still searched from the same reading-order cursor, so blank or
// missing fields never prevent later fields from being extracted.
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

// Strips punctuation/whitespace while keeping letters, combining marks, and
// digits in ANY script/language. Combining marks are essential for scripts
// such as Devanagari: Marathi vowel signs are Unicode marks attached to the
// preceding letter and must not be removed before matching.
function normalizeToken(str) {
  return String(str || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\u200c\u200d\ufeff]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}]/gu, '')
    .replace(/इयत्ता/g, 'इयता');
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
// inside `tokens`. Punctuation-only OCR tokens are ignored for matching,
// because Vision may return `Date / Time` as `Date`, `/`, `Time` while the
// header normalizes to the two meaningful tokens `Date`, `Time`. The returned
// indexes still refer to the original token array so values and displayed
// lines retain their original text.
function findLabelMatch(tokens, headerTokens, fromIdx) {
  if (!headerTokens.length) return null;
  const searchableTokens = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => token.norm);

  for (let i = 0; i <= searchableTokens.length - headerTokens.length; i++) {
    if (searchableTokens[i].index < fromIdx) continue;
    let ok = true;
    for (let j = 0; j < headerTokens.length; j++) {
      if (!tokensMatch(headerTokens[j], searchableTokens[i + j].token.norm)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const start = searchableTokens[i].index;
      let end = searchableTokens[i + headerTokens.length - 1].index + 1;
      while (end < tokens.length && !tokens[end].norm) end++;
      return { start, end };
    }
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

  // Step 1: locate every header label in the Excel/serialized order.
  // A missing label does not move searchFrom. This is important: the next
  // header must still be searched after the last label that was actually
  // found, rather than after an assumed value for the missing field.
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

    const nextMatch = matches.slice(i + 1).find((candidate) => candidate.start !== -1);
    const nextStart = nextMatch ? nextMatch.start : tokens.length;

    const valueTokens = tokens.slice(m.end, Math.max(m.end, nextStart));
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
