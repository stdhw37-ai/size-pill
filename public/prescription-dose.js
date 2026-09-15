// Prescription-only daily comparison. No change to the search/liquid dose summaries.
import { parseIngredients, concentrationsPerMl } from './dose-calc.js';
const positive = n => Number.isFinite(n) && n > 0;
const range = (a, b = a) => ({ min: Number(a), max: Number(b) });
const validRange = r => r && positive(r.min) && positive(r.max) && r.max >= r.min;
const multiply = (r, n) => ({ min: r.min * n, max: r.max * n });
const normalize = s => String(s || '').normalize('NFKC').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/밀리그램/g, 'mg').replace(/밀리리터/g, 'mL').replace(/[∼～–−]/g, '~');
const NUMBER = '(\\d+(?:\\.\\d+)?)';
const RANGE = NUMBER + '(?:\\s*[~-]\\s*' + NUMBER + ')?';

// Select an explicit patient branch before extracting amounts. Unknown age never implies adult.
export function parseDailyRegimen(usageText, { ageYears, weightKg } = {}) {
  const text = normalize(usageText).trim();
  const unavailable = reason => ({ status: text ? 'unstructured' : 'missing', reason, original: text });
  if (!text) return unavailable('공식 용법·용량 정보가 없습니다.');
  const headings = [...text.matchAll(/성인(?:은|의\s*경우)?\s*[:：]?|소아(?:는|의\s*경우)?\s*[:：]?|어린이(?:는)?\s*[:：]?/g)];
  let selected = text, population = '공식 문구';
  if (headings.length) {
    const adult = headings.filter(h => h[0].startsWith('성인'));
    if (!Number.isFinite(ageYears) || ageYears < 19 || adult.length !== 1) return unavailable('환자 연령에 맞는 용법을 자동으로 선택하기 어렵습니다.');
    const index = headings.indexOf(adult[0]), end = headings[index + 1]?.index ?? text.length;
    selected = text.slice(adult[0].index + adult[0][0].length, end); population = '성인';
  }
  // A numeric age boundary is supported only when it is the sole, explicit lower boundary.
  const ages = [...selected.matchAll(/(?:만\s*)?(\d+)\s*세\s*(이상|미만|이하|초과)/g)];
  if (ages.length) {
    if (ages.length !== 1 || ages[0][2] !== '이상' || !Number.isFinite(ageYears) || ageYears < Number(ages[0][1])) return unavailable('연령대별 용법을 확인해주세요.');
    population = `${ages[0][1]}세 이상`;
  }
  if (/개월|\d+\s*[~-]\s*\d+\s*세/.test(selected)) return unavailable('연령대별 용법을 확인해주세요.');
  // Dose and frequency must belong to ONE regimen. Duration-only sentences are preserved in the
  // original, but never counted as dose/frequency numbers (e.g. erdosteine's acute 10-day limit).
  if (/초기|유지|필요\s*시|필요한\s*경우|최대|최고|증감|증량|감량|격일|매주|적응증|고령|노인|또는|혹은|시간\s*(?:마다|간격)/.test(selected)) return unavailable('조건별 또는 필요시 용량은 자동 비교하지 않습니다.');
  const paragraphs = selected.split(/\n\s*\n|(?<=[다요])\.[ \n]+/).filter(p => /1\s*회|1\s*일.*(?:mg|mL|캡슐|정)|mg\s*\/\s*kg/.test(p));
  if (paragraphs.length !== 1) return unavailable('여러 용법 중 적용할 기준을 자동으로 선택하기 어렵습니다.');
  const clause = paragraphs[0];
  if (/초기|유지|필요\s*시|필요한\s*경우|최대|최고|증감|증량|감량|격일|매주|신기능|간기능|신부전|간부전|투석|적응증|경우|질환|환자|(?:^|\n)\s*\d+[.)]/.test(clause)) return unavailable('조건별 또는 필요시 용량은 자동 비교하지 않습니다.');
  const frequencies = [...clause.matchAll(new RegExp('(?<!\\d)1\\s*일\\s*' + RANGE + '\\s*회', 'g'))];
  const doses = [...clause.matchAll(/(?<!\d)1\s*회/g)].filter(d => !frequencies.some(f => d.index >= f.index && d.index < f.index + f[0].length));
  if (doses.length !== 1 || frequencies.length !== 1) return unavailable('1회량과 하루 횟수를 한 가지 기준으로 읽기 어렵습니다.');
  const frequency = range(frequencies[0][1], frequencies[0][2] ?? frequencies[0][1]);
  if (!validRange(frequency) || !Number.isInteger(frequency.min) || !Number.isInteger(frequency.max) || frequency.max > 24) return unavailable('복용 횟수를 확인해주세요.');
  const doseText = clause.slice(doses[0].index).split(/1\s*일/)[0];
  // Supported grammar: "1회 [성분명으로서] 300mg", "1회 1캡슐(300mg)", "1회 5~10mg/kg".
  const namedPrefix = '(?:[가-힣A-Za-z]+(?:으로서|로서)\\s*)?';
  const unitPair = doseText.match(new RegExp('^1\\s*회\\s*' + namedPrefix + NUMBER + '\\s*(정|캡슐)\\s*\\(\\s*' + RANGE + '\\s*(mg|g)\\s*\\)'));
  const plain = doseText.match(new RegExp('^1\\s*회\\s*' + namedPrefix + RANGE + '\\s*(mg|g|mL|정|캡슐)(\\s*\\/\\s*kg)?', 'i'));
  let perDose, unit, perUnitMg = null;
  if (unitPair) {
    perDose = multiply(range(unitPair[3], unitPair[4] ?? unitPair[3]), unitPair[5] === 'g' ? 1000 : 1); unit = 'mg';
    if (perDose.min === perDose.max && positive(Number(unitPair[1]))) perUnitMg = { unit: unitPair[2], mg: perDose.min / Number(unitPair[1]) };
  } else if (plain) {
    perDose = range(plain[1], plain[2] ?? plain[1]); unit = plain[3].toLowerCase();
    if (unit === 'g') { perDose = multiply(perDose, 1000); unit = 'mg'; }
    if (unit === 'ml') unit = 'mL';
    if (plain[4]) {
      if (!['mg', 'mL'].includes(unit) || !positive(weightKg)) return unavailable('체중 기준 비교에 필요한 정보가 없습니다.');
      perDose = multiply(perDose, weightKg); population += ` · ${weightKg}kg`;
    }
  }
  if (!validRange(perDose)) return unavailable('1회 용량을 자동으로 구조화하기 어렵습니다.');
  // Reject an extra dose elsewhere in the same paragraph, including ranges under a second heading.
  const remainder = doseText.replace(unitPair?.[0] || plain?.[0] || '', '');
  if (/^\s*[\/a-zA-Z0-9]/.test(remainder)) return unavailable('지원하지 않는 용량 단위입니다.');
  if (/\d+(?:\.\d+)?\s*(?:mg|mL|캡슐|정)|[:：]/i.test(remainder)) return unavailable('용량 기준이 여러 개여서 자동 비교하지 않습니다.');
  return { status: 'structured', original: text, evidence: clause.trim(), population, perDose, frequency, unit, perUnitMg };
}

export function dailyRangePosition(current, min, max) {
  if (![current, min, max].every(Number.isFinite) || min <= 0 || max < min) return null;
  const status = current < min ? 'below' : current > max ? 'above' : 'within';
  const fraction = max === min ? null : (current - min) / (max - min);
  const domainMin = Math.min(min, current), domainMax = Math.max(max, current);
  const span = domainMax - domainMin;
  return { status, fraction, markerPercent: span ? (current - domainMin) / span * 100 : 50,
    rangeStartPercent: span ? (min - domainMin) / span * 100 : 50,
    rangeEndPercent: span ? (max - domainMin) / span * 100 : 50 };
}

export function analyzePrescriptionDaily({ item, row, ageYears, weightKg, kind }) {
  const usage = item?.easy?.data?.usage || '';
  const official = parseDailyRegimen(usage, { ageYears, weightKg });
  const materials = item?.permit?.data?.materials || '';
  const ingredients = parseIngredients(materials);
  const unit = row?.doseUnit;
  let amount = row?.dosePerAdministration;
  const frequency = row?.frequencyPerDay;
  let prescribedUnit = unit, packagingEvidence = '';
  if (kind === 'liquid' && unit === '포') {
    const packaging = item?.permit?.data?.packaging || '';
    const matches = [...packaging.matchAll(/(\d+(?:\.\d+)?)\s*mL\s*\/\s*포/gi)].map(m => Number(m[1]));
    const unique = [...new Set(matches)];
    if (unique.length === 1 && positive(unique[0])) { amount *= unique[0]; prescribedUnit = 'mL'; packagingEvidence = `1포 = ${unique[0]}mL`; }
  }
  const validInput = positive(amount) && positive(frequency) && Number.isInteger(frequency);
  const concentrations = concentrationsPerMl(materials);
  let strengths = ingredients.map(i => {
    let mg = null;
    if (kind === 'liquid' && /^ml$/i.test(prescribedUnit)) mg = concentrations.find(c => c.name === i.name)?.mgPerMl;
    if (kind === 'pill' && /^(정|캡슐)$/.test(unit)) {
      const basis = i.totalText.match(/(\d+(?:\.\d+)?)\s*(정|캡슐)/);
      // Never assume a 100g or multi-tablet material amount means one tablet.
      if (basis && basis[2] === unit && positive(Number(basis[1]))) mg = i.amountMg / Number(basis[1]);
    }
    return { name: i.name, mgPerUnit: positive(mg) ? mg : null, source: '제품허가정보 · 원료성분' };
  });
  if (!strengths.length && (official.perUnitMg && official.perUnitMg.unit === unit)) strengths = [{ name: item?.permit?.data?.ingredients || item?.name?.match(/\(([^)]+)\)/)?.[1] || '유효성분', mgPerUnit: official.perUnitMg.mg, source: 'e약은요 · 1단위 함량 명시 문구' }];
  // A matching explicit unit/mg equivalence can fill a missing material basis, never override it.
  if (strengths.length === 1 && !strengths[0].mgPerUnit && (official.perUnitMg && official.perUnitMg.unit === unit)) strengths[0] = { ...strengths[0], mgPerUnit: official.perUnitMg.mg, source: 'e약은요 · 1단위 함량 명시 문구' };
  if (!strengths.length) strengths = [{ name: '유효성분', mgPerUnit: null }];
  const comparisons = strengths.map(s => {
    const current = validInput && positive(s.mgPerUnit) ? amount * s.mgPerUnit * frequency : null;
    let reference = null;
    // Combination ingredients are never summed or compared with an unattributed single mg range.
    if (official.status === 'structured' && strengths.length === 1 && current != null) {
      let factor = official.unit === 'mg' ? 1 : official.unit === prescribedUnit ? s.mgPerUnit : null;
      if (positive(factor)) reference = { min: official.perDose.min * factor * official.frequency.min, max: official.perDose.max * factor * official.frequency.max };
    }
    return { ...s, current, reference, position: reference ? dailyRangePosition(current, reference.min, reference.max) : null };
  });
  return { comparisons, official, original: usage, row, amount, prescribedUnit, packagingEvidence,
    reason: !validInput ? '1회량·단위·하루 횟수를 확인해주세요.' : comparisons.every(c => c.current == null) ? '제품 1단위 함량을 확인하지 못했습니다.' : strengths.length > 1 ? '복합제는 성분별 총량만 표시합니다. 공식 범위를 자동으로 대응하지 않습니다.' : official.reason,
    sourceLabel: '식품의약품안전처 e약은요 · 제품허가정보' };
}
