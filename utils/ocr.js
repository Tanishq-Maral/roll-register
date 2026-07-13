// Calls the Google Cloud Vision API from the server, so the API key never
// has to be sent to or stored in the browser.
//
// Uses DOCUMENT_TEXT_DETECTION and reads the structured `fullTextAnnotation`
// response so we get each individual word's bounding box, not just a flat
// text blob. The bounding boxes are what let fieldMatcher.js reconstruct
// accurate lines (grouped by y-coordinate) instead of guessing.

async function extractTextFromImage(base64Image, apiKey) {
  if (!apiKey) {
    const err = new Error('No Google Vision API key is configured for this account.');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const url = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;
  const body = {
    requests: [
      {
        image: { content: base64Image },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      },
    ],
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await resp.json();

  if (!resp.ok) {
    throw new Error((data.error && data.error.message) || 'Google Vision API request failed.');
  }
  const result = data.responses && data.responses[0];
  if (result && result.error) {
    throw new Error(result.error.message || 'Google Vision API returned an error.');
  }

  return {
    rawText: (result && result.fullTextAnnotation && result.fullTextAnnotation.text) || '',
    words: extractWords(result),
  };
}

// Walk the page -> block -> paragraph -> word -> symbol tree Vision returns
// for DOCUMENT_TEXT_DETECTION and flatten it into a simple list of words,
// each with the text it reads and its bounding box in image pixel coords.
function extractWords(result) {
  const words = [];
  const pages = (result && result.fullTextAnnotation && result.fullTextAnnotation.pages) || [];

  for (const page of pages) {
    for (const block of page.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const word of paragraph.words || []) {
          const text = (word.symbols || []).map((s) => s.text).join('');
          if (!text) continue;

          const vertices = (word.boundingBox && word.boundingBox.vertices) || [];
          if (!vertices.length) continue;

          const xs = vertices.map((v) => v.x || 0);
          const ys = vertices.map((v) => v.y || 0);

          words.push({
            text,
            x0: Math.min(...xs),
            x1: Math.max(...xs),
            y0: Math.min(...ys),
            y1: Math.max(...ys),
          });
        }
      }
    }
  }

  return words;
}

module.exports = { extractTextFromImage };
