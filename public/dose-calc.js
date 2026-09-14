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
    let amountMg = normalizeAmountToMg(Number(amountRaw), unit);
    // 일부 품목(예: 듀파락시럽 - 원료 자체가 농축액이라 "분량 : 67|단위 : 밀리리터"처럼 부피로 기재됨)은
    // 분량/단위가 질량이 아니다 - 이 경우 실제 유효성분량은 별도 자유텍스트 "성분정보 : OO로서 66.7그램"
    // 안에만 들어있다. 제품명으로 값을 추정하지 않고, 이 문서화된 필드 안의 실제 텍스트를 파싱할 때만
    // 사용한다 - 패턴이 없으면 그대로 포기(null)하고 절대 추측하지 않는다.
    if (amountMg === null) {
      const info = group.match(/성분정보\s*:\s*([^|]+)/)?.[1] || '';
      const fallback = info.match(/([\d.]+)\s*(그램|그람|g|밀리그램|밀리그람|mg|마이크로그램|mcg|µg)/);
      if (fallback) amountMg = normalizeAmountToMg(Number(fallback[1]), fallback[2]);
    }
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

  // [^()]* must be lazy (like mlPerKgSingle right below) - greedy backtracking here previously split a
  // plain, non-parenthesized "10~15mg/kg" by consuming the "1" of "10" into the prefix and capturing
  // "0" as the first number, silently producing {min:0, max:15} instead of {min:10, max:15}.
  const mgPerKgSingle = text.match(/1\s*회[^()]*?\(?\s*([\d.]+)\s*[~∼-]\s*([\d.]+)\s*mg\s*\/\s*kg/);
  const mlPerKgSingle = text.match(/1\s*회[^()]*?([\d.]+)\s*[~∼-]\s*([\d.]+)\s*mL\s*\/\s*kg/);
  const tabletSingle = text.match(/1\s*회\s*([\d.]+)(?:\s*[~∼-]\s*([\d.]+))?\s*(?:정|캡슐)\s*씩?/);
  const mlSingleAged = text.match(/([\d.]+)\s*mL\s*씩\s*복용/);
  // Plain absolute-mg single dose ("1회 300mg", "1회 250~500mg") - independent of the mg/kg pattern
  // above; the negative lookahead keeps a "10~15mg/kg" from also matching here as a false "10~15mg".
  const mgSingle = text.match(/1\s*회[^()]*?([\d.]+)(?:\s*[~∼-]\s*([\d.]+))?\s*mg(?!\s*\/\s*kg)/);

  const frequencyMatch = text.match(/1\s*일\s*([\d.]+)(?:\s*[~∼-]\s*([\d.]+))?\s*회/);
  const intervalMatch = text.match(/([\d.]+)(?:\s*[~∼-]\s*([\d.]+))?\s*시간\s*(?:마다|간격)/);

  const dailyMaxPerKg = text.match(/1\s*일\s*최대[^()]*\(\s*([\d.]+)\s*mg\s*\/\s*kg\s*\)/);
  const dailyMaxAbs = text.match(/1\s*일\s*최대[^0-9]*?([\d.]+)\s*(mg|g)\b/) || text.match(/24\s*시간\s*동안\s*([\d.]+)\s*mL/);
  const dailyMaxTablets = text.match(/1\s*일\s*최대\s*([\d.]+)\s*정/);

  const singleDoseMgPerKg = mgPerKgSingle ? range(mgPerKgSingle[1], mgPerKgSingle[2]) : null;
  const singleDoseMlPerKg = mlPerKgSingle ? range(mlPerKgSingle[1], mlPerKgSingle[2]) : null;
  const singleDoseTablets = tabletSingle ? range(tabletSingle[1], tabletSingle[2]) : null;
  const singleDoseMl = mlSingleAged ? range(mlSingleAged[1]) : null;
  const singleDoseMg = mgSingle ? range(mgSingle[1], mgSingle[2]) : null;
  const frequency = frequencyMatch ? range(frequencyMatch[1], frequencyMatch[2]) : null;
  const intervalHours = intervalMatch ? range(intervalMatch[1], intervalMatch[2]) : null;
  const dailyMaxMgPerKg = dailyMaxPerKg ? Number(dailyMaxPerKg[1]) : null;
  const dailyMaxMg = dailyMaxAbs ? (dailyMaxAbs[2] === 'g' ? Number(dailyMaxAbs[1]) * 1000 : dailyMaxAbs[2] ? Number(dailyMaxAbs[1]) : null) : null;
  const dailyMaxMl = !dailyMaxAbs?.[2] && dailyMaxAbs ? Number(dailyMaxAbs[1]) : null;
  const dailyMaxTabletsVal = dailyMaxTablets ? Number(dailyMaxTablets[1]) : null;

  const hasAnySingleDose = singleDoseMgPerKg || singleDoseMlPerKg || singleDoseTablets || singleDoseMl || singleDoseMg;
  // Multiple distinct age bands (each with its own dose) mean one single comparison would be
  // misleading without knowing which band applies - the caller must match the patient's age first.
  const ageBandCount = (text.match(/만\s*\d+\s*세\s*이상|생후\s*\d+\s*개월\s*이상/g) || []).length;

  return {
    confidence: hasAnySingleDose ? 'ok' : 'insufficient',
    ageMin, ageUnit, ageBandCount,
    singleDoseMgPerKg, singleDoseMlPerKg, singleDoseTablets, singleDoseMl, singleDoseMg,
    frequency, intervalHours,
    dailyMaxMgPerKg, dailyMaxMg, dailyMaxMl, dailyMaxTablets: dailyMaxTabletsVal,
    // item P: 1일 최대 투여횟수 그 자체(주로 frequency.max와 같은 값이지만, "1일 4회를 초과하지 않는다"
    // 처럼 범위 없이 상한만 명시하는 문장도 있어 별도 패턴으로 캡처한다).
    maxFrequencyPerDay: (() => {
      const m = text.match(/1\s*일\s*([\d.]+)\s*회(?:를)?\s*초과하지\s*(?:않는다|마십시오|마세요)/);
      return m ? Number(m[1]) : (frequency ? frequency.max : null);
    })()
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
export const COMPARISON_STATUS = { WITHIN: 'within-reference', ABOVE: 'above-reference', BELOW: 'below-reference', INSUFFICIENT: 'insufficient-data', NOT_APPLICABLE: 'not-applicable', MULTIPLE_REGIMENS: 'multiple-regimens' };
export const COMPARISON_MESSAGE = {
  'within-reference': '허가사항에 기재된 1회 용량 범위에 해당합니다.',
  'above-reference': '허가사항에 기재된 일반적인 1회 용량 범위보다 높습니다. 처방 의료기관 또는 약사에게 확인하세요.',
  'below-reference': '허가사항에 기재된 일반적인 1회 용량 범위보다 낮습니다. 환자 상태나 처방 목적에 따라 달라질 수 있습니다.',
  'insufficient-data': '현재 정보만으로는 공식 용법·용량과 비교할 수 없습니다.',
  'not-applicable': '이 제품은 현재 자동 용량 비교를 지원하지 않습니다.',
  'multiple-regimens': '적응증·연령대별로 허가용량이 여러 가지인 제품입니다. 어느 기준이 적용되는지 자동으로 판단하지 않습니다 - 허가사항 전체를 확인하거나 의사·약사와 상의하세요.'
};
export function comparisonStatusFromPosition(position) {
  if (!position) return COMPARISON_STATUS.INSUFFICIENT;
  if (position.label === POSITION.ABOVE) return COMPARISON_STATUS.ABOVE;
  if (position.label === POSITION.BELOW) return COMPARISON_STATUS.BELOW;
  return COMPARISON_STATUS.WITHIN;
}

// --- Reference-range structuring (item J/K/M) --------------------------------------------------
// Every function here only converts a range that's already been extracted with confidence - none of
// them ever invent min/max, a concentration, or a strength. A missing input means null out, not a
// guess (item S).
// per-kg range -> absolute mg range using the patient's own weight (item J).
export function referenceMgRangeFromPerKg(rangePerKg, weightKg) {
  if (!rangePerKg || !(weightKg > 0)) return null;
  return { min: rangePerKg.min * weightKg, max: rangePerKg.max * weightKg };
}
// mg range -> mL range using the product's own official concentration (item K). Never derived from
// a product-name guess.
export function referenceMlRangeFromMg(mgRange, concentrationMgPerMl) {
  if (!mgRange || !(concentrationMgPerMl > 0)) return null;
  return { min: mgRange.min / concentrationMgPerMl, max: mgRange.max / concentrationMgPerMl };
}
// mg range -> a theoretical product-unit(정/캡슐) range using the official per-unit strength (item M).
// Reference-only: this never implies a tablet/capsule can or should actually be split.
export function referenceUnitRangeFromMg(mgRange, strengthMgPerUnit) {
  if (!mgRange || !(strengthMgPerUnit > 0)) return null;
  return { min: mgRange.min / strengthMgPerUnit, max: mgRange.max / strengthMgPerUnit };
}

// --- DUR(의약품안전사용서비스) 투여기간주의 원문 파싱 -------------------------------------------------
// DUR의 용량주의/투여기간주의는 e약은요·제품허가정보의 "공식 허가 용법·용량"과 전혀 다른 별도 출처다 -
// 이 파일의 다른 어떤 함수도 DUR 텍스트를 referenceMgRange/referenceMlRange 같은 일반 허가용량 범위로
// 바꾸지 않는다(절대 대체 금지). 이 함수는 오직 DUR 투여기간주의 원문(PROHBT_CONTENT/REMARK)에서 "N일"
// 상한을 뽑아내는 용도로만 쓰인다.
//
// 아주 단순하고 무조건적인 문장 패턴일 때만 숫자를 신뢰한다. 원문에 적응증/예외/조건을 나타내는 표현
// ("~에 한함", "다만", "제외" 등)이 하나라도 있으면 숫자를 절대 뽑지 않고 hasConditions만 true로 반환한다
// - 호출부는 이때 숫자 비교를 하지 않고 원문 그대로만 보여줘야 한다(단순 숫자 비교가 위험한 경우).
const DUR_PERIOD_CONDITION_HINT = /에\s*한함|제외|경우에는|다만|단[,\s]|만약|해당하는\s*경우|환자에서만/;
export function parseDurPeriodLimitDays(text) {
  const full = String(text || '');
  if (!full) return { maxDays: null, hasConditions: false };
  if (DUR_PERIOD_CONDITION_HINT.test(full)) return { maxDays: null, hasConditions: true };
  const stop = full.match(/(\d+)\s*일\s*(?:이상\s*)?(?:연속(?:으로)?\s*)?(?:투여|복용|사용)하지\s*(?:않는다|않습니다|마십시오|마세요)/);
  const within = full.match(/(\d+)\s*일\s*이내로?\s*(?:투여|복용|사용)/);
  const m = stop || within;
  return { maxDays: m ? Number(m[1]) : null, hasConditions: false };
}

// Pure computation core of "용량 분석 보기" (item 4-17 of the request): (처방 1회량 + 공식 성분/함량 +
// 공식 용법·용량 텍스트 + [선택] 체중 + [선택] 나이) -> per-ingredient mg, daily total, mg/kg, and a neutral
// comparison against the official range. Never a verdict (see the POSITION/COMPARISON_MESSAGE
// comments above). Kept DOM/network-free on purpose so it is fully unit-testable - app.js's
// computeDoseAnalysis() only gathers the inputs (official 함량/usage text, which need a fetch) and
// calls this.
export function analyzeDose({ ocr, kind, materials, usageText, patientWeightKg, patientAgeYears }) {
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
  // Patient age only ever comes from the signed-in user's profile birth_date, computed via
  // auth.ageYearsFromBirthDate (see public/auth.js) - never guessed from free text - so a single
  // unambiguous official minimum age can be compared safely. Multiple age bands stay an ambiguity guard only:
  // parseOfficialDosage captures just the first band's dose range, so there is no per-band data to
  // pick between even when the patient's age is known - never silently guess which band applies.
  if (official.ageMin != null) {
    if (patientAgeYears == null) guards.push('환자 연령 정보가 없어 허가사항의 연령 기준과 비교할 수 없습니다.');
    else if (official.ageBandCount <= 1) {
      const ageInOfficialUnit = official.ageUnit === 'month' ? patientAgeYears * 12 : patientAgeYears;
      if (ageInOfficialUnit < official.ageMin) {
        guards.push(`환자 연령이 허가사항에 명시된 대상 연령(만 ${official.ageMin}${official.ageUnit === 'month' ? '개월' : '세'} 이상)보다 어립니다. 허가사항을 확인하거나 의사·약사와 상의하세요.`);
      }
    }
  }
  if (official.ageBandCount > 1) guards.push('연령대별로 허가용량이 다른 제품입니다 - 처방전 인식만으로는 어느 연령대 기준인지 자동으로 판단하지 않습니다. 허가사항 전체를 직접 확인해주세요.');
  if (/신[ \t]*기능|간[ \t]*기능|투석|신부전|간부전/.test(usageText || '')) guards.push('신기능·간기능 등에 따라 용량 조절이 필요할 수 있는 약입니다. 해당 사항이 있다면 의사·약사와 상의해주세요.');
  if (multiIngredient && perIngredient.some(p => p.status === 'insufficient')) guards.push('복합제 성분 중 일부는 용량을 계산하지 못했습니다.');

  // 적응증/연령대가 여러 개면(item N) 어느 기준이 맞는지 자동으로 고를 수 없으므로 within/above/below
  // 판정 자체를 하지 않는다 - comparisonStatus가 'multiple-regimens'로만 표시되고 position은 null.
  const multipleRegimens = official.ageBandCount > 1;
  // Comparison priority: weight-based mg/kg > weight-based mL/kg > plain absolute mg > plain
  // tablet-count range > plain single mL (only when there's exactly one age band).
  const comparisons = perIngredient.filter(p => p.status === 'ok').map(p => {
    let range = null, actual = null, unit = '';
    if (patientWeightKg && official.singleDoseMgPerKg && Number.isFinite(p.mgPerKgDose)) { range = official.singleDoseMgPerKg; actual = p.mgPerKgDose; unit = 'mg/kg/회'; }
    else if (patientWeightKg && kind === 'liquid' && official.singleDoseMlPerKg && Number.isFinite(patientWeightKg)) { range = official.singleDoseMlPerKg; actual = round1(ocr.doseAmount / patientWeightKg); unit = 'mL/kg/회'; }
    else if (official.singleDoseMg && Number.isFinite(p.doseMg)) { range = official.singleDoseMg; actual = round1(p.doseMg); unit = 'mg/회'; }
    else if (kind === 'pill' && official.singleDoseTablets && Number.isFinite(ocr.doseAmount)) { range = official.singleDoseTablets; actual = ocr.doseAmount; unit = '정/회'; }
    else if (kind === 'liquid' && official.singleDoseMl && official.ageBandCount <= 1 && Number.isFinite(ocr.doseAmount)) { range = official.singleDoseMl; actual = ocr.doseAmount; unit = 'mL/회'; }
    const position = !multipleRegimens && range ? positionInRange(actual, range.min, range.max) : null;
    // insufficient-data (not not-applicable) whenever this ingredient in principle COULD be compared
    // but a specific condition is missing (no weight, ambiguous age band, ...) - not-applicable is
    // reserved for products this feature does not attempt to compare at all (see item 12).
    const comparisonStatus = multipleRegimens ? COMPARISON_STATUS.MULTIPLE_REGIMENS : comparisonStatusFromPosition(position);

    // item J/K/M: absolute mg/mL/unit reference ranges - derived whenever the inputs allow it,
    // independent of which basis above actually matched this comparison. Never a verdict, just
    // additional numbers the person can read alongside the range/position above.
    const referenceMgRange = official.singleDoseMg || referenceMgRangeFromPerKg(official.singleDoseMgPerKg, patientWeightKg);
    const concentrationMgPerMl = kind === 'liquid' ? concByMl.get(p.name) : null;
    const referenceMlRange = kind === 'liquid' ? referenceMlRangeFromMg(referenceMgRange, concentrationMgPerMl) : null;
    const strengthMgPerUnit = kind !== 'liquid' ? rawIngredients.find(i => i.name === p.name)?.amountMg ?? null : null;
    const referenceUnitRange = kind !== 'liquid' ? referenceUnitRangeFromMg(referenceMgRange, strengthMgPerUnit) : null;
    // item L: a plain magnitude, never phrased as "더 먹어도 됨"/"늘려도 됩니다" - the caller must not
    // add that wording either (see dose-calc.js's own POSITION/COMPARISON_MESSAGE comments).
    const gapToReferenceMaxMg = referenceMgRange && Number.isFinite(p.doseMg) ? round1(Math.abs(referenceMgRange.max - p.doseMg)) : null;
    const gapToReferenceMaxMl = referenceMlRange && Number.isFinite(ocr.doseAmount) ? round1(Math.abs(referenceMlRange.max - ocr.doseAmount)) : null;

    // item P: 허가사항 기준 1일 상한 - mg/day가 직접 명시되었거나 mg/kg/day를 체중으로 환산.
    const dailyReferenceMaxMg = official.dailyMaxMg ?? (official.dailyMaxMgPerKg != null && patientWeightKg ? official.dailyMaxMgPerKg * patientWeightKg : null);
    const dailyReferenceMaxMl = kind === 'liquid'
      ? (official.dailyMaxMl ?? (dailyReferenceMaxMg != null && concentrationMgPerMl > 0 ? round1(dailyReferenceMaxMg / concentrationMgPerMl) : null))
      : null;

    return {
      name: p.name, ...p, range, actual, unit, position, comparisonStatus, comparisonMessage: COMPARISON_MESSAGE[comparisonStatus],
      referenceMgRange, referenceMlRange, referenceUnitRange, gapToReferenceMaxMg, gapToReferenceMaxMl,
      dailyReferenceMaxMg: Number.isFinite(dailyReferenceMaxMg) ? round1(dailyReferenceMaxMg) : null, dailyReferenceMaxMl
    };
  });
  const anyComparable = comparisons.some(c => c.position);
  const status = multipleRegimens ? (perIngredient.some(p => p.status === 'ok') ? 'partial' : 'insufficient')
    : anyComparable ? 'ok' : (perIngredient.some(p => p.status === 'ok') ? 'partial' : 'insufficient');
  if (status !== 'ok' && !guards.length) guards.push('정확한 용량 비교를 위해 추가 정보가 필요합니다.');
  return {
    status, ocr, perIngredient, comparisons, official, usageText, guards,
    sourceLabel: 'e약은요 · 식품의약품안전처', sourceUrl: 'https://www.data.go.kr/data/15075057/openapi.do'
  };
}
