import { ocrWords, parsePrescriptionWords, parsePrescriptionText, findHeaderColumns } from './prescription-parser.js';
import { detectVerticalLines, computeColumnBoundaries } from './prescription-columns.js';
const fields = ['dosePerAdministration', 'frequencyPerDay', 'durationDays'];
const parse = data => {
  const words = ocrWords(data);
  const rows = words.length ? parsePrescriptionWords(words) : parsePrescriptionText(data.text);
  return { rows, words };
};
// A character outside what a real drug name ever contains (Hangul, Latin, digits, ().,%/- and space)
// only shows up when OCR badly mangled that row - weighted heavily, this is what stops the sparse/
// adaptive retry pass from winning just because it happened to also catch a stray digit, while
// actually reading the name far worse than the first pass did (verified against real Tesseract
// output: PSM 11 frequently scrambles contiguous Hangul far more than PSM 3 does - see the PR notes).
const weirdChars = s => (String(s || '').match(/[^가-힣a-zA-Z0-9().,%/\-~ ]/g) || []).length;
// Numeric-field presence deliberately does NOT count here any more: PASS 2 below independently
// re-reads every row's numbers regardless of which full-page candidate wins this comparison, so
// rewarding a candidate for having accidentally caught a stray digit only rewarded picking a WORSE
// name-reading pass for no real benefit. Only how cleanly the drug names/codes came out decides this -
// this file's name-recognition behavior (PASS 1 + this comparison) is otherwise UNCHANGED this round.
const quality = rows => rows.reduce((score, r) => score + (r.code ? 2 : 0) + (r.confidence || 0) / 100 - weirdChars(r.drugName) * 2, 0);

// Crops one region out of the SAME full-resolution canvas the page passes above already read - bounds
// are always real pixel positions (never a fixed offset), clamped against the actual image dimensions
// here at crop time. Short digit strings recognize far more reliably enlarged, so the crop is upscaled.
function cropRaw(source, bounds) {
  const doc = source.ownerDocument;
  const x0 = Math.max(0, Math.floor(bounds.x0)), y0 = Math.max(0, Math.floor(bounds.y0));
  const x1 = Math.min(source.width, Math.ceil(bounds.x1)), y1 = Math.min(source.height, Math.ceil(bounds.y1));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const scale = Math.min(4, Math.max(1, 90 / h));
  const cell = doc.createElement('canvas');
  cell.width = Math.round(w * scale); cell.height = Math.round(h * scale);
  cell.getContext('2d').drawImage(source, x0, y0, w, h, 0, 0, cell.width, cell.height);
  return cell;
}
// Table rule lines running along a cell's own edge can be read as stray digits - shrinking the crop
// inward by a fraction of its own size (never a fixed px offset) keeps just the digit-centered area.
function padCell(bounds, ratio = .1) {
  const w = bounds.x1 - bounds.x0, h = bounds.y1 - bounds.y0, px = w * ratio, py = h * ratio;
  return { x0: bounds.x0 + px, x1: bounds.x1 - px, y0: bounds.y0 + py, y1: bounds.y1 - py };
}
function otsuThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxVar = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; threshold = t; }
  }
  return threshold;
}
function grayscaleOf(cell) {
  const ctx = cell.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, cell.width, cell.height);
  const gray = new Uint8ClampedArray(cell.width * cell.height);
  for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4]; // already R=G=B (prescription-image.js)
  return gray;
}
function paintGray(doc, width, height, mapper) {
  const canvas = doc.createElement('canvas'); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const out = ctx.createImageData(width, height);
  for (let i = 0; i < width * height; i++) { const v = mapper(i); out.data[i * 4] = v; out.data[i * 4 + 1] = v; out.data[i * 4 + 2] = v; out.data[i * 4 + 3] = 255; }
  ctx.putImageData(out, 0, 0);
  return canvas;
}
// 2-3 candidate preprocessing variants per cell (item 7): the already-preprocessed crop as-is, an
// Otsu binarization, and a percentile-clipped LOCAL contrast stretch (this cell's own 2nd-98th
// percentile, not the whole page's) - a small cell can have a much narrower dynamic range than the
// page-wide stretch prescription-image.js already applied, so a locally-computed stretch is a
// genuinely different, useful variant rather than the same thing twice. Never a full per-pixel
// adaptive-threshold (Bradley/Sauvola) implementation - a cell this small doesn't need one, and the
// two variants above already cover distinctly different failure modes.
function buildVariants(cell) {
  const gray = grayscaleOf(cell), doc = cell.ownerDocument;
  const variants = [{ label: 'passthrough', canvas: cell }];
  const t = otsuThreshold(gray);
  variants.push({ label: 'otsu', canvas: paintGray(doc, cell.width, cell.height, i => gray[i] < t ? 0 : 255) });
  const sorted = [...gray].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * .02)] ?? 0, hi = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .98))] ?? 255;
  const range = Math.max(1, hi - lo);
  variants.push({ label: 'contrast', canvas: paintGray(doc, cell.width, cell.height, i => Math.max(0, Math.min(255, Math.round((gray[i] - lo) * 255 / range)))) });
  return variants;
}
function parseCellDigits(text) {
  const m = String(text || '').replace(/\s+/g, '').match(/^\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function parseZoneTokens(text) {
  return String(text || '').split(/\s+/).map(t => t.trim()).filter(Boolean)
    .map(t => { const m = t.match(/^\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; }).filter(n => n != null && n > 0);
}
// Runs each preprocessing variant through digit-only OCR and keeps whichever came back with the
// highest confidence (item 7/8) - stops early once a variant is already confident, since most cells
// on a clean scan don't need all three. `withDebug` includes each attempt (+ a thumbnail) in the
// return value only when asked (item 11) - the normal path never pays for toDataURL().
async function ocrCell(worker, cell, run, withDebug) {
  const attempts = [];
  let best = { value: null, confidence: 0, label: null };
  for (const variant of buildVariants(cell)) {
    const result = await run(worker.recognize(variant.canvas, {}, { text: true }));
    const value = parseCellDigits(result.data.text), confidence = result.data.confidence ?? 0;
    if (withDebug) attempts.push({ label: variant.label, text: result.data.text, value, confidence, dataUrl: variant.canvas.toDataURL?.() });
    if (value != null && confidence > best.confidence) best = { value, confidence, label: variant.label };
    if (best.confidence >= 90) break;
  }
  return { ...best, attempts };
}

// Preserve table rules on the first pass: they can help layout analysis. If that
// segmentation misses fields, try sparse text + adaptive thresholding on the SAME
// image. Never erase lines (which can erase '-' or Hangul) or mix cells across passes.
// (Name/row recognition below - PASS 1 and the quality comparison - is unchanged this round; only
// PASS 2 was rewritten. See item 1 of the request.)
export async function recognizePrescription(worker, canvas, signal, run = p => p, debug = null) {
  const check = () => { if (signal.aborted) throw new DOMException('OCR cancelled', 'AbortError'); };
  check();
  await run(worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1', thresholding_method: '0' }));
  const first = await run(worker.recognize(canvas, { rotateAuto: true }, { text: true, blocks: true }));
  check(); let { rows, words } = parse(first.data);
  if (!rows.length || rows.some(row => row.needsReview)) {
    await run(worker.setParameters({ tessedit_pageseg_mode: '11', thresholding_method: '2' }));
    const second = await run(worker.recognize(canvas, { rotateAuto: true }, { text: true, blocks: true }));
    check(); const alternative = parse(second.data);
    if (quality(alternative.rows) > quality(rows)) { rows = alternative.rows; words = alternative.words; }
  }
  // PASS 2 (item 2-7): full-page layout analysis routinely drops the numeric columns from its own
  // output entirely (verified against real Tesseract output - see the PR notes), so this never trusts
  // the page passes above for a row with any missing/low-confidence number. Column boundaries come
  // from header OCR x-positions + vertical rule-line detection on the actual pixels (never a fixed
  // offset - see prescription-columns.js); row y-position is anchored to the drug-name row already
  // found above (item 5), never re-guessed. A row whose numbers already came back complete and
  // confident triggers no extra recognize() call at all.
  const pending = rows.filter(row => fields.some(f => row[f] == null || (row.fieldConfidence?.[f] ?? 0) < 70));
  if (pending.length) {
    const header = findHeaderColumns(words);
    const rowHeight = rows[0]?.rowHeight || 20;
    const y0 = Math.min(...rows.map(r => r.y)) - rowHeight * 3, y1 = Math.max(...rows.map(r => r.y)) + rowHeight * 2;
    const lines = detectVerticalLines(canvas, y0, y1);
    const nameRightEdge = Math.max(...rows.map(r => r.nameRightEdge ?? -Infinity).filter(Number.isFinite));
    const columns = computeColumnBoundaries({ header, lines, nameRightEdge, imageWidth: canvas.width });
    if (debug) debug.columns = { header, lines, columns };
    await run(worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789.' }));
    for (const row of pending) {
      check();
      const stillMissing = [];
      for (const field of fields) {
        if (row[field] != null && (row.fieldConfidence?.[field] ?? 0) >= 70) continue;
        const columnBounds = columns[field];
        if (!columnBounds) { stillMissing.push(field); continue; }
        const cellBounds = padCell({ x0: columnBounds.x0, x1: Number.isFinite(columnBounds.x1) ? columnBounds.x1 : canvas.width, y0: row.y - rowHeight * .9, y1: row.y + rowHeight * .9 });
        const cell = cropRaw(canvas, cellBounds);
        const result = await ocrCell(worker, cell, run, !!debug);
        if (debug) (debug.cells ??= []).push({ drugName: row.drugName, field, bounds: cellBounds, source: columnBounds.source, attempts: result.attempts, chosen: { value: result.value, confidence: result.confidence, label: result.label } });
        if (result.value != null) { row[field] = result.value; row.fieldConfidence[field] = Math.max(row.fieldConfidence[field] || 0, result.confidence); }
        else stillMissing.push(field);
      }
      // Column-specific detection couldn't place or read one of the fields - one last, coarser
      // attempt: the row's own whole numeric strip (name-end to image edge), read as one line and
      // split by position. This is the SAME approach validated end-to-end in the previous round; kept
      // here as the deepest fallback rather than discarded, so nothing regresses when lines/header
      // both fail (item 2-4's precise crop is strictly additive on top of it, not a replacement).
      if (stillMissing.length && row.numericZone) {
        const cell = cropRaw(canvas, row.numericZone);
        const cropped = await run(worker.recognize(cell, {}, { text: true }));
        const tokens = parseZoneTokens(cropped.data.text);
        if (debug) (debug.cells ??= []).push({ drugName: row.drugName, field: 'whole-strip-fallback', bounds: row.numericZone, text: cropped.data.text, tokens });
        fields.forEach((field, i) => {
          if (!stillMissing.includes(field) || tokens[i] == null) return;
          row[field] = tokens[i]; row.fieldConfidence[field] = Math.max(row.fieldConfidence[field] || 0, cropped.data.confidence ?? 0);
        });
      }
      row.confidence = Math.min(...Object.values(row.fieldConfidence));
      row.needsReview = row.structuralReview || Object.values(row.fieldConfidence).some(v => v < 70);
    }
    await run(worker.setParameters({ tessedit_pageseg_mode: '3', tessedit_char_whitelist: '' }));
  }
  return rows;
}
