import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listPrescriptions, fetchPrescriptionItems, savePrescription, deletePrescription } from '../public/prescriptions.js';

function fakeAccessToken(sub) { return `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`; }
const CONFIG = { supabaseUrl: 'https://proj.supabase.co', anonKey: 'anon-key-123' };
const SESSION = { accessToken: fakeAccessToken('user-1'), refreshToken: 'r1', expiresAt: Date.now() + 3600_000 };

test('listPrescriptions: 최근 처방전을 만든 순으로, 본인 access token으로만 조회한다', async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url: new URL(url), init }); return Response.json([{ id: 'p1', label: '듀파락-이지시럽 외 1건', created_at: '2026-09-14T00:00:00Z' }]); };
  const rows = await listPrescriptions(CONFIG, SESSION, fetcher);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, 'p1');
  const { url, init } = calls[0];
  assert.equal(url.pathname, '/rest/v1/prescriptions');
  assert.equal(url.searchParams.get('order'), 'created_at.desc');
  assert.equal(init.headers.apikey, CONFIG.anonKey);
  assert.equal(init.headers.Authorization, `Bearer ${SESSION.accessToken}`);
});

test('listPrescriptions: 실패하면 원문을 노출하지 않는 오류를 던진다', async () => {
  await assert.rejects(() => listPrescriptions(CONFIG, SESSION, async () => new Response('secret db detail', { status: 500 })), err => {
    assert.ok(!err.message.includes('secret db detail')); return true;
  });
});

test('fetchPrescriptionItems: prescription_id로 필터하고 position 순으로 요청한다', async () => {
  const calls = [];
  const fetcher = async url => { calls.push(new URL(url)); return Response.json([{ id: 'i1', drug_name: '에도스캡슐' }]); };
  const rows = await fetchPrescriptionItems(CONFIG, SESSION, 'p1', fetcher);
  assert.equal(rows[0].drug_name, '에도스캡슐');
  assert.equal(calls[0].searchParams.get('prescription_id'), 'eq.p1');
  assert.equal(calls[0].searchParams.get('order'), 'position.asc');
});

test('savePrescription: 처방전을 만든 뒤 항목을 순서대로 저장하고, 원본 이미지/전체 OCR 문장은 절대 보내지 않는다', async () => {
  const writes = [];
  const fetcher = async (url, init) => {
    const u = new URL(url);
    if (init.method === 'POST' && u.pathname === '/rest/v1/prescriptions') {
      const body = JSON.parse(init.body)[0];
      assert.equal(body.user_id, 'user-1'); assert.equal(body.label, '듀파락-이지시럽 외 1건');
      return Response.json([{ id: 'p1', label: body.label, created_at: '2026-09-14T00:00:00Z' }]);
    }
    if (init.method === 'POST' && u.pathname === '/rest/v1/prescription_items') { writes.push(JSON.parse(init.body)); return new Response(null, { status: 201 }); }
    return assert.fail('unexpected request ' + u.pathname);
  };
  const items = [
    { rawName: '듀파락-이지시럽/15mL/포', drugName: '듀파락-이지시럽', itemSeq: '201701391', kind: 'liquid', doseAmount: 1, doseUnit: '포', frequencyPerDay: 3, durationDays: 10, needsReview: false },
    { rawName: '에도스캡슐', drugName: '에도스캡슐', itemSeq: null, kind: null, doseAmount: 1, doseUnit: '캡슐', frequencyPerDay: 2, durationDays: 60, needsReview: true }
  ];
  const prescription = await savePrescription(CONFIG, SESSION, { label: '듀파락-이지시럽 외 1건', items }, fetcher);
  assert.equal(prescription.id, 'p1');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, 2);
  assert.deepEqual(writes[0].map(r => r.prescription_id), ['p1', 'p1']);
  assert.deepEqual(writes[0].map(r => r.position), [0, 1]);
  assert.equal(writes[0][0].item_seq, '201701391'); assert.equal(writes[0][1].item_seq, null);
  assert.equal(writes[0][1].needs_review, true);
  assert.ok(!('imageUrl' in writes[0][0]) && !('rawText' in writes[0][0]) && !('ocrText' in writes[0][0]));
});

test('savePrescription: 항목 저장이 실패하면 방금 만든 처방전도 되돌리고 실패를 알린다', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    const u = new URL(url); calls.push({ method: init.method, path: u.pathname });
    if (init.method === 'POST' && u.pathname === '/rest/v1/prescriptions') return Response.json([{ id: 'p1', label: null, created_at: '2026-09-14T00:00:00Z' }]);
    if (init.method === 'POST' && u.pathname === '/rest/v1/prescription_items') return new Response('fail', { status: 500 });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    return assert.fail('unexpected');
  };
  await assert.rejects(() => savePrescription(CONFIG, SESSION, { label: null, items: [{ drugName: '시험약' }] }, fetcher));
  assert.ok(calls.some(c => c.method === 'DELETE' && c.path === '/rest/v1/prescriptions'), '롤백 DELETE가 호출된다');
});

test('savePrescription: 항목이 없으면(전부 인식 실패) 처방전만 만들고 항목 요청은 보내지 않는다', async () => {
  let itemCalls = 0;
  const fetcher = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === '/rest/v1/prescription_items') { itemCalls++; return new Response(null, { status: 201 }); }
    return Response.json([{ id: 'p1', label: null, created_at: '2026-09-14T00:00:00Z' }]);
  };
  const prescription = await savePrescription(CONFIG, SESSION, { label: null, items: [] }, fetcher);
  assert.equal(prescription.id, 'p1'); assert.equal(itemCalls, 0);
});

test('deletePrescription: id로 DELETE 요청을 보낸다', async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url: new URL(url), init }); return new Response(null, { status: 204 }); };
  await deletePrescription(CONFIG, SESSION, 'p1', fetcher);
  assert.equal(calls[0].url.searchParams.get('id'), 'eq.p1');
  assert.equal(calls[0].init.method, 'DELETE');
});
