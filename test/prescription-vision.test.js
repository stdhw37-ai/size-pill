import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPrescriptionVision, ProviderNotConfiguredError } from '../src/prescription-vision.js';

const buffer = new TextEncoder().encode('fake-image-bytes').buffer;

test('provider가 설정되지 않으면 ProviderNotConfiguredError를 던진다 (fetch를 호출하지 않는다)', async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('should not be called'); };
  try {
    await assert.rejects(extractPrescriptionVision({}, buffer, 'image/png', new AbortController().signal), ProviderNotConfiguredError);
    await assert.rejects(extractPrescriptionVision({ PRESCRIPTION_VISION_PROVIDER: 'anthropic' }, buffer, 'image/png', new AbortController().signal), ProviderNotConfiguredError, 'API 키가 없으면 provider 이름만으로는 호출하지 않는다');
    assert.equal(fetchCalled, false);
  } finally { globalThis.fetch = originalFetch; }
});

test('알 수 없는 provider 이름은 설정되지 않은 것과 동일하게 처리한다', async () => {
  const env = { PRESCRIPTION_VISION_PROVIDER: 'not-a-real-provider', PRESCRIPTION_VISION_API_KEY: 'k' };
  await assert.rejects(extractPrescriptionVision(env, buffer, 'image/png', new AbortController().signal), ProviderNotConfiguredError);
});

test('anthropic provider는 tool_use 결과를 읽고 각 medication을 clampMedication으로 검증한다', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({
      content: [{ type: 'tool_use', name: 'record_prescription_medications', input: {
        medications: [
          { productCode: '644913501', rawName: '듀파락-이지시럽/15mL/포', drugName: '듀파락-이지시럽', strengthOrPackage: '15mL/포', doseUnit: '포', dosePerAdministration: 1, frequencyPerDay: 3, durationDays: 10, confidence: { productCode: .9, drugName: .95, dose: .9, frequency: .9, duration: .9 } },
          { drugName: '이상값정', dosePerAdministration: 19110, frequencyPerDay: 2, durationDays: 60, confidence: { productCode: 0, drugName: .8, dose: .9, frequency: .9, duration: .9 } }
        ]
      } }]
    });
  };
  try {
    const env = { PRESCRIPTION_VISION_PROVIDER: 'anthropic', PRESCRIPTION_VISION_API_KEY: 'test-key' };
    const { provider, medications: meds } = await extractPrescriptionVision(env, buffer, 'image/png', new AbortController().signal);
    assert.equal(provider, 'anthropic');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(calls[0].init.headers['x-api-key'], 'test-key');
    assert.equal(meds.length, 2);
    assert.equal(meds[0].drugName, '듀파락-이지시럽'); assert.equal(meds[0].dosePerAdministration, 1);
    assert.equal(meds[1].dosePerAdministration, null, '비정상 숫자는 provider 응답 단계에서도 서버가 통과시키지 않는다');
    assert.equal(meds[1].needsReview, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('openai provider는 json_object 응답을 파싱하고 동일하게 검증한다', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ choices: [{ message: { content: JSON.stringify({ medications: [
      { drugName: '에도스캡슐', strengthOrPackage: '1캡슐', doseUnit: '캡슐', dosePerAdministration: 1, frequencyPerDay: 2, durationDays: 60, confidence: { productCode: 0, drugName: .9, dose: .9, frequency: .9, duration: .9 } }
    ] }) } }] });
  };
  try {
    const env = { PRESCRIPTION_VISION_PROVIDER: 'openai', PRESCRIPTION_VISION_API_KEY: 'k' };
    const { provider, medications: meds } = await extractPrescriptionVision(env, buffer, 'image/png', new AbortController().signal);
    assert.equal(provider, 'openai');
    assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(calls[0].init.headers.authorization, 'Bearer k');
    assert.equal(meds[0].drugName, '에도스캡슐'); assert.equal(meds[0].durationDays, 60);
  } finally { globalThis.fetch = originalFetch; }
});

test('provider 응답이 배열이 아니면 오류로 처리한다', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ content: [{ type: 'tool_use', input: { medications: 'not-an-array' } }] });
  try {
    const env = { PRESCRIPTION_VISION_PROVIDER: 'anthropic', PRESCRIPTION_VISION_API_KEY: 'k' };
    await assert.rejects(extractPrescriptionVision(env, buffer, 'image/png', new AbortController().signal));
  } finally { globalThis.fetch = originalFetch; }
});

test('provider가 upstream 오류를 반환하면 예외를 던진다 (원문/키를 노출하지 않는다)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
  try {
    const env = { PRESCRIPTION_VISION_PROVIDER: 'anthropic', PRESCRIPTION_VISION_API_KEY: 'bad-key' };
    await assert.rejects(extractPrescriptionVision(env, buffer, 'image/png', new AbortController().signal), error => {
      assert.ok(!String(error.message).includes('bad-key'));
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});

test('PRESCRIPTION_VISION_PROVIDER가 없어도 GOOGLE_VISION_API_KEY만 있으면 google provider로 자동 선택된다', async () => {
  // This is the exact real setup found in this app's own .dev.vars (GOOGLE_VISION_API_KEY set,
  // PRESCRIPTION_VISION_PROVIDER never set) - the root cause of "vision route never called".
  let calledUrl = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    calledUrl = String(url);
    return Response.json({ responses: [{ fullTextAnnotation: { pages: [{ blocks: [] }] } }] });
  };
  try {
    const env = { GOOGLE_VISION_API_KEY: 'g-key' }; // no PRESCRIPTION_VISION_PROVIDER at all
    const { provider } = await extractPrescriptionVision(env, buffer, 'image/png', new AbortController().signal);
    assert.equal(provider, 'google');
    assert.ok(calledUrl.startsWith('https://vision.googleapis.com/v1/images:annotate?key='));
    assert.ok(calledUrl.includes('g-key'), 'the key IS in the request URL to Google (required by the API) - it is just never logged/returned to the client');
  } finally { globalThis.fetch = originalFetch; }
});

function gvWord(text, x0, y0, x1, y1, confidence = .95) {
  return { boundingBox: { vertices: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }] }, symbols: [...text].map(c => ({ text: c })), confidence };
}
test('google provider: 실제 응답 형태(blocks/paragraphs/words/symbols)를 읽어 기존 parsePrescriptionWords로 구조화한다', async () => {
  const words = [
    gvWord('처방의약품의명칭', 20, 20, 260, 40), gvWord('1회투여량', 480, 20, 550, 40),
    gvWord('1일투여횟수', 590, 20, 660, 40), gvWord('총투약일수', 720, 20, 790, 40),
    gvWord('644913501듀파락-이지시럽/15mL/포', 20, 60, 370, 76),
    gvWord('1', 500, 60, 520, 76), gvWord('3', 610, 60, 630, 76), gvWord('10', 740, 60, 760, 76)
  ];
  const originalFetch1 = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ responses: [{ fullTextAnnotation: { pages: [{ blocks: [{ paragraphs: [{ words }] }] }] } }] });
  try {
    const env = { GOOGLE_VISION_API_KEY: 'g-key' };
    const { provider, medications } = await extractPrescriptionVision(env, buffer, 'image/png', new AbortController().signal);
    assert.equal(provider, 'google');
    assert.equal(medications.length, 1);
    assert.equal(medications[0].productCode, '644913501');
    assert.equal(medications[0].drugName, '듀파락-이지시럽');
    assert.equal(medications[0].dosePerAdministration, 1);
    assert.equal(medications[0].frequencyPerDay, 3);
    assert.equal(medications[0].durationDays, 10);
  } finally { globalThis.fetch = originalFetch1; }
});
test('google provider: 여러 행에 걸친 세로로 긴 병합 오검출("word")은 걸러내고 각 행의 실제 숫자만 남긴다', async () => {
  // Reproduces a real observed Vision artifact: one spurious word spanning several rows' height,
  // landing in the same column as the real per-row numbers.
  const words = [
    gvWord('처방의약품의명칭', 20, 20, 260, 40), gvWord('1회투여량', 480, 20, 550, 40),
    gvWord('1일투여횟수', 590, 20, 660, 40), gvWord('총투약일수', 720, 20, 790, 40),
    gvWord('644913501듀파락정', 20, 60, 300, 76),
    gvWord('1', 500, 60, 520, 76), gvWord('3', 610, 60, 630, 76), gvWord('10', 740, 60, 760, 76),
    gvWord('649401610에도스캡슐', 20, 100, 300, 116),
    gvWord('1', 500, 100, 520, 116), gvWord('2', 610, 100, 630, 116), gvWord('60', 740, 100, 760, 116),
    gvWord('9999', 738, 55, 762, 300, .6) // spurious multi-row-tall artifact in the duration column
  ];
  const originalFetch2 = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ responses: [{ fullTextAnnotation: { pages: [{ blocks: [{ paragraphs: [{ words }] }] }] } }] });
  try {
    const env = { GOOGLE_VISION_API_KEY: 'g-key' };
    const { medications } = await extractPrescriptionVision(env, buffer, 'image/png', new AbortController().signal);
    assert.equal(medications.length, 2);
    assert.equal(medications[0].durationDays, 10, '병합 오검출("9999")이 실제 값과 섞이지 않는다');
    assert.equal(medications[1].durationDays, 60);
  } finally { globalThis.fetch = originalFetch2; }
});
test('google provider: upstream 오류/API 오류 응답은 VisionProviderError로 status/message만 전달한다', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 403 });
  try {
    const env = { GOOGLE_VISION_API_KEY: 'bad-key' };
    await assert.rejects(extractPrescriptionVision(env, buffer, 'image/png', new AbortController().signal), error => {
      assert.equal(error.status, 403);
      assert.equal(error.providerMessage, 'API key not valid');
      assert.ok(!String(error.message).includes('bad-key'));
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});
