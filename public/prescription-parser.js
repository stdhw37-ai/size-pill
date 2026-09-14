// Pure geometry/text parser. No patient data, image persistence, network or DOM.
const fields = ['dosePerAdministration', 'frequencyPerDay', 'durationDays'];
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] || 1;
const compact = s => String(s || '').normalize('NFKC').replace(/\s+/g, '');
const center = w => (w.x0 + w.x1) / 2;
const ycenter = w => (w.y0 + w.y1) / 2;
const conf = ws => ws.length ? Math.min(...ws.map(w => Number.isFinite(w.confidence) ? w.confidence : 0)) : 0;
const codePattern = /^([0-9OIl]{8,9})(?![0-9OIl])/;
const numeric = s => {
  const t = compact(s).replace(/[Oo]/g, '0').replace(/[Il]/g, '1');
  const m = t.match(/^(\d+(?:\.\d+)?|\d+\/\d+)(?:정|캡슐|포|mL|회|일)?$/i);
  if (!m) return null;
  const [a, b] = m[1].split('/').map(Number), n = b === undefined ? a : a / b;
  return Number.isFinite(n) && n > 0 ? n : null;
};

// What a real trailing unit/strength segment can legitimately contain - a small, enumerable
// vocabulary (mg/mcg/g/IU/%/정/캡슐/포/병/mL...). Anything else in that position (verified against
// real Tesseract output on a rendered prescription table, not guessed) comes out as arbitrary,
// unpredictable noise - stray brackets, Latin letters, jamo fragments, punctuation - so trying to
// enumerate "junk characters" to blacklist does not hold up. Whitelisting what a CLEAN tail looks
// like, and treating everything else as broken, is what actually generalizes - see item 6.
const CLEAN_UNIT_TAIL = /^\d+(?:\.\d+)?(?:mg|mcg|g|iu|%|밀리그램|마이크로그램)$/i;
// A count-dispensing unit word (정/캡슐/포/병) is a small, closed, enumerable vocabulary - unlike a
// volume number, which OCR can corrupt at any digit with no way to recover the true value from
// context, a 1-character-different misread of one of these four words (e.g. "캡슐" -> "캡슬") has
// exactly one plausible reading. Recovering that (never the digit in front of it, which is left
// exactly as read) is safe in a way guessing a broken "15mL" is not - see item 6.
const KNOWN_UNIT_WORDS = ['정', '캡슐', '포', '병'];
function closeMatch(a, b) {
  if (a === b) return true;
  // A single-character target (정/포/병) has no room for a "1 character wrong out of several" match -
  // any other lone character is trivially "1 edit away", which made the equal-length branch below
  // accept ANY single garbled character as a match for real fragments (only ever exercised for a
  // 2+ character target like "캡슬"->"캡슐" until now, which is why this went unnoticed).
  if (b.length === 1) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) { let diff = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false; return true; }
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0, j = 0, diff = 0;
  while (i < s.length && j < l.length) { if (s[i] === l[j]) { i++; j++; } else { j++; if (++diff > 1) return false; } }
  return true;
}
function fuzzyUnit(fragment) {
  const m = fragment.match(/^(\d+(?:\.\d+)?)(.+)$/);
  if (!m) return null;
  const word = KNOWN_UNIT_WORDS.find(w => closeMatch(m[2], w));
  return word ? m[1] + word : null;
}
// Same closed-vocabulary reasoning as fuzzyUnit above, applied to the drug name's OWN trailing
// dosage-form word instead of the separated unit field - a real Korean product name overwhelmingly
// ends in exactly one of these words (e.g. "에도스캡슐"), and OCR corrupts it the identical way
// ("캡슐" -> "캡슬") independently of whether a unit suffix was also readable. closeMatch's
// single-character guard means only "캡슐" (2+ chars) is ever corrected here - 정/포/병 alone are
// never touched, since a lone trailing character is not enough signal to correct with confidence.
function fuzzyNameTail(name) {
  // A route-of-administration note in parens ("(내복)" etc.) commonly follows the dosage-form word in
  // a real registered product name (e.g. "셀벡스캡슐(내복)") - stripped here only to find the fuzzy
  // match, then reattached verbatim (it is real, read-correctly text, not part of what's being fixed).
  const parenSuffix = name.match(/\([^()]*\)$/)?.[0] || '';
  const base = parenSuffix ? name.slice(0, -parenSuffix.length) : name;
  for (const word of KNOWN_UNIT_WORDS) {
    if (word.length < 2 || base.endsWith(word)) continue;
    const tail = base.slice(-word.length);
    if (tail.length === word.length && closeMatch(tail, word)) return base.slice(0, -word.length) + word + parenSuffix;
  }
  return name;
}
export function parseDrugName(text) {
  const source = compact(text), match = source.match(codePattern);
  const code = match ? match[1].replace(/O/g, '0').replace(/[Il]/g, '1') : null;
  const rawName = match ? source.slice(match[0].length) : source;
  // Only a terminal dispensing unit is separated. Combination strengths (40/10mg),
  // hyphens, parentheses and all other name characters remain intact.
  const unit = rawName.match(/\/(\d+(?:\.\d+)?(?:mL|ml|밀리리터)(?:\/(?:포|병))?|\d+(?:\.\d+)?(?:캡슐|정|포|병))$/);
  if (unit) return { code, rawName, drugName: fuzzyNameTail(rawName.slice(0, unit.index)), prescribedUnit: unit[1] };
  // No clean unit matched. "<digits><anything>/포" or "<digits><anything>/병" only ever occurs as a
  // broken quantity in front of an otherwise-clean packaging word (포/병 alone is never part of a real
  // drug name) - split it off unconditionally, verbatim, never reinterpreted as a guessed value, so
  // drugName/search stay clean and the raw fragment is kept for review.
  const twoPart = rawName.match(/\/(\d+(?:\.\d+)?[^/]{1,6})\/(포|병)$/);
  // The volume/count number in front is unreadable and never guessed - but the "/포" or "/병" itself
  // is an exact regex match, not a guess, so it's kept as a partial unit ("포"/"병" alone, no volume)
  // rather than discarded to null: enough for "1포 × 하루 3회 × 10일" to display correctly even when
  // the mL number could not be recovered, still flagged for review via unitOcrFailed.
  if (twoPart) return { code, rawName, drugName: fuzzyNameTail(rawName.slice(0, twoPart.index)), prescribedUnit: twoPart[2], unitOcrFailed: true, rawUnitFragment: `${twoPart[1]}/${twoPart[2]}` };
  // A single trailing "/<digits><up to 6 chars>" with no separate 포/병 after it: only split it off
  // when that tail is NOT a clean combination-strength suffix (e.g. "/10mg" stays fused - unchanged
  // from before). Anything else in that position is presumed to be an unreadable dispensing unit.
  const garbled = rawName.match(/\/(\d+(?:\.\d+)?[^/]{1,6})$/);
  if (garbled && !CLEAN_UNIT_TAIL.test(garbled[1])) {
    const fixed = fuzzyUnit(garbled[1]);
    if (fixed) return { code, rawName, drugName: fuzzyNameTail(rawName.slice(0, garbled.index)), prescribedUnit: fixed };
    return { code, rawName, drugName: fuzzyNameTail(rawName.slice(0, garbled.index)), prescribedUnit: null, unitOcrFailed: true, rawUnitFragment: garbled[1] };
  }
  return { code, rawName, drugName: fuzzyNameTail(rawName), prescribedUnit: null };
}

export function ocrWords(data) {
  const words = [];
  for (const [bi, block] of (data.blocks || []).entries())
    for (const [pi, paragraph] of (block.paragraphs || []).entries())
      for (const [li, line] of (paragraph.lines || []).entries())
        for (const word of line.words || []) words.push({ text: word.text, confidence: word.confidence,
          ...word.bbox, blockId: bi, lineId: `${bi}:${pi}:${li}` });
  return words.length ? words : (data.words || []).map(w => ({ ...w, ...w.bbox }));
}

export function groupPrescriptionLines(words) {
  const rows = [], h = median(words.map(w => w.y1 - w.y0));
  for (const word of [...words].sort((a, b) => ycenter(a) - ycenter(b))) {
    let row = rows.find(r => Math.abs(r.y - ycenter(word)) <= h * .55);
    if (!row) { row = { y: ycenter(word), words: [] }; rows.push(row); }
    row.words.push(word); row.y = median(row.words.map(ycenter));
  }
  return rows.sort((a, b) => a.y - b.y).map(r => ({ ...r, words: r.words.sort((a, b) => a.x0 - b.x0) }));
}
function headerField(text) {
  const s = compact(text);
  if (/^(처방)?(의)?약품(의)?(명칭|명)$|^제품명$|^명칭$/.test(s)) return 'name';
  if (/^(1회)?(투여량|투약량|복용량|용량)$|^1회량$/.test(s)) return fields[0];
  if (/^(1일)?(투여횟수|투약횟수|복용횟수|횟수|회수)$/.test(s)) return fields[1];
  if (/^(총)?(투약일수|투여일수|처방일수|일수)$/.test(s)) return fields[2];
  return null;
}
function headers(rows) {
  let best;
  for (let i = 0; i < rows.length; i++) {
    // Horizontal fragments and stacked header words are both considered. Each
    // semantic span must stay close relative to glyph height, not page coordinates.
    for (const count of [1, 2]) {
      const lines = rows.slice(i, i + count), h = median(lines.flatMap(r => r.words.map(w => w.y1 - w.y0)));
      if (count === 2 && lines[1]?.y - lines[0].y > h * 2.5) continue;
      const ws = lines.flatMap(r => r.words), found = [];
      for (const start of ws) {
        const near = ws.filter(w => w === start || (w.x0 >= start.x0 - h && w.x0 <= start.x1 + h * 6))
          .sort((a, b) => Math.abs(ycenter(a) - ycenter(b)) > h * .55 ? ycenter(a) - ycenter(b) : a.x0 - b.x0);
        const at = near.indexOf(start);
        for (let n = 1; n <= 5; n++) {
          const span = near.slice(at, at + n), field = headerField(span.map(w => w.text).join(''));
          if (field && !found.some(f => f.field === field)) found.push({ field, x: (Math.min(...span.map(w => w.x0)) + Math.max(...span.map(w => w.x1))) / 2 });
        }
      }
      if (found.filter(f => fields.includes(f.field)).length >= 2 && (!best || found.length > best.columns.length))
        best = { end: i + count - 1, columns: found.sort((a, b) => a.x - b.x) };
    }
  }
  return best;
}
// Additive only - reuses the SAME internal header detection parsePrescriptionWords already runs,
// exposed so prescription-columns.js can combine it with vertical-line detection without this file's
// existing name/row parsing being touched at all (item 1 of the request: no regression risk).
export function findHeaderColumns(words) {
  const valid = (words || []).filter(w => w?.text?.trim() && [w.x0, w.y0, w.x1, w.y1].every(Number.isFinite));
  if (!valid.length) return null;
  const header = headers(groupPrescriptionLines(valid));
  return header ? { columns: header.columns, endRowIndex: header.end } : null;
}
const looksDrug = s => /정|캡슐|시럽|현탁액|내복액|과립|산제/.test(s);
// Bounds for a targeted, digits-only re-OCR pass over the whole numeric strip of one row (see
// prescription-ocr.js PASS 2 / item 3-4). Empirically (see the real-Tesseract validation in this PR),
// full-page layout analysis frequently drops the numeric columns entirely - not just misreads them -
// even though the same engine reads a small crop of just that strip near-perfectly. So this cannot
// depend on header-column detection succeeding: x0 is the row's OWN rightmost name-token edge (real
// pixel data, always available whenever a row has a name at all) pushed further right by the header's
// first numeric column start when a header WAS found (never a fixed pixel offset either way) - x1 is
// unbounded, clamped to the actual image width only at crop time. y is this row's own center.
function numericZone(header, row, h) {
  if (!row.name.length) return null;
  const nameX1 = Math.max(...row.name.map(w => w.x1));
  let headerX0 = -Infinity;
  if (header) {
    const numericCols = header.columns.filter(c => fields.includes(c.field)).sort((a, b) => a.x - b.x);
    if (numericCols.length) {
      const idx = header.columns.indexOf(numericCols[0]);
      headerX0 = idx === 0 ? -Infinity : (header.columns[idx - 1].x + numericCols[0].x) / 2;
    }
  }
  return { x0: Math.max(headerX0, nameX1 + h * 1.2), x1: Infinity, y0: row.y - h * .9, y1: row.y + h * .9 };
}
function finish(row, reliable, header, h) {
  const name = parseDrugName(row.name.map(w => w.text).join(''));
  const fieldConfidence = { drugName: conf(row.name) };
  const values = {};
  for (const f of fields) { values[f] = numeric(row[f].map(w => w.text).join('')); fieldConfidence[f] = values[f] == null ? 0 : conf(row[f]); }
  const structuralReview = !reliable || row.ambiguous || !!name.unitOcrFailed;
  return { ...name, ...values, fieldConfidence, confidence: Math.min(...Object.values(fieldConfidence)),
    needsReview: structuralReview || Object.values(fieldConfidence).some(v => v < 70),
    structuralReview, numericZone: numericZone(header, row, h),
    // Raw rightmost x of this row's own name text (no margin) - real pixels whenever a row has a name
    // at all. Used by prescription-columns.js to build precise per-field cells (see item 2-6 there);
    // numericZone above stays as the coarser whole-strip fallback when that finer detection can't run.
    nameRightEdge: row.name.length ? Math.max(...row.name.map(w => w.x1)) : null, rowHeight: h, y: row.y,
    sourceWords: Object.values(row).filter(Array.isArray).flat(), rawText: Object.values(row).filter(Array.isArray).flat().map(w => w.text).join(' ') };
}

export function parsePrescriptionWords(input) {
  const words = (input || []).filter(w => w?.text?.trim() && [w.x0, w.y0, w.x1, w.y1].every(Number.isFinite));
  if (!words.length) return [];
  const rows = groupPrescriptionLines(words), header = headers(rows), h = median(words.map(w => w.y1 - w.y0));
  const result = []; let pending = null;
  for (const line of rows.slice(header ? header.end + 1 : 0)) {
    if (line.words.some(w => /환자|성명|주민|주소|전화|조제료|합계|발행일/.test(w.text))) { pending = null; continue; }
    const row = { name: [], dosePerAdministration: [], frequencyPerDay: [], durationDays: [], y: line.y, ambiguous: false };
    if (header) {
      for (const [index, w] of line.words.entries()) {
        const nearest = header.columns.reduce((a, b) => Math.abs(center(w) - a.x) < Math.abs(center(w) - b.x) ? a : b);
        // Name cells can be wide; text cannot become a numeric dose just because its center crosses a header midpoint.
        const next = line.words[index + 1], previous = line.words[index - 1];
        const nameNumber = /^\d+(?:\.\d+)?$/.test(compact(w.text)) && ((next && next.x0 - w.x1 < h && /^(mg|mcg|mL|ml|g)(?:\/|$)/.test(compact(next.text))) || (previous && w.x0 - previous.x1 < h && /\/$/.test(compact(previous.text))));
        const field = codePattern.test(compact(w.text)) || nameNumber ? 'name' : numeric(w.text) == null && !/^[0-9OIl.,/]+$/.test(compact(w.text)) ? 'name' : nearest.field;
        row[field].push(w);
      }
    } else {
      const ws = [...line.words], tail = [];
      while (ws.length && tail.length < 3 && numeric(ws.at(-1).text) != null) tail.unshift(ws.pop());
      row.name = ws;
      if (tail.length === 3) fields.forEach((f, i) => row[f].push(tail[i]));
      else { row.ambiguous = true; }
    }
    const name = compact(row.name.map(w => w.text).join('')), code = codePattern.test(name);
    const hasValues = fields.some(f => row[f].length);
    if (!name && !hasValues) continue;
    const prev = result.at(-1), close = prev && line.y - prev.y <= h * 1.8;
    if (!pending && !code && !hasValues && close && name && (!looksDrug(parseDrugName(name).drugName) || !looksDrug(prev.name.map(w => w.text).join('')))) {
      prev.name.push(...row.name); prev.y = line.y; continue;
    }
    if (pending && !code && line.y - pending.y <= h * 1.8 && hasValues) {
      row.name.unshift(...pending.name); pending = null;
    } else if (pending) { result.push(pending); pending = null; }
    if (!hasValues && (code || (header && name))) { pending = row; continue; }
    if (name && (code || looksDrug(name) || (header && hasValues))) result.push(row);
  }
  if (pending) result.push(pending);
  return result.map(row => finish(row, !!header, header, h)).filter(r => r.drugName);
}

export function parsePrescriptionText(text) {
  // Text-only fallback retains uncertainty. Newlines are just candidates; codes,
  // numeric tails and continuation logic still decide row boundaries.
  const words = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    let x = 0;
    for (const part of line.trim().split(/\s+|\s*\|\s*/).filter(Boolean)) {
      words.push({ text: part, x0: x, x1: x + part.length * 10, y0: i * 24, y1: i * 24 + 16, confidence: 0 }); x += part.length * 10 + 15;
    }
  });
  // Synthetic X positions cannot establish actual header columns, and are not real canvas pixels -
  // never let a crop pass treat them as a real region to cut out of the actual image.
  return parsePrescriptionWords(words.filter(w => !headerField(w.text))).map(row => ({ ...row, numericZone: null }));
}

export function prescriptionSummary(row) {
  const unit = row.prescribedUnit?.match(/캡슐|포|정|병$/)?.[0] || (/mL/i.test(row.prescribedUnit || '') ? 'mL' : ' (단위 확인)');
  return `처방내용: ${row.dosePerAdministration ?? '?'}${unit} × 하루 ${row.frequencyPerDay ?? '?'}회 × ${row.durationDays ?? '?'}일`;
}
