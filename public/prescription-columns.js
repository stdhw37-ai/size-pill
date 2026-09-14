// Column boundary detection for the 3 numeric fields (dose/frequency/duration) - a SEPARATE module so
// the existing name/row OCR pipeline (prescription-parser.js) is never touched by this work; only new,
// additive code lives here and in prescription-ocr.js. Two signals, combined:
//   1. header OCR x-positions - reused from prescription-parser.js's own header pass, not reimplemented
//   2. vertical rule-line detection run directly on the actual preprocessed image pixels
// Never a hardcoded pixel position - everything here is relative to detected lines/header, or (last
// resort, handled by the caller) the row's own name text.
const fields = ['dosePerAdministration', 'frequencyPerDay', 'durationDays'];
const DARK = 150; // 0-255 threshold on the already grayscale+contrast-stretched image (prescription-image.js)
const MIN_COVERAGE = .55; // fraction of the scanned band height that must stay dark to count as a ruled line

// Scans a horizontal band [y0,y1) of the canvas and returns x positions where a continuous vertical
// dark run (a printed column rule) was found, merging adjacent dark pixel-columns into one line.
// Equivalent in effect to a morphological-vertical-kernel pass, without needing a CV library.
export function detectVerticalLines(canvas, y0, y1) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const top = Math.max(0, Math.floor(y0)), bottom = Math.min(canvas.height, Math.ceil(y1));
  const height = bottom - top;
  if (height <= 0) return [];
  const { data, width } = ctx.getImageData(0, top, canvas.width, height);
  const darkCounts = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x++) if (data[rowOffset + x * 4] < DARK) darkCounts[x]++;
  }
  const minRun = height * MIN_COVERAGE, lines = [];
  for (let x = 0; x < width; x++) {
    if (darkCounts[x] >= minRun) {
      let end = x;
      while (end + 1 < width && darkCounts[end + 1] >= minRun) end++;
      lines.push((x + end) / 2); x = end;
    }
  }
  return lines;
}

function nearestLine(lines, x, dir, maxDistance) {
  let best = null, bestDist = Infinity;
  for (const line of lines) {
    if (dir < 0 && line > x) continue;
    if (dir > 0 && line < x) continue;
    const d = Math.abs(line - x);
    if (d < bestDist) { bestDist = d; best = line; }
  }
  return best != null && bestDist <= maxDistance ? best : null;
}

// header: { columns: [{field, x}] } from prescription-parser.js's findHeaderColumns(), or null/missing.
// lines: raw output of detectVerticalLines (any x range - filtered here by nameRightEdge).
// nameRightEdge: rightmost x of any row's own name text (real pixels, always available for a row that
// has a name at all) - the numeric region can never start to the left of this.
// Returns { [field]: {x0, x1, source} } - only for fields it could actually determine; a field this
// can't place at all is simply absent, and the caller (prescription-ocr.js) falls back further.
export function computeColumnBoundaries({ header, lines, nameRightEdge, imageWidth }) {
  const sortedLines = [...new Set(lines)].sort((a, b) => a - b).filter(x => x > nameRightEdge);
  const boundaries = {};
  const numericHeaders = (header?.columns || []).filter(c => fields.includes(c.field)).sort((a, b) => a.x - b.x);
  if (numericHeaders.length) {
    // Average distance BETWEEN adjacent numeric headers (gaps = headers - 1), not per-header - a rule
    // line sits roughly half a column away from its header's text center, so a search radius needs to
    // reach about half of this, comfortably covered by the .7 factor below.
    const span = numericHeaders.length > 1 ? numericHeaders.at(-1).x - numericHeaders[0].x : imageWidth - numericHeaders[0].x;
    const maxGap = Math.max(1, span / Math.max(1, numericHeaders.length - 1));
    numericHeaders.forEach(({ field, x }, i) => {
      const prevX = i === 0 ? (header.columns.find(c => c.field === 'name')?.x ?? nameRightEdge) : numericHeaders[i - 1].x;
      const nextX = i === numericHeaders.length - 1 ? Infinity : numericHeaders[i + 1].x;
      const left = nearestLine(sortedLines, x, -1, maxGap * .7) ?? Math.max(nameRightEdge, (prevX + x) / 2);
      const right = nearestLine(sortedLines, x, 1, maxGap * .7) ?? (nextX === Infinity ? imageWidth : (x + nextX) / 2);
      boundaries[field] = { x0: left, x1: right, source: 'header+line' };
    });
  }
  const missing = fields.filter(f => !boundaries[f]);
  if (missing.length && sortedLines.length >= 2) {
    // No usable header for these fields - fall back to line position order alone: the numeric columns
    // are always printed dose -> frequency -> duration (that IS the header's own left-to-right order),
    // so the rightmost N+1 detected lines are assumed to bound them in that order.
    const need = missing.length + 1;
    if (sortedLines.length >= need) {
      const chosen = sortedLines.slice(-need);
      missing.forEach((field, i) => { boundaries[field] = { x0: chosen[i], x1: chosen[i + 1] ?? imageWidth, source: 'line-order' }; });
    }
  }
  return boundaries;
}
