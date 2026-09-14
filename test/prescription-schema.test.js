import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampMedication, medicationSummary } from '../public/prescription-schema.js';

const HIGH = { productCode: .95, drugName: .95, dose: .95, frequency: .95, duration: .95 };

test('정상 값은 number로 그대로 통과하고 needsReview가 되지 않는다', () => {
  const med = clampMedication({
    productCode: '644913501', rawName: '듀파락-이지시럽/15mL/포', drugName: '듀파락-이지시럽',
    strengthOrPackage: '15mL/포', doseUnit: '포', dosePerAdministration: 1, frequencyPerDay: 3, durationDays: 10,
    confidence: HIGH
  });
  assert.equal(med.dosePerAdministration, 1); assert.equal(typeof med.dosePerAdministration, 'number');
  assert.equal(med.frequencyPerDay, 3); assert.equal(med.durationDays, 10);
  assert.equal(med.doseUnit, '포'); assert.equal(med.needsReview, false);
});

// The exact bug this architecture was built to stop: three columns ("1", "3", "10") merging into one
// implausible number instead of three real ones. This must never be shown to the user as-is.
test('비정상적으로 큰 숫자(예: 19110, 260)는 그대로 표시하지 않고 null + needsReview로 처리한다', () => {
  const med = clampMedication({
    drugName: '듀파락-이지시럽', dosePerAdministration: 19110, frequencyPerDay: 3, durationDays: 10, confidence: HIGH
  });
  assert.equal(med.dosePerAdministration, null, '19110 같은 값은 절대 그대로 노출하지 않는다');
  assert.equal(med.frequencyPerDay, 3, '다른 필드는 영향받지 않는다');
  assert.equal(med.needsReview, true);
  const med2 = clampMedication({ drugName: '에도스캡슐', dosePerAdministration: 1, frequencyPerDay: 260, durationDays: 60, confidence: HIGH });
  assert.equal(med2.frequencyPerDay, null);
  assert.equal(med2.dosePerAdministration, 1);
  assert.equal(med2.durationDays, 60);
  assert.equal(med2.needsReview, true);
});

test('의료적 판단이 아니라 데이터 품질 의심으로만 처리한다 - 0 이하·비수치도 동일하게 차단', () => {
  const med = clampMedication({ drugName: '테스트정', dosePerAdministration: 0, frequencyPerDay: -1, durationDays: 'abc', confidence: HIGH });
  assert.equal(med.dosePerAdministration, null);
  assert.equal(med.frequencyPerDay, null);
  assert.equal(med.durationDays, null);
  assert.equal(med.needsReview, true);
});

test('읽지 못한 값은 추측하지 않고 null로 남기며, 그 필드만 검토 대상이 된다', () => {
  const med = clampMedication({ drugName: '셀벡스캡슐(내복)', dosePerAdministration: 1, frequencyPerDay: 2, durationDays: null, confidence: { ...HIGH, duration: 0 } });
  assert.equal(med.durationDays, null);
  assert.equal(med.dosePerAdministration, 1); assert.equal(med.frequencyPerDay, 2);
  assert.equal(med.needsReview, true, '누락된 필드가 있으면 전체 행이 확인 대상으로 표시된다');
});

test('confidence는 0~1로 clamp되고, 비수치는 0으로 처리한다', () => {
  const med = clampMedication({ drugName: '테스트정', confidence: { productCode: 5, drugName: -3, dose: 'x', frequency: .5, duration: undefined } });
  assert.equal(med.confidence.productCode, 1);
  assert.equal(med.confidence.drugName, 0);
  assert.equal(med.confidence.dose, 0);
  assert.equal(med.confidence.frequency, .5);
  assert.equal(med.confidence.duration, 0);
});

test('drugName이 없으면 needsReview가 된다', () => {
  assert.equal(clampMedication({}).needsReview, true);
  assert.equal(clampMedication({ drugName: '' }).needsReview, true);
});

test('medicationSummary는 필드별로 독립적으로 표시하고, 하나가 없다고 전체를 ?로 만들지 않는다', () => {
  const full = clampMedication({ drugName: '듀파락-이지시럽', doseUnit: '포', dosePerAdministration: 1, frequencyPerDay: 3, durationDays: 10, confidence: HIGH });
  assert.equal(medicationSummary(full), '처방내용: 1포 × 하루 3회 × 10일');
  const partial = clampMedication({ drugName: '테스트정', dosePerAdministration: 1, frequencyPerDay: 3, durationDays: 19110, confidence: HIGH });
  assert.equal(medicationSummary(partial), '처방내용: 1 × 하루 3회 × ?일');
});

test('4개 처방 행 모두 정상 값이면 needsReview가 없다 (item 2의 목표 결과)', () => {
  const expected = [
    { productCode: '644913501', drugName: '듀파락-이지시럽', strengthOrPackage: '15mL/포', doseUnit: '포', dosePerAdministration: 1, frequencyPerDay: 3, durationDays: 10 },
    { productCode: '649401610', drugName: '에도스캡슐', strengthOrPackage: '1캡슐', doseUnit: '캡슐', dosePerAdministration: 1, frequencyPerDay: 2, durationDays: 60 },
    { productCode: '650202970', drugName: '애니코프캡슐300mg', strengthOrPackage: '1캡슐', doseUnit: '캡슐', dosePerAdministration: 1, frequencyPerDay: 2, durationDays: 60 },
    { productCode: '642204150', drugName: '셀벡스캡슐(내복)', strengthOrPackage: '1캡슐', doseUnit: '캡슐', dosePerAdministration: 1, frequencyPerDay: 2, durationDays: 60 }
  ];
  const meds = expected.map(raw => clampMedication({ ...raw, confidence: HIGH }));
  assert.deepEqual(meds.map(m => ({
    productCode: m.productCode, drugName: m.drugName, strengthOrPackage: m.strengthOrPackage, doseUnit: m.doseUnit,
    dosePerAdministration: m.dosePerAdministration, frequencyPerDay: m.frequencyPerDay, durationDays: m.durationDays
  })), expected);
  assert.ok(meds.every(m => !m.needsReview));
});
