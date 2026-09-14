import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractWithVision, extractPrescription, VisionUnavailableError } from '../public/prescription-extractor.js';

const file = new File([new Uint8Array([1, 2, 3])], 'rx.png', { type: 'image/png' });

test('extractWithVision: 정상 응답은 medications를 검증해 반환한다', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const body = init.body; // FormData
    assert.ok(body.get('image') instanceof File);
    return Response.json({ schemaVersion: 1, source: 'vision', medications: [
      { drugName: '듀파락-이지시럽', dosePerAdministration: 1, frequencyPerDay: 3, durationDays: 10, confidence: { productCode: 0, drugName: .9, dose: .9, frequency: .9, duration: .9 } }
    ] });
  };
  try {
    const result = await extractWithVision(file, { signal: new AbortController().signal });
    assert.equal(result.source, 'vision');
    assert.equal(result.medications[0].drugName, '듀파락-이지시럽');
    assert.equal(calls[0].url, '/api/prescription/extract');
    assert.equal(calls[0].init.method, 'POST');
  } finally { globalThis.fetch = originalFetch; }
});

test('extractWithVision: 501(vision_not_configured)은 VisionUnavailableError로 변환된다', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: 'vision_not_configured' }, { status: 501 });
  try {
    await assert.rejects(extractWithVision(file, { signal: new AbortController().signal }), VisionUnavailableError);
  } finally { globalThis.fetch = originalFetch; }
});

test('extractWithVision: 네트워크 오류도 VisionUnavailableError로 변환된다 (AbortError는 예외)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('network down'); };
  try {
    await assert.rejects(extractWithVision(file, { signal: new AbortController().signal }), VisionUnavailableError);
  } finally { globalThis.fetch = originalFetch; }
  globalThis.fetch = async () => { throw new DOMException('cancelled', 'AbortError'); };
  try {
    await assert.rejects(extractWithVision(file, { signal: new AbortController().signal }), { name: 'AbortError' });
  } finally { globalThis.fetch = originalFetch; }
});

test('extractPrescription: vision이 성공하면 legacy OCR은 전혀 호출하지 않는다', async () => {
  let legacyCalled = false;
  const vision = async () => ({ medications: [{ drugName: '듀파락-이지시럽' }], source: 'vision' });
  const legacy = async () => { legacyCalled = true; return { medications: [], source: 'legacy-ocr' }; };
  const result = await extractPrescription(file, { visionExtractor: vision, legacyExtractor: legacy });
  assert.equal(result.source, 'vision');
  assert.equal(legacyCalled, false);
});

test('extractPrescription: vision이 설정되지 않았거나 실패하면 legacy OCR로 자동 전환한다', async () => {
  let visionUnavailableCalled = false;
  const vision = async () => { throw new VisionUnavailableError('vision_not_configured'); };
  const legacy = async () => ({ medications: [{ drugName: '레거시 OCR 결과' }], source: 'legacy-ocr' });
  const result = await extractPrescription(file, { visionExtractor: vision, legacyExtractor: legacy, onVisionUnavailable: () => { visionUnavailableCalled = true; } });
  assert.equal(result.source, 'legacy-ocr');
  assert.equal(result.medications[0].drugName, '레거시 OCR 결과');
  assert.equal(visionUnavailableCalled, true);
});

test('extractPrescription: 사용자가 취소(AbortError)하면 legacy로 넘어가지 않고 그대로 전파한다', async () => {
  let legacyCalled = false;
  const vision = async () => { throw new DOMException('cancelled', 'AbortError'); };
  const legacy = async () => { legacyCalled = true; return { medications: [], source: 'legacy-ocr' }; };
  await assert.rejects(extractPrescription(file, { visionExtractor: vision, legacyExtractor: legacy }), { name: 'AbortError' });
  assert.equal(legacyCalled, false, '취소는 사용자가 실제로 중단한 것이므로 자동으로 fallback을 시작하면 안 된다');
});

test('extractPrescription: vision과 legacy 모두 실패하면 legacy의 오류가 최종적으로 전파된다', async () => {
  const vision = async () => { throw new VisionUnavailableError('network'); };
  const legacy = async () => { throw new Error('이미지를 분석하지 못했습니다.'); };
  await assert.rejects(extractPrescription(file, { visionExtractor: vision, legacyExtractor: legacy }), { message: '이미지를 분석하지 못했습니다.' });
});
