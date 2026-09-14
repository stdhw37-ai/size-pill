import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/medicine-flow.js';
const { normalizeMedicineName: norm, matchOfficialMedicine: match, classifyMedicineForm: form, classifyLiquidPackaging: pack, getMedicineDestination: destination, officialDoseUnit: unit } = globalThis.MedicineFlow;
const syrup = { id: '1', name: '듀파락-이지시럽', insuranceCode: '644913501', form: '시럽제', permit: { data: { packaging: '15mL/포' } } };
const capsule = { id: '2', name: '에도스캡슐', insuranceCode: '649401610', form: '경질캡슐' };
test('A: exact EDI code → official match → liquid → liquid guide', () => {
  const result = match({ productCode: '644913501', drugName: '인식오류' }, [capsule, syrup]);
  assert.equal(result.status, 'exact-code'); assert.equal(result.selected.id, '1');
  assert.deepEqual(destination(result.selected), { medicineForm: 'liquid', liquidPackaging: 'pouch', screen: 'liquid', cta: '액체약 가이드 보기' });
});
test('B: 에도스캡슐 unique exact name → solid-oral → actual size CTA', () => {
  const result = match({ drugName: '에도스캡슐/1캡슐' }, [capsule]);
  assert.equal(result.status, 'exact-name'); assert.equal(destination(result.selected).cta, '실물크기 보기');
});
test('C: 300mg and 100mg never auto-match by name or fuzzy', () => {
  const a = { id: '3', name: '애니코프캡슐 300mg', form: '경질캡슐' }, b = { ...a, id: '4', name: '애니코프캡슐100mg' };
  assert.equal(match({ drugName: '애니코프캡슐300MG' }, [b, a]).selected.id, '3');
  assert.equal(match({ drugName: '애니코프캡슐300mg' }, [b]).selected, null);
  assert.notEqual(norm(a.name), norm(b.name));
});
test('D: 셀벡스캡슐(내복) accessory normalization preserves name/strength', () => {
  const m = { id: '5', name: '셀벡스캡슐', form: '경질캡슐' };
  assert.equal(match({ drugName: '셀벡스캡슐(내복)/1캡슐' }, [m]).selected.id, '5');
  assert.equal(form(m), 'solid-oral');
});
test('E: official solid dosageForm wins over syrup product name', () => {
  const m = { name: '시험시럽', dosageForm: '필름코팅정', description: '시럽처럼 보임' };
  assert.equal(form(m), 'solid-oral'); assert.equal(unit(m), '정');
});
test('F: liquid bottle never has a pill destination or pouch packaging', () => {
  const m = { ...syrup, permit: { data: { packaging: '100mL/병, 500mL/병' } } };
  assert.equal(pack(m), 'bottle'); assert.equal(destination(m).screen, 'liquid');
  assert.equal(unit(m, 'mL'), 'mL'); assert.equal(unit(m), null);
});
test('ambiguous manufacturers/duplicate matching codes never auto-select', () => {
  assert.equal(match({ drugName: capsule.name }, [capsule, { ...capsule, id: '7', company: '다른회사' }]).selected, null);
  assert.equal(match({ productCode: capsule.insuranceCode }, [capsule, { ...capsule, id: '7' }]).status, 'needs-confirmation');
});
test('incomplete/failed search cannot certify a unique exact-name candidate', () => {
  assert.equal(match({ drugName: capsule.name }, [capsule], { complete: false }).selected, null);
  assert.equal(match({ productCode: capsule.insuranceCode }, [capsule], { complete: false }).status, 'exact-code');
});
test('strong fuzzy is a confirmation candidate, never an automatic choice', () => {
  const m = { id: '8', name: '가상아주긴의약품이름캡슐300mg' };
  const r = match({ drugName: '가상아주긴의약품이름캡슬300mg' }, [m]);
  assert.equal(r.status, 'high-confidence'); assert.equal(r.selected, null);
});
test('item_seq is never treated as an insurance code; conflicting EDI blocks name auto-selection', () => {
  assert.equal(match({ productCode: '123456789', drugName: '다른약' }, [{ id: '123456789', name: capsule.name }]).selected, null);
  assert.equal(match({ productCode: '123456789', drugName: capsule.name }, [capsule]).selected, null);
});
test('normalization handles punctuation/case/package text without discarding strengths', () => {
  assert.equal(norm('듀파락-이지시럽/15mL/포'), norm('듀파락 이지시럽'));
  assert.equal(norm('에도스캡슐 1캡슐'), norm('에도스캡슐'));
  assert.equal(norm('시험정 300밀리그램'), norm('시험정300MG'));
  assert.notEqual(norm('시험정40/10mg'), norm('시험정40/5mg'));
  assert.notEqual(norm('시험정0.5mg'), norm('시험정5mg'));
});
test('explicit non-oral products are other, not liquid/pill guides', () => {
  for (const name of ['시험연고', '시험크림', '시험점안액', '시험주사제', '시험좌제', '시험패치', '시험흡입액', '시험관장액']) {
    assert.equal(form({ name, description: '투명한 액제' }), 'other', name);
    assert.equal(destination({ name }).cta, '의약품 정보 보기');
  }
});
test('unknown product remains a confirmation destination', () => {
  assert.equal(form({ id: '9', name: '시험제품' }), 'unknown');
  assert.equal(destination({ name: '시험제품' }).cta, '제품 유형 확인 필요');
});
test('mixed packs stay unknown; other liquid packs are distinguished', () => {
  assert.equal(pack({ ...syrup, packaging: '15mL/포, 100mL/병', permit: null }), 'unknown');
  assert.equal(pack({ ...syrup, packaging: '5mL/앰플', permit: null }), 'other');
  assert.equal(unit(capsule), '캡슐'); assert.equal(unit({ name: '시험정', form: '정제' }), '정');
});
test('no official candidates yields not-found', () => assert.equal(match({ drugName: '시험정' }, []).status, 'not-found'));
