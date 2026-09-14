// Pure, DOM-free prescription-dose math and official-usage-text parsing. Kept separate from app.js
// (like pouch-crop.js) so the calculations - the part that most needs to be exactly right - can be
// unit tested with plain strings/numbers, independent of OCR/DOM wiring.
//
// Hard rule throughout this file: never assert "적정/부적정/과량" or any clinical judgment. Every
// function here either (a) returns a plain computed number, or (b) returns one of a fixed set of
// neutral position labels (see POSITION) plus the numbers a person needs to judge for themselves.
// When the official usage text can't be parsed with real confidence, say so - never guess a range.

const UNIT_TO_MG = { 그램: 1000, 그람: 1000, g: 1000, 밀리그램: 1, 밀리그람: 1, mg: 1, 마이크로그램: 0.001, mcg: 0.001, 'µg': 0.001 };

function normalizeAmountToMg(amount, unit) {
  const factor = UNIT_TO_MG[String(unit || '').trim()];
  return Number.isFinite(amount) && factor ? amount * factor : null;
}

// Rounds to 1 decimal and drops a trailing ".0" so whole numbers print as "650", not "650.0" -
// matches the worked examples in the request (216.7mg but 650mg/day, not 650.0mg/day).
export function round1(n) {
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}
export function formatMg(exact, unit = 'mg') {
  if (!Number.isFinite(exact)) return null;
  const rounded = round1(exact);
  const approx = Math.abs(exact - rounded) > 1e-9;
  const text = Number.isInteger(rounded) ? String(rounded) : String(rounded);
  return `${approx ? '약 ' : ''}${text} ${unit}`;
}

// "0.6667T" / "0.5정" / "1.5 T" / "1정" -> 0.6667 / 0.5 / 1.5 / 1. Also accepts a bare "1/2" style
// fraction some prescriptions use for half tablets.
export function parseTabletFraction(token) {
  const text = String(token || '').trim();
  let m = text.match(/^([\d.]+)\s*(?:정|캡슐|T)$/i);
  if (m) return Number(m[1]);
  m = text.match(/^(\d+)\s*\/\s*(\d+)\s*(?:정|캡슐|T)?$/i);
  if (m) return Number(m[1]) / Number(m[2]);
  return null;
}

// materials 필드는 "총량 : ...|성분명 : X|분량 : Y|단위 : Z|..." 그룹을 ";"로 이어붙인 자유 텍스트다
// (여러 색소/처방 변형이 같은 성분을 반복할 수 있음 - 성분명당 처음 나오는 그룹만 사용한다).
// Returns [{ name, amountMg, totalText }] - totalText is the raw "총량 : ..." segment, needed by
// concentrationsPerMl() below to find the syrup's total volume.
export function parseIngredients(materialsText) {
  const text = String(materialsText || '');
  const seen = new Set();
  const out = [];
  for (const group of text.split(';')) {
    const total = group.match(/총량\s*:\s*([^|]+)/)?.[1]?.trim() || '';
    const name = group.match(/성분명\s*:\s*([^|]+)/)?.[1]?.trim();
    const amountRaw = group.match(/분량\s*:\s*([\d.]+)/)?.[1];
    const unit = group.match(/단위\s*:\s*([^|]+)/)?.[1]?.trim();
    if (!name || amountRaw === undefined || seen.has(name)) continue;
    const amountMg = normalizeAmountToMg(Number(amountRaw), unit);
    if (amountMg === null) continue;
    seen.add(name);
    out.push({ name, amountMg, totalText: total });
  }
  return out;
}
// mg per tablet/capsule (dosage-form-unit basis) - just the parsed amount, no volume division.
export function tabletStrengthMg(materialsText, ingredientName = null) {
  const list = parseIngredients(materialsText);
  const row = ingredientName ? list.find(i => i.name === ingredientName) : list[0];
  return row ? row.amountMg : null;
}
// mg per mL for a syrup/liquid - divides each ingredient's parsed amount by the volume named in its
// own "총량" segment (e.g. "총량 : 이 약 100밀리리터 중..." -> 100). Returns null per ingredient
// when no volume can be found in that segment (never assumes a default volume).
export function concentrationsPerMl(materialsText) {
  return parseIngredients(materialsText).map(({ name, amountMg, totalText }) => {
    const volumeMl = Number(totalText.match(/([\d.]+)\s*(?:mL|밀리리터)/)?.[1]);
    return { name, mgPerMl: volumeMl > 0 ? amountMg / volumeMl : null };
  });
}

export function doseFromTablet(tabletStrengthMgValue, tabletFraction) {
  return Number.isFinite(tabletStrengthMgValue) && Number.isFinite(tabletFraction) ? tabletStrengthMgValue * tabletFraction : null;
}
export function doseFromSyrup(mgPerMl, volumeMl) {
  return Number.isFinite(mgPerMl) && Number.isFinite(volumeMl) ? mgPerMl * volumeMl : null;
}
export function dailyTotal(doseMg, frequencyPerDay) {
  return Number.isFinite(doseMg) && Number.isFinite(frequencyPerDay) ? doseMg * frequencyPerDay : null;
}
export function perKg(mg, weightKg) {
  return Number.isFinite(mg) && weightKg > 0 ? mg / weightKg : null;
}

// --- OCR prescription-line parsing -----------------------------------------------------------
// A real 처방전 lists, per drug, a strength-bearing name plus (조제단위 1회투약량 / 1일투여횟수 /
// 총투약일수) - usually as separate table columns that OCR flattens onto one or two lines near the
// drug name. This looks a fixed window of lines after each drug-name match (see extractRxNames'
// own regex, mirrored here) for the first dose/frequency/day tokens, rather than trying to parse a
// whole free-form table.
// \b after a Hangul unit word is unreliable (Korean characters aren't "word" characters for \b), so
// the alternation's own specificity is what keeps this from over-matching, not a trailing boundary.
const DOSE_TOKEN = /(?:1\s*회\s*[:：]?\s*)?([\d.]+)\s*(정|캡슐|T|mL|밀리리터|포)(?![가-힣])/i;
const FREQ_TOKEN = /1\s*일\s*[:：]?\s*([\d.]+)\s*회/;
const DAYS_TOKEN = /([\d.]+)\s*일분|총\s*([\d.]+)\s*일/;
export function parseOcrDoseNear(text, startIndex, windowChars = 80) {
  const window = String(text).slice(startIndex, startIndex + windowChars);
  const dose = window.match(DOSE_TOKEN);
  const freq = window.match(FREQ_TOKEN);
  const days = window.match(DAYS_TOKEN);
  const unitMap = { 정: 'tablet', 캡슐: 'tablet', T: 'tablet', mL: 'mL', 밀리리터: 'mL', 포: 'pack' };
  return {
    doseAmount: dose ? Number(dose[1]) : null,
    doseUnit: dose ? unitMap[dose[2]] || null : null,
    frequencyPerDay: freq ? Number(freq[1]) : null,
    days: days ? Number(days[1] || days[2]) : null
  };
}

// --- Official usage-text parsing --------------------------------------------------------------
// Real 사용법(e약은요) text has no fixed schema - these are independent, narrow regexes for the
// templates actually observed in production data (see test/dose-calc.test.js for the exact source
// strings), not a general NLP parser. Each field is accepted only when its own pattern matches
// unambiguously; anything else is left null so the caller shows "추가 정보가 필요합니다" instead of
// guessing. confidence is 'ok' only when there's enough to draw at least one comparison.
export function parseOfficialDosage(usageText) {
  const text = String(usageText || '').replace(/\r/g, '');
  const range = (a, b) => (a === undefined ? null : { min: Number(a), max: b === undefined ? Number(a) : Number(b) });

  const ageMatch = text.match(/만\s*(\d+)\s*세\s*이상/) || text.match(/생후\s*(\d+)\s*개월\s*이상/);
  const ageMin = ageMatch ? Number(ageMatch[1]) : null;
  const ageUnit = text.includes('개월 이상') && !text.match(/만\s*\d+\s*세\s*이상/) ? 'month' : 'year';

  const mgPerKgSingle = text.match(/1\s*회[^()]*\(?\s*([\d.]+)\s*[~∼-]\s*([\d.]+)\s*mg\s*\/\s*kg/);
  const mlPerKgSingle = text.match(/1\s*회[^()]*?([\d.]+)\s*[~∼-]\s*([\d.]+)\s*mL\s*\/\s*kg/);
  const tabletSingle = text.match(/1\s*회\s*([\d.]+)(?:\s*[~∼-]\s*([\d.]+))?\s*(?:정|캡슐)\s*씩?/);
  const mlSingleAged = text.match(/([\d.]+)\s*mL\s*씩\s*복용/);

  const frequencyMatch = text.match(/1\s*일\s*([\d.]+)(?:\s*[~∼-]\s*([\d.]+))?\s*회/);
  const intervalMatch = text.match(/([\d.]+)(?:\s*[~∼-]\s*([\d.]+))?\s*시간\s*(?:마다|간격)/);

  const dailyMaxPerKg = text.match(/1\s*일\s*최대[^()]*\(\s*([\d.]+)\s*mg\s*\/\s*kg\s*\)/);
  const dailyMaxAbs = text.match(/1\s*일\s*최대[^0-9]*?([\d.]+)\s*(mg|g)\b/) || text.match(/24\s*시간\s*동안\s*([\d.]+)\s*mL/);
  const dailyMaxTablets = text.match(/1\s*일\s*최대\s*([\d.]+)\s*정/);

  const singleDoseMgPerKg = mgPerKgSingle ? range(mgPerKgSingle[1], mgPerKgSingle[2]) : null;
  const singleDoseMlPerKg = mlPerKgSingle ? range(mlPerKgSingle[1], mlPerKgSingle[2]) : null;
  const singleDoseTablets = tabletSingle ? range(tabletSingle[1], tabletSingle[2]) : null;
  const singleDoseMl = mlSingleAged ? range(mlSingleAged[1]) : null;
  const frequency = frequencyMatch ? range(frequencyMatch[1], frequencyMatch[2]) : null;
  const intervalHours = intervalMatch ? range(intervalMatch[1], intervalMatch[2]) : null;
  const dailyMaxMgPerKg = dailyMaxPerKg ? Number(dailyMaxPerKg[1]) : null;
  const dailyMaxMg = dailyMaxAbs ? (dailyMaxAbs[2] === 'g' ? Number(dailyMaxAbs[1]) * 1000 : dailyMaxAbs[2] ? Number(dailyMaxAbs[1]) : null) : null;
  const dailyMaxMl = !dailyMaxAbs?.[2] && dailyMaxAbs ? Number(dailyMaxAbs[1]) : null;
  const dailyMaxTabletsVal = dailyMaxTablets ? Number(dailyMaxTablets[1]) : null;

  const hasAnySingleDose = singleDoseMgPerKg || singleDoseMlPerKg || singleDoseTablets || singleDoseMl;
  // Multiple distinct age bands (each with its own dose) mean one single comparison would be
  // misleading without knowing which band applies - the caller must match the patient's age first.
  const ageBandCount = (text.match(/만\s*\d+\s*세\s*이상|생후\s*\d+\s*개월\s*이상/g) || []).length;

  return {
    confidence: hasAnySingleDose ? 'ok' : 'insufficient',
    ageMin, ageUnit, ageBandCount,
    singleDoseMgPerKg, singleDoseMlPerKg, singleDoseTablets, singleDoseMl,
    frequency, intervalHours,
    dailyMaxMgPerKg, dailyMaxMg, dailyMaxMl, dailyMaxTablets: dailyMaxTabletsVal
  };
}

// One of these five labels only - see request section 13. Never "적정/부적정/과량/안전/위험".
export const POSITION = {
  BELOW: '허가사항에 기재된 일반적인 범위보다 낮음',
  LOW_IN_RANGE: '허가사항 범위의 하단에 가까움',
  IN_RANGE: '허가사항의 일반적인 범위 내',
  HIGH_IN_RANGE: '허가사항 범위의 상단에 가까움',
  ABOVE: '허가사항에 기재된 일반적인 범위보다 높음'
};
// value's position within [min,max], expressed as one of the five neutral labels above (never a
// verdict) plus the 0..1 fraction a range bar can use directly as its marker position.
export function positionInRange(value, min, max) {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  if (value < min) return { label: POSITION.BELOW, fraction: 0 };
  if (value > max) return { label: POSITION.ABOVE, fraction: 1 };
  const fraction = (value - min) / (max - min);
  const label = fraction <= 0.2 ? POSITION.LOW_IN_RANGE : fraction >= 0.8 ? POSITION.HIGH_IN_RANGE : POSITION.IN_RANGE;
  return { label, fraction };
}

// Coarser 5-state vocabulary requested alongside POSITION's finer 5-label range-bar wording - never
// a verdict either, just which of the two sits closer to a UI badge/one-line summary. positionInRange
// (and its bar) stay exactly as they were; this only adds names/messages on top for that use.
export const COMPARISON_STATUS = { WITHIN: 'within-reference', ABOVE: 'above-reference', BELOW: 'below-reference', INSUFFICIENT: 'insufficient-data', NOT_APPLICABLE: 'not-applicable' };
export const COMPARISON_MESSAGE = {
  'within-reference': '허가사항에 기재된 1회 용량 범위에 해당합니다.',
  'above-reference': '허가사항에 기재된 일반적인 1회 용량 범위보다 높습니다. 처방 의료기관 또는 약사에게 확인하세요.',
  'below-reference': '허가사항에 기재된 일반적인 1회 용량 범위보다 낮습니다. 환자 상태나 처방 목적에 따라 달라질 수 있습니다.',
  'insufficient-data': '현재 정보만으로는 공식 용법·용량과 비교할 수 없습니다.',
  'not-applicable': '이 제품은 현재 자동 용량 비교를 지원하지 않습니다.'
};
export function comparisonStatusFromPosition(position) {
  if (!position) return COMPARISON_STATUS.INSUFFICIENT;
  if (position.label === POSITION.ABOVE) return COMPARISON_STATUS.ABOVE;
  if (position.label === POSITION.BELOW) return COMPARISON_STATUS.BELOW;
  return COMPARISON_STATUS.WITHIN;
}

// Pure computation core of "용량 분석 보기" (item 4-17 of the request): (처방 1회량 + 공식 성분/함량 +
// 공식 용법·용량 텍스트 + [선택] 체중) -> per-ingredient mg, daily total, mg/kg, and a neutral
// comparison against the official range. Never a verdict (see the POSITION/COMPARISON_MESSAGE
// comments above). Kept DOM/network-free on purpose so it is fully unit-testable - app.js's
// computeDoseAnalysis() only gathers the inputs (official 함량/usage text, which need a fetch) and
// calls this.
export function analyzeDose({ ocr, kind, materials, usageText, patientWeightKg }) {
  const guards = [];
  if (!ocr || !Number.isFinite(ocr.doseAmount)) {
    return { status: 'insufficient', comparisons: [], perIngredient: [], ocr, guards: ['처방전에서 1회 투여량을 정확히 읽지 못했습니다. 정확한 용량 비교를 위해 추가 정보가 필요합니다.'] };
  }
  const rawIngredients = parseIngredients(materials || '');
  if (!rawIngredients.length) {
    return { status: 'insufficient', comparisons: [], perIngredient: [], ocr, guards: ['제품의 성분 함량 정보(공식 허가정보)를 확인하지 못했습니다. 정확한 용량 비교를 위해 추가 정보가 필요합니다.'] };
  }
  const concByMl = kind === 'liquid' ? new Map(concentrationsPerMl(materials).map(c => [c.name, c.mgPerMl])) : null;
  const multiIngredient = rawIngredients.length > 1;
  // Multi-ingredient (복합제) products are never summed into one "총 mg" - each ingredient keeps its
  // own line throughout (item 17), since a single combined number would misrepresent a combination
  // product as if it were one active ingredient with one reference range.
  if (multiIngredient) guards.push('복합제입니다 - 성분별로 각각 계산했습니다.');

  const unitOk = kind === 'liquid' ? (!ocr.doseUnit || ocr.doseUnit === 'mL') : (!ocr.doseUnit || ocr.doseUnit === 'tablet');
  if (!unitOk) guards.push('처방전에서 읽은 단위가 제품 제형과 달라 자동 계산을 보류합니다.');

  const perIngredient = rawIngredients.map(ing => {
    if (!unitOk) return { name: ing.name, status: 'insufficient' };
    const doseMg = kind === 'liquid' ? doseFromSyrup(concByMl.get(ing.name), ocr.doseAmount) : doseFromTablet(ing.amountMg, ocr.doseAmount);
    if (doseMg === null) return { name: ing.name, status: 'insufficient' };
    const dailyMg = Number.isFinite(ocr.frequencyPerDay) ? dailyTotal(doseMg, ocr.frequencyPerDay) : null;
    const mgPerKgDose = patientWeightKg ? perKg(doseMg, patientWeightKg) : null;
    const mgPerKgDay = patientWeightKg && dailyMg !== null ? perKg(dailyMg, patientWeightKg) : null;
    return { name: ing.name, status: 'ok', doseMg, dailyMg, mgPerKgDose, mgPerKgDay };
  });

  const official = usageText ? parseOfficialDosage(usageText) : { confidence: 'insufficient' };
  if (!patientWeightKg && (official.singleDoseMgPerKg || official.singleDoseMlPerKg)) guards.push('체중을 입력하지 않아 체중(mg/kg·mL/kg) 기준 비교를 표시하지 않습니다.');
  if (official.ageBandCount > 1) guards.push('연령대별로 허가용량이 다른 제품입니다 - 처방전 인식만으로는 어느 연령대 기준인지 자동으로 판단하지 않습니다. 허가사항 전체를 직접 확인해주세요.');
  if (/신[ \t]*기능|간[ \t]*기능|투석|신부전|간부전/.test(usageText || '')) guards.push('신기능·간기능 등에 따라 용량 조절이 필요할 수 있는 약입니다. 해당 사항이 있다면 의사·약사와 상의해주세요.');
  if (multiIngredient && perIngredient.some(p => p.status === 'insufficient')) guards.push('복합제 성분 중 일부는 용량을 계산하지 못했습니다.');

  // Comparison priority: weight-based mg/kg > weight-based mL/kg > plain tablet-count range > plain
  // single mL (only when there's exactly one age band, i.e. no ambiguity about which line applies).
  const comparisons = perIngredient.filter(p => p.status === 'ok').map(p => {
    let range = null, actual = null, unit = '';
    if (patientWeightKg && official.singleDoseMgPerKg && Number.isFinite(p.mgPerKgDose)) { range = official.singleDoseMgPerKg; actual = p.mgPerKgDose; unit = 'mg/kg/회'; }
    else if (patientWeightKg && kind === 'liquid' && official.singleDoseMlPerKg && Number.isFinite(patientWeightKg)) { range = official.singleDoseMlPerKg; actual = round1(ocr.doseAmount / patientWeightKg); unit = 'mL/kg/회'; }
    else if (kind === 'pill' && official.singleDoseTablets && Number.isFinite(ocr.doseAmount)) { range = official.singleDoseTablets; actual = ocr.doseAmount; unit = '정/회'; }
    else if (kind === 'liquid' && official.singleDoseMl && official.ageBandCount <= 1 && Number.isFinite(ocr.doseAmount)) { range = official.singleDoseMl; actual = ocr.doseAmount; unit = 'mL/회'; }
    const position = range ? positionInRange(actual, range.min, range.max) : null;
    // insufficient-data (not not-applicable) whenever this ingredient in principle COULD be compared
    // but a specific condition is missing (no weight, ambiguous age band, ...) - not-applicable is
    // reserved for products this feature does not attempt to compare at all (see item 12).
    const comparisonStatus = comparisonStatusFromPosition(position);
    return { name: p.name, ...p, range, actual, unit, position, comparisonStatus, comparisonMessage: COMPARISON_MESSAGE[comparisonStatus] };
  });
  const anyComparable = comparisons.some(c => c.position);
  const status = anyComparable && official.ageBandCount <= 1 ? 'ok' : (perIngredient.some(p => p.status === 'ok') ? 'partial' : 'insufficient');
  if (status !== 'ok' && !guards.length) guards.push('정확한 용량 비교를 위해 추가 정보가 필요합니다.');
  return {
    status, ocr, perIngredient, comparisons, official, usageText, guards,
    sourceLabel: 'e약은요 · 식품의약품안전처', sourceUrl: 'https://www.data.go.kr/data/15075057/openapi.do'
  };
}
