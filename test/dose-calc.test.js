import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  round1, formatMg, parseTabletFraction, parseIngredients, tabletStrengthMg, concentrationsPerMl,
  doseFromTablet, doseFromSyrup, dailyTotal, perKg, parseOcrDoseNear, parseOfficialDosage,
  positionInRange, POSITION
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
