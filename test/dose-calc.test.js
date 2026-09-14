import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  round1, formatMg, parseTabletFraction, parseIngredients, tabletStrengthMg, concentrationsPerMl,
  doseFromTablet, doseFromSyrup, dailyTotal, perKg, parseOcrDoseNear, parseOfficialDosage,
  positionInRange, POSITION, analyzeDose, comparisonStatusFromPosition, COMPARISON_STATUS,
  referenceMgRangeFromPerKg, referenceMlRangeFromMg, referenceUnitRangeFromMg
} from '../public/dose-calc.js';

test('round1/formatMg: 반올림하고 정확히 떨어지는 값에는 "약" 접두어를 붙이지 않는다', () => {
  assert.equal(round1(216.6775), 216.7);
  assert.equal(round1(650.0325), 650);
  assert.equal(formatMg(216.6775), '약 216.7 mg');
  assert.equal(formatMg(650.0325), '약 650 mg');
  assert.equal(formatMg(250), '250 mg');
  assert.equal(formatMg(NaN), null);
});

test('parseTabletFraction: 0.5T/0.6667정/1.5 T/반쪽 표기를 숫자로 변환한다', () => {
  assert.equal(parseTabletFraction('0.6667T'), 0.6667);
  assert.equal(parseTabletFraction('0.5정'), 0.5);
  assert.equal(parseTabletFraction('1.5 T'), 1.5);
  assert.equal(parseTabletFraction('1정'), 1);
  assert.equal(parseTabletFraction('1/2정'), 0.5);
  assert.equal(parseTabletFraction('abc'), null);
});

// 실제 API 응답에서 그대로 가져온 materials 문자열 (타이레놀정500mg, 코미시럽, 맥시부펜시럽).
const TYLENOL_MATERIALS = '총량 : 1정615.04밀리그램|성분명 : 아세트아미노펜|분량 : 500|단위 : 밀리그램|규격 : USP|성분정보 : |비고 :';
const KOMI_MATERIALS = '총량 : 이 약 100밀리리터 중-1.1 색소2처방|성분명 : 페닐레프린염산염|분량 : 100|단위 : 밀리그램|규격 : KP|성분정보 : |비고 : ;총량 : 이 약 100밀리리터 중-1.1 색소2처방|성분명 : 클로르페니라민말레산염|분량 : 40|단위 : 밀리그램|규격 : KP|성분정보 : |비고 : ;총량 : 이 약 100밀리리터 중-1.2 색소3처방|성분명 : 페닐레프린염산염|분량 : 100|단위 : 밀리그램|규격 : KP|성분정보 : |비고 :';
const MAXIBUFEN_MATERIALS = '총량 : 100밀리리터|성분명 : 덱시부프로펜|분량 : 1.2|단위 : 그램|규격 : KP|성분정보 : |비고 :';

test('parseIngredients: 파이프/세미콜론 구분 materials를 파싱하고, 같은 성분은 처음 등장한 그룹만 남긴다', () => {
  const tylenol = parseIngredients(TYLENOL_MATERIALS);
  assert.deepEqual(tylenol.map(i => [i.name, i.amountMg]), [['아세트아미노펜', 500]]);
  const komi = parseIngredients(KOMI_MATERIALS);
  assert.equal(komi.length, 2, '페닐레프린염산염이 두 그룹에 반복되지만 한 번만 남는다');
  assert.deepEqual(komi.map(i => [i.name, i.amountMg]), [['페닐레프린염산염', 100], ['클로르페니라민말레산염', 40]]);
  const maxi = parseIngredients(MAXIBUFEN_MATERIALS);
  assert.deepEqual(maxi.map(i => [i.name, i.amountMg]), [['덱시부프로펜', 1200]], '단위가 그램이면 mg로 환산한다');
});

test('tabletStrengthMg/concentrationsPerMl: 정제는 정당 mg, 시럽은 총량 문구의 부피로 나눈 mg/mL', () => {
  assert.equal(tabletStrengthMg(TYLENOL_MATERIALS), 500);
  const komiConc = concentrationsPerMl(KOMI_MATERIALS);
  assert.deepEqual(komiConc, [{ name: '페닐레프린염산염', mgPerMl: 1 }, { name: '클로르페니라민말레산염', mgPerMl: 0.4 }]);
  const maxiConc = concentrationsPerMl(MAXIBUFEN_MATERIALS);
  assert.equal(maxiConc[0].mgPerMl, 12, '1200mg / 100mL = 12mg/mL');
});

test('요청 예시 그대로: 세토펜정325mg 1회 0.6667정, 1일 3회', () => {
  const dose = doseFromTablet(325, 0.6667);
  assert.equal(formatMg(dose), '약 216.7 mg');
  const daily = dailyTotal(dose, 3);
  assert.equal(formatMg(daily), '약 650 mg');
});

test('요청 예시 그대로: ○○시럽 32mg/mL, 3.5mL/회 -> 112mg/회', () => {
  const dose = doseFromSyrup(32, 3.5);
  assert.equal(dose, 112);
  assert.equal(formatMg(dose), '112 mg');
});

test('체중 기준 mg/kg 계산: 130mg 1회, 체중 미상이면 null', () => {
  assert.equal(round1(perKg(130, 10.5)), 12.4);
  assert.equal(perKg(130, 0), null);
  assert.equal(perKg(130, undefined), null);
});

test('parseOcrDoseNear: 약명 뒤 근처 텍스트에서 1회량·1일횟수·투약일수를 찾는다', () => {
  const text = '세토펜정325mg 0.6667T 1일 3회 5일분\n타이레놀정500mg 1정 1일 2회';
  const idx1 = text.indexOf('세토펜정325mg');
  const d1 = parseOcrDoseNear(text, idx1);
  assert.equal(d1.frequencyPerDay, 3); assert.equal(d1.days, 5);
  const idx2 = text.indexOf('타이레놀정500mg');
  const d2 = parseOcrDoseNear(text, idx2);
  assert.equal(d2.doseAmount, 1); assert.equal(d2.doseUnit, 'tablet'); assert.equal(d2.frequencyPerDay, 2);
});

// 실제 e약은요 usage 텍스트 3종 그대로 (타이레놀정500mg / 맥시부펜시럽 / 코미시럽).
const TYLENOL_USAGE = '만 12세 이상 소아 및 성인은 1회 1~2정씩, 1일 3~4회(4~6시간 마다) 필요시 복용합니다.\n\n이 약은 가능한 최단기간동안 최소 유효용량으로 복용하며, 1일 최대 8정(4 g)을 초과하여 복용하지 않습니다.';
const MAXIBUFEN_USAGE = '생후 6개월 이상의 소아는 1회 0.4~0.6 mL/kg(5~7 mg/kg), 4~6시간 간격으로 필요시에 복용하며, 1일 최대 4회(28 mg/kg)를 넘지 않습니다.\n\n몸무게를 알 경우 몸무게에 따른 용량으로 복용하는 것이 더 적절하므로 연령대별 권장용량은 허가사항을 참고하십시오.';
const KOMI_USAGE = '만 12세 이상 소아 및 성인은 4시간마다 10 mL씩 복용하되, 24시간동안 60 mL를 초과하지 마십시오.\n\n만 6세 이상~12세 미만 소아는 4시간마다 5 mL씩 복용하되, 24시간동안 30 mL를 초과하지 마십시오.\n\n만 2세 이상~6세 미만 소아는 의사의 지시에 따르십시오.';

test('parseOfficialDosage: 타이레놀정500mg 실제 사용법 - 정 개수 범위·횟수·간격·1일 최대', () => {
  const d = parseOfficialDosage(TYLENOL_USAGE);
  assert.equal(d.confidence, 'ok');
  assert.equal(d.ageMin, 12); assert.equal(d.ageUnit, 'year');
  assert.deepEqual(d.singleDoseTablets, { min: 1, max: 2 });
  assert.deepEqual(d.frequency, { min: 3, max: 4 });
  assert.deepEqual(d.intervalHours, { min: 4, max: 6 });
  assert.equal(d.dailyMaxTablets, 8);
});

test('parseOfficialDosage: 맥시부펜시럽 실제 사용법 - mg/kg·mL/kg 범위와 1일 최대(mg/kg)', () => {
  const d = parseOfficialDosage(MAXIBUFEN_USAGE);
  assert.equal(d.confidence, 'ok');
  assert.equal(d.ageMin, 6); assert.equal(d.ageUnit, 'month');
  assert.deepEqual(d.singleDoseMgPerKg, { min: 5, max: 7 });
  assert.deepEqual(d.singleDoseMlPerKg, { min: 0.4, max: 0.6 });
  assert.deepEqual(d.intervalHours, { min: 4, max: 6 });
  assert.equal(d.dailyMaxMgPerKg, 28);
});

test('parseOfficialDosage: 코미시럽처럼 연령대별로 문단이 나뉘면 ageBandCount>1로 표시한다', () => {
  const d = parseOfficialDosage(KOMI_USAGE);
  assert.equal(d.confidence, 'ok');
  assert.ok(d.ageBandCount >= 2, '만 12세 이상/만 6세 이상~12세 미만 등 여러 연령대 문단이 있음을 인식');
  assert.deepEqual(d.singleDoseMl, { min: 10, max: 10 }, '첫 번째(가장 먼저 매치되는) 연령대의 mL 값');
});

test('parseOfficialDosage: 매칭되는 패턴이 전혀 없으면 confidence는 insufficient', () => {
  const d = parseOfficialDosage('의사의 지시에 따라 투여한다.');
  assert.equal(d.confidence, 'insufficient');
  assert.equal(d.singleDoseTablets, null); assert.equal(d.singleDoseMgPerKg, null);
});

test('positionInRange: 5개의 중립적 라벨만 사용하고 "적정/과량" 같은 단정 표현은 없다', () => {
  assert.equal(positionInRange(8, 10, 15).label, POSITION.BELOW);
  assert.equal(positionInRange(10.5, 10, 15).label, POSITION.LOW_IN_RANGE);
  assert.equal(positionInRange(12.4, 10, 15).label, POSITION.IN_RANGE);
  assert.equal(positionInRange(14.6, 10, 15).label, POSITION.HIGH_IN_RANGE);
  assert.equal(positionInRange(20, 10, 15).label, POSITION.ABOVE);
  const mid = positionInRange(12.5, 10, 15);
  assert.equal(mid.fraction, 0.5);
  for (const label of Object.values(POSITION)) {
    assert.ok(!/적정|부적정|과량|안전|위험|정상/.test(label), `금지된 단정 표현 없음: ${label}`);
  }
  assert.equal(positionInRange(NaN, 10, 15), null);
  assert.equal(positionInRange(5, 10, 10), null, 'min===max인 잘못된 범위는 null');
});

test('요청 예시 그대로: 112mg 1회 / 체중 10kg -> 11.2mg/kg/회', () => {
  assert.equal(round1(perKg(112, 10)), 11.2);
});

test('요청 예시 그대로: 112mg × 1일 3회 -> 336mg/day', () => {
  assert.equal(dailyTotal(112, 3), 336);
});

test('농도(mg/mL) 정보가 없는 성분은 mg 값을 추측하지 않고 null을 반환한다', () => {
  // "총량" 세그먼트에 mL 부피가 없는 materials - concentrationsPerMl은 제품명/문자열에서 농도를 추측하지 않는다.
  const noVolume = '총량 : 이 약 중|성분명 : 시험성분|분량 : 50|단위 : 밀리그램|규격 : KP|성분정보 : |비고 :';
  const conc = concentrationsPerMl(noVolume);
  assert.equal(conc[0].mgPerMl, null);
  assert.equal(doseFromSyrup(conc[0].mgPerMl, 5), null, '농도를 모르면 mg 계산도 하지 않는다');
});

test('analyzeDose: 다성분제(코미시럽)는 총 mg으로 합치지 않고 성분별로 각각 계산한다', () => {
  const result = analyzeDose({ ocr: { doseAmount: 10, doseUnit: 'mL', frequencyPerDay: 3, days: 5 }, kind: 'liquid', materials: KOMI_MATERIALS, usageText: KOMI_USAGE });
  assert.equal(result.perIngredient.length, 2, '성분별로 항목이 분리되어 있다');
  const byName = Object.fromEntries(result.perIngredient.map(p => [p.name, p]));
  assert.equal(byName['페닐레프린염산염'].doseMg, 10, '1mg/mL × 10mL = 10mg');
  assert.equal(byName['클로르페니라민말레산염'].doseMg, 4, '0.4mg/mL × 10mL = 4mg');
  assert.ok(result.guards.some(g => g.includes('복합제')));
  assert.ok(!('doseMg' in result), '성분을 합친 총 mg 필드는 존재하지 않는다');
});

test('analyzeDose: 공식 허가사항을 구조화해서 비교할 수 없으면 insufficient-data이지 단정적 판정이 아니다', () => {
  const result = analyzeDose({ ocr: { doseAmount: 0.6667, doseUnit: 'tablet', frequencyPerDay: 3, days: 5 }, kind: 'pill', materials: TYLENOL_MATERIALS, usageText: '의사의 지시에 따라 투여한다.' });
  assert.equal(result.official.confidence, 'insufficient');
  assert.equal(result.comparisons[0].comparisonStatus, COMPARISON_STATUS.INSUFFICIENT);
  assert.equal(comparisonStatusFromPosition(null), COMPARISON_STATUS.INSUFFICIENT);
  assert.ok(!/적정|부적정|처방\s*오류|과량\s*처방/.test(result.comparisons[0].comparisonMessage));
});

test('analyzeDose: 환자 나이가 없으면 연령 기준 비교를 생략한다는 안내만 하고, 있으면 허가 최소연령과 비교한다', () => {
  const base = { ocr: { doseAmount: 1, doseUnit: 'tablet', frequencyPerDay: 3, days: 5 }, kind: 'pill', materials: TYLENOL_MATERIALS, usageText: TYLENOL_USAGE };
  const withoutAge = analyzeDose(base);
  assert.ok(withoutAge.guards.some(g => g.includes('환자 연령 정보가 없어')));

  const tooYoung = analyzeDose({ ...base, patientAgeYears: 8 });
  assert.ok(tooYoung.guards.some(g => g.includes('허가사항에 명시된 대상 연령(만 12세 이상)보다 어립니다')));
  assert.ok(!/적정|부적정|처방\s*오류/.test(tooYoung.guards.join(' ')), '단정적 표현 없이 참고 안내만 한다');

  const oldEnough = analyzeDose({ ...base, patientAgeYears: 20 });
  assert.ok(!oldEnough.guards.some(g => g.includes('보다 어립니다')));
});

test('analyzeDose: 연령대가 여러 개로 나뉜 제품은 나이를 알아도 자동으로 특정 연령대를 판정하지 않는다', () => {
  const result = analyzeDose({ ocr: { doseAmount: 10, doseUnit: 'mL', frequencyPerDay: 3, days: 5 }, kind: 'liquid', materials: KOMI_MATERIALS, usageText: KOMI_USAGE, patientAgeYears: 8 });
  assert.ok(result.guards.some(g => g.includes('연령대별로 허가용량이 다른 제품')));
  assert.ok(!result.guards.some(g => g.includes('보다 어립니다')), '연령대가 여러 개면 나이만으로 자동 판정하지 않는다');
});

test('analyzeDose: 개월 단위 허가 최소연령(생후 6개월)도 나이(년)를 개월로 환산해 비교한다', () => {
  const base = { ocr: { doseAmount: 5, doseUnit: 'mL', frequencyPerDay: 3, days: 5 }, kind: 'liquid', materials: MAXIBUFEN_MATERIALS, usageText: MAXIBUFEN_USAGE };
  const infant = analyzeDose({ ...base, patientAgeYears: 0 });
  assert.ok(infant.guards.some(g => g.includes('만 6개월 이상')));
  const toddler = analyzeDose({ ...base, patientAgeYears: 2 });
  assert.ok(!toddler.guards.some(g => g.includes('보다 어립니다')));
});

// --- 요청 F/J/K/L/M/N/O/P/V: 공식 허가 mg/kg 구조화, 절대 mg/mL/unit 환산, 1일 상한, 다중 regimen ----
// 세토펜현탁액 시나리오 그대로: 32mg/mL, 3.5mL/회, 체중 10kg, 공식 1회 10~15mg/kg, 1일 최대 4회(60mg/kg).
const CETOPEN_MATERIALS = '총량 : 이 약 100밀리리터 중|성분명 : 아세트아미노펜|분량 : 3200|단위 : 밀리그램|규격 : KP|성분정보 : |비고 :';
const CETOPEN_USAGE = '1회 10~15mg/kg를 4~6시간 간격으로 필요시 투여하며, 1일 최대 4회(60 mg/kg)를 넘지 않습니다.';
const CETOPEN_BASE = { ocr: { doseAmount: 3.5, doseUnit: 'mL', frequencyPerDay: 3, days: 5 }, kind: 'liquid', materials: CETOPEN_MATERIALS, usageText: CETOPEN_USAGE, patientWeightKg: 10 };

test('referenceMgRangeFromPerKg: 10~15mg/kg × 10kg = 100~150mg/회 (요청 J/V-7)', () => {
  assert.deepEqual(referenceMgRangeFromPerKg({ min: 10, max: 15 }, 10), { min: 100, max: 150 });
  assert.equal(referenceMgRangeFromPerKg(null, 10), null);
  assert.equal(referenceMgRangeFromPerKg({ min: 10, max: 15 }, null), null, '체중이 없으면 환산하지 않는다 (요청 S/V-11)');
});

test('referenceMlRangeFromMg: 100/32≈3.1mL, 150/32≈4.7mL (요청 K/V-8/V-9), 농도 없으면 null (V-12)', () => {
  const mlRange = referenceMlRangeFromMg({ min: 100, max: 150 }, 32);
  assert.equal(round1(mlRange.min), 3.1);
  assert.equal(round1(mlRange.max), 4.7);
  assert.equal(referenceMlRangeFromMg({ min: 100, max: 150 }, null), null, '농도 정보가 없으면 mL 범위를 만들지 않는다');
});

test('referenceUnitRangeFromMg: 정제 성분함량으로 이론적 정 수 범위를 참고값으로만 계산한다 (요청 M)', () => {
  const unitRange = referenceUnitRangeFromMg({ min: 250, max: 500 }, 325);
  assert.equal(round1(unitRange.min), 0.8);
  assert.equal(round1(unitRange.max), 1.5);
  assert.equal(referenceUnitRangeFromMg({ min: 250, max: 500 }, null), null);
});

test('analyzeDose: 세토펜현탁액 - 현재 11.2mg/kg는 within-reference이고, 절대 mg/mL 범위·1일 상한·현재-상한 차이가 함께 계산된다 (요청 I/J/K/L/O/P/V-10)', () => {
  const result = analyzeDose(CETOPEN_BASE);
  const c = result.comparisons[0];
  assert.equal(c.doseMg, 112, '32mg/mL × 3.5mL = 112mg');
  assert.equal(round1(c.mgPerKgDose), 11.2, '112mg / 10kg = 11.2mg/kg/회');
  assert.equal(c.comparisonStatus, COMPARISON_STATUS.WITHIN);
  assert.equal(c.comparisonMessage, '허가사항에 기재된 1회 용량 범위에 해당합니다.');
  assert.deepEqual(c.referenceMgRange, { min: 100, max: 150 }, '체중 10kg 기준 허가사항 1회 범위');
  assert.equal(round1(c.referenceMlRange.min), 3.1);
  assert.equal(round1(c.referenceMlRange.max), 4.7);
  assert.equal(c.gapToReferenceMaxMg, 38, '허가상한 150mg과 현재 112mg의 차이 (권고 표현이 아니라 단순 수치)');
  assert.equal(round1(c.gapToReferenceMaxMl), 1.2, '허가상한 약 4.7mL와 현재 3.5mL의 차이');
  assert.equal(c.dailyMg, 336, '112mg × 1일 3회');
  assert.equal(round1(c.mgPerKgDay), 33.6, '336mg / 10kg = 33.6mg/kg/day (요청 V-6)');
  assert.equal(c.dailyReferenceMaxMg, 600, '60mg/kg × 10kg = 600mg/day (요청 P)');
  assert.equal(c.dailyReferenceMaxMl, 18.8, '600mg / 32mg/mL ≈ 18.75mL/day, round1로 18.8');
  assert.ok(!/더\s*먹어도|더\s*복용\s*가능|늘려도\s*됩니다|까지\s*드세요/.test(JSON.stringify(result)), '허용 금지 표현이 어디에도 없어야 한다');
});

test('analyzeDose: 체중이 없으면 mg/kg 비교·절대 mg 환산 모두 생략된다 (요청 S/V-11)', () => {
  const result = analyzeDose({ ...CETOPEN_BASE, patientWeightKg: null });
  const c = result.comparisons[0];
  assert.equal(c.mgPerKgDose, null);
  assert.equal(c.referenceMgRange, null);
  assert.equal(c.referenceMlRange, null);
  assert.equal(c.comparisonStatus, COMPARISON_STATUS.INSUFFICIENT);
});

test('analyzeDose: 연령대별로 용량이 다른 제품(multiple regimens)은 within/above/below 판정을 하지 않는다 (요청 N/V-14)', () => {
  const multiAgeUsage = '만 12세 이상 소아 및 성인은 1회 10~15mg/kg를 투여합니다.\n\n만 6세 이상~12세 미만 소아는 의사의 지시에 따르십시오.';
  const result = analyzeDose({ ...CETOPEN_BASE, usageText: multiAgeUsage });
  const c = result.comparisons[0];
  assert.equal(c.comparisonStatus, COMPARISON_STATUS.MULTIPLE_REGIMENS);
  assert.equal(c.position, null, '여러 regimen이면 단순 상한/하한 위치 판정을 만들지 않는다');
  assert.ok(!/적정|부적정|과량/.test(c.comparisonMessage));
});

test('요청 F: 자연어 단순 패턴만 신뢰 가능하게 구조화하고, 복잡한 문장은 억지로 숫자 하나로 만들지 않는다', () => {
  const single = parseOfficialDosage('성인은 1회 300mg을 1일 2~3회 경구투여한다.');
  assert.deepEqual(single.singleDoseMg, { min: 300, max: 300 });
  assert.deepEqual(single.frequency, { min: 2, max: 3 });

  const rangeMg = parseOfficialDosage('1회 250~500mg씩 복용합니다.');
  assert.deepEqual(rangeMg.singleDoseMg, { min: 250, max: 500 });

  // "mg/kg" 문장은 절대-mg 패턴으로 잘못 이중 매치되지 않는다.
  const perKgText = parseOfficialDosage('1회 10~15mg/kg를 투여합니다.');
  assert.equal(perKgText.singleDoseMg, null, 'mg/kg 패턴이 절대 mg 패턴으로 오매칭되지 않는다');
  assert.deepEqual(perKgText.singleDoseMgPerKg, { min: 10, max: 15 });

  const capped = parseOfficialDosage('1일 4회를 초과하지 않는다.');
  assert.equal(capped.maxFrequencyPerDay, 4);
});
