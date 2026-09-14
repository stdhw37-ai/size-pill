// Layout-agnostic prescription table parser. Pure, DOM-free (like dose-calc.js/pouch-crop.js) so it
// can be unit tested with synthetic word/bbox fixtures instead of real photos - see
// test/rx-layout.test.js for the required regression shapes (table, reordered columns, plain text,
// wrapped lines, mild skew, missing fields).
//
// The hard rule this file exists to satisfy: never hardcode a specific hospital/pharmacy/EMR layout.
// A word's MEANING (which header it sits under, or - with no table at all - a number immediately
// following a drug name) decides what it is, not its position in a fixed template. When that
// meaning can't be pinned down confidently, the item is marked confidence:'low' and the raw text is
// kept so a human can confirm it - this file never invents a value it didn't actually find.

// Input word shape used everywhere below: { text, x0, y0, x1, y1, confidence? } - confidence is
// Tesseract's own per-word OCR confidence (0-100) when available; treated as 100 if absent so a
// caller that doesn't have it (e.g. a test fixture) isn't unfairly downgraded.
const wordConf = w => Number.isFinite(w.confidence) ? w.confidence : 100;
const cx = w => (w.x0 + w.x1) / 2, cy = w => (w.y0 + w.y1) / 2, height = w => Math.max(1, w.y1 - w.y0), width = w => Math.max(1, w.x1 - w.x0);

// Header synonym keyword sets - matched as substrings of a (whitespace-stripped) header cell, so
// "처방의약품의명칭"/"약품명"/"품명" all resolve to itemName without listing every real-world phrase
// verbatim. Extend these lists, never branch on a whole document's layout.
const FIELD_KEYWORDS = {
  itemName: ['약품명', '의약품명', '처방약품명', '품명', '제품명', '명칭', '처방명'],
  dosePerAdministration: ['1회량', '1회투여량', '1회복용량', '1회분', '투여량', '1회투약량'],
  frequencyPerDay: ['1일투여횟수', '1일횟수', '복용횟수', '투여횟수', '1일회수', '횟수'],
  durationDays: ['총투약일수', '투약일수', '처방일수', '총일수', '일수', '기간']
};
function matchField(cellText) {
  const text = String(cellText).replace(/\s+/g, '');
  // Longest-keyword-first avoids "일수" matching inside a itemName cell that happens to contain it.
  const candidates = Object.entries(FIELD_KEYWORDS).flatMap(([field, words]) => words.map(word => ({ field, word })));
  candidates.sort((a, b) => b.word.length - a.word.length);
  for (const { field, word } of candidates) if (text.includes(word)) return field;
  return null;
}

// --- Gap-based clustering (used for both rows-by-Y and cells-by-X) -----------------------------
// A general "large gap = new group" pass, not a fixed grid - this is what lets column order and
// row height vary between documents instead of assuming a template.
function clusterByGap(items, key, spanKey) {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => key(a) - key(b));
  const medianSpan = median(sorted.map(spanKey)) || 10;
  const gapThreshold = medianSpan * 1.4;
  const groups = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const prevGroup = groups[groups.length - 1];
    const prevEdge = Math.max(...prevGroup.map(w => key(w) + spanKey(w) / 2));
    const gap = (key(sorted[i]) - spanKey(sorted[i]) / 2) - prevEdge;
    if (gap > gapThreshold) groups.push([sorted[i]]);
    else prevGroup.push(sorted[i]);
  }
  return groups;
}
function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Rows: cluster by vertical center. Tolerant of mild skew (a few degrees over a row's width, the
// common case for a hand-held phone photo) because line-to-line spacing is normally much larger
// than the Y-drift such a tilt adds across one row - it is not a true deskew/rotation correction.
export function groupWordsIntoLines(words) {
  if (!words.length) return [];
  const groups = clusterByGap(words, cy, height);
  return groups
    .map(group => ({ words: [...group].sort((a, b) => a.x0 - b.x0), y: median(group.map(cy)) }))
    .sort((a, b) => a.y - b.y);
}
// Cells within one row: cluster by horizontal gap so "1회" + "투여량" (OCR'd as two boxes close
// together) become one header cell, while genuinely separate table columns stay separate.
export function groupWordsIntoCells(rowWords) {
  if (!rowWords.length) return [];
  const groups = clusterByGap(rowWords, cx, width);
  return groups.map(group => {
    const sorted = [...group].sort((a, b) => a.x0 - b.x0);
    return { text: sorted.map(w => w.text).join('').trim() || sorted.map(w => w.text).join(' ').trim(), words: sorted, x0: Math.min(...sorted.map(w => w.x0)), x1: Math.max(...sorted.map(w => w.x1)) };
  });
}

// Looks for the row with the most distinct recognized field headers (>=2, so one stray matching
// word can't misfire) and turns its cells into named columns spanning out to the midpoint between
// neighboring headers (so a data cell that's a little off from its header's own X range still maps
// to the right column).
export function findHeaderRow(lines) {
  let best = null;
  for (let i = 0; i < lines.length; i++) {
    const cells = groupWordsIntoCells(lines[i].words);
    const matched = cells.map(cell => ({ ...cell, field: matchField(cell.text) })).filter(c => c.field);
    const distinctFields = new Set(matched.map(c => c.field));
    if (distinctFields.size >= 2 && (!best || distinctFields.size > best.distinctFields)) {
      best = { lineIndex: i, matched: matched.sort((a, b) => a.x0 - b.x0), distinctFields: distinctFields.size };
    }
  }
  if (!best) return null;
  const columns = best.matched.map((cell, idx) => {
    const prevMid = idx === 0 ? -Infinity : (best.matched[idx - 1].x1 + cell.x0) / 2;
    const nextMid = idx === best.matched.length - 1 ? Infinity : (cell.x1 + best.matched[idx + 1].x0) / 2;
    return { field: cell.field, x0: prevMid, x1: nextMid, headerText: cell.text };
  });
  return { lineIndex: best.lineIndex, columns };
}
function columnForCell(cell, columns) {
  const center = (cell.x0 + cell.x1) / 2;
  const contained = columns.find(c => center >= c.x0 && center < c.x1);
  if (contained) return contained;
  // No exact containment (ragged OCR column edges) - fall back to nearest column center.
  return columns.reduce((closest, c) => {
    const colCenter = Number.isFinite(c.x0) && Number.isFinite(c.x1) ? (Math.max(c.x0, -1e6) + Math.min(c.x1, 1e6)) / 2 : center;
    const dist = Math.abs(center - colCenter);
    return dist < closest.dist ? { col: c, dist } : closest;
  }, { col: columns[0], dist: Infinity }).col;
}

// --- Value extraction from a cell's text --------------------------------------------------------
const DOSE_RE = /([\d.]+)\s*(정|캡슐|T|mL|밀리리터|포)(?![가-힣])/i;
const FREQ_RE = /([\d.]+)\s*회/;
const DAYS_RE = /([\d.]+)\s*일(?!분)|([\d.]+)\s*일분/;
const UNIT_MAP = { 정: 'tablet', 캡슐: 'tablet', T: 'tablet', mL: 'mL', 밀리리터: 'mL', 포: 'pack' };
function extractDose(text) { const m = text.match(DOSE_RE); return m ? { amount: Number(m[1]), unit: UNIT_MAP[m[2]] || null } : null; }
function extractFrequency(text) { const m = text.match(FREQ_RE); return m ? Number(m[1]) : null; }
function extractDays(text) { const m = text.match(DAYS_RE); return m ? Number(m[1] || m[2]) : null; }

// 보험/청구/조제 코드는 보통 앞쪽에 붙는 8자리 이상의 숫자열이다 - 제품명 앞에서만, 뒤에 남는 글자가 있을
// 때만 제거한다(코드 하나만 있는 셀을 통째로 지워 빈 이름을 만들지 않도록).
export function stripLeadingCode(text) {
  const stripped = text.replace(/^\s*\d{8,}\s*/, '');
  return stripped.trim() || text.trim();
}
// A continuation row looks like a lone drug-name fragment with no dose/frequency/day cell filled in
// - e.g. "8시간이알서방정500mg" wrapped onto its own line after "타이레놀". Merged into the previous
// item's name rather than treated as a separate (dose-less) prescription line.
function looksLikeNameOnly(item) {
  return item.itemName && item.dosePerAdministration == null && item.frequencyPerDay == null && item.durationDays == null;
}

// 약품명 셀 안에서 이름과 함량(mg)을 분리한다 - 둘 다 이름 텍스트 안에 같이 들어오는 경우가 보통이다.
function splitNameAndStrength(text) {
  const cleaned = stripLeadingCode(text);
  const strengthMatch = cleaned.match(/([\d.]+)\s*(mg|mcg|g|밀리그램|그램)/i);
  return { itemName: cleaned, strength: strengthMatch ? strengthMatch[0].replace(/\s+/g, '') : null };
}

// --- Table path ------------------------------------------------------------------------------
// Each WORD (not a pre-clustered cell) is assigned to its nearest header column independently.
// Clustering data-row words into cells first (like the header row needs to, since its columns are
// still unknown) breaks down here: a long product name sitting right next to a short "3회" value
// skews the row's own median word width way up, so the adaptive gap threshold derived from that
// row can swallow the gap to the next real column. Column boundaries are already known once a
// header exists, so per-word nearest-column assignment sidesteps that instability entirely.
function parseTableRow(rowWords, columns) {
  const byField = {};
  for (const word of rowWords) {
    const col = columnForCell({ x0: word.x0, x1: word.x1 }, columns);
    (byField[col.field] ||= []).push(word);
  }
  for (const field of Object.keys(byField)) byField[field].sort((a, b) => a.x0 - b.x0);
  const nameCell = byField.itemName?.map(w => w.text).join(' ') || '';
  const { itemName, strength } = splitNameAndStrength(nameCell);
  const doseCell = byField.dosePerAdministration?.map(w => w.text).join(' ') || '';
  const freqCell = byField.frequencyPerDay?.map(w => w.text).join(' ') || '';
  const daysCell = byField.durationDays?.map(w => w.text).join(' ') || '';
  const dose = extractDose(doseCell);
  const allWords = Object.values(byField).flat();
  const avgConfidence = allWords.length ? allWords.reduce((s, w) => s + wordConf(w), 0) / allWords.length : 100;
  const item = {
    itemName: itemName || null, strength,
    dosePerAdministration: dose?.amount ?? null, doseUnit: dose?.unit ?? null,
    frequencyPerDay: extractFrequency(freqCell), durationDays: extractDays(daysCell),
    rawText: rowWords.map(w => w.text).join(' ')
  };
  // High confidence requires: a real item name, at least one dose field actually found, and decent
  // average OCR confidence on the words that fed those fields - anything less asks a human to check.
  const gotAnyDoseField = item.dosePerAdministration != null || item.frequencyPerDay != null || item.durationDays != null;
  item.confidence = item.itemName && gotAnyDoseField && avgConfidence >= 70 ? 'high' : 'low';
  return item;
}

// --- Single-line (no table) path -----------------------------------------------------------
// Recognizes a drug-form-suffixed name (mirrors extractRxNames' own pattern) then looks for
// dose/frequency/day tokens anywhere later on the same line - order-independent within the line.
// First character allows a digit too (real product names embed one - e.g. "8시간이알서방정", the
// actual registered name for a Tylenol ER product), and an optional trailing strength is captured
// along with the name instead of being left dangling as unmatched text.
const NAME_RE = /[가-힣A-Za-z0-9][가-힣A-Za-z0-9-]{1,40}(?:정|캡슐|시럽|현탁액|내복액|산|과립)(?:\s*\d+(?:\.\d+)?\s*(?:mg|mcg|밀리그램|g)?)?/;
function parseSingleLine(lineWords, namePrefix = '') {
  const text = lineWords.map(w => w.text).join(' ');
  const nameMatch = text.match(NAME_RE);
  if (!nameMatch) return null;
  const { itemName, strength } = splitNameAndStrength(namePrefix + nameMatch[0]);
  const rest = text.slice(nameMatch.index + nameMatch[0].length);
  const dose = extractDose(rest) || extractDose(text);
  const item = {
    itemName, strength,
    dosePerAdministration: dose?.amount ?? null, doseUnit: dose?.unit ?? null,
    frequencyPerDay: extractFrequency(rest), durationDays: extractDays(rest),
    rawText: (namePrefix ? namePrefix + ' ' : '') + text
  };
  // A single-line match is never marked 'high' even when every field parses - there is no header
  // row confirming these numbers actually mean dose/frequency/days rather than something else on
  // the same line, so a human still gets a chance to check it (see request item 7).
  item.confidence = 'low';
  return item;
}

// --- Top-level entry point -----------------------------------------------------------------
// words: flat array of { text, x0, y0, x1, y1, confidence? } for the whole page (any reading order).
export function parsePrescriptionWords(words) {
  const cleanWords = (words || []).filter(w => w && String(w.text || '').trim());
  if (!cleanWords.length) return [];
  const lines = groupWordsIntoLines(cleanWords);
  const header = findHeaderRow(lines);
  let items = [];
  if (header) {
    for (let i = 0; i < lines.length; i++) {
      if (i === header.lineIndex) continue;
      const row = parseTableRow(lines[i].words, header.columns);
      if (row.itemName || row.dosePerAdministration != null || row.frequencyPerDay != null || row.durationDays != null) items.push(row);
    }
  } else {
    for (const line of mergeWrappedNameLines(lines)) {
      const item = parseSingleLine(line.words, line.namePrefix);
      if (item) items.push(item);
    }
  }
  return mergeContinuationRows(items);
}
// Table-free layout only: a name that wraps onto its own line before the line carrying the dose
// suffix (예: "타이레놀" 줄바꿈 "8시간이알서방정500mg 1정 1일 2회") never matches NAME_RE on its own,
// so it would otherwise be silently dropped. If a line has no drug-suffix match and the very next
// line does (and sits close enough below it to plausibly be the same wrapped name), its raw text is
// carried as a namePrefix that parseSingleLine prepends to whatever NAME_RE finds on the next line -
// kept as text rather than merged words, since the fragment itself never matches the pattern anyway.
function mergeWrappedNameLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], next = lines[i + 1];
    const lineText = line.words.map(w => w.text).join(' ').trim();
    if (lineText && !NAME_RE.test(lineText) && next && NAME_RE.test(next.words.map(w => w.text).join(' '))) {
      const avgHeight = median(line.words.map(height)) || 10;
      if (next.y - line.y < avgHeight * 3) { out.push({ y: line.y, words: next.words, namePrefix: lineText }); i++; continue; }
    }
    out.push({ ...line, namePrefix: '' });
  }
  return out;
}
// 제품명만 있고 용량 정보가 하나도 없는 행은, 바로 다음 행에 용량 정보가 있다면 그 행의 이름 앞에 붙여
// 합친다(예: "타이레놀" 한 줄 + "8시간이알서방정500mg 1정 1일 2회" 다음 줄).
export function mergeContinuationRows(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i], next = items[i + 1];
    if (looksLikeNameOnly(item) && next && next.itemName) {
      next.itemName = `${item.itemName}${next.itemName}`;
      next.rawText = `${item.rawText} ${next.rawText}`.trim();
      continue; // fold into next, don't emit this fragment on its own
    }
    out.push(item);
  }
  return out;
}
