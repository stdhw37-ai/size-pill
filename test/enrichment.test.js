import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { enrichMedicines, SOURCES, normalizePermit } from '../src/mfds-enrichment.js';
import worker from '../src/worker.js';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const reply = (items, totalCount = items.length) => Response.json({ header: { resultCode: '00' }, body: { totalCount, items } });
const pill = { id: '123', name: '시험약', long: 12, short: 6, thick: 4 };
const permit = { ITEM_SEQ: '123', ITEM_NAME: '시험약', ENTP_NAME: '시험회사', MAIN_ITEM_INGR: '시험성분', MATERIAL_NAME: '원료', INGR_NAME: '첨가제', ITEM_PERMIT_DATE: '20200101', PERMIT_KIND_NAME: '허가', ENTP_NO: '111', ETC_OTC_CODE: '일반', CHART: '성상', STORAGE_METHOD: '저장', VALID_TERM: '24개월', PACK_UNIT: '10정', CNSGN_MANUF: '제조사', CANCEL_NAME: '정상', CANCEL_DATE: '', ATC_CODE: 'TEST', CHANGE_DATE: '20260101' };
const easy = { itemSeq: '123', itemName: '시험약', entpName: '시험회사', efcyQesitm: '효능', useMethodQesitm: '사용법', atpnWarnQesitm: '경고', atpnQesitm: '주의', intrcQesitm: '상호작용', seQesitm: '부작용', depositMethodQesitm: '보관', openDe: '20200101', updateDe: '20260101' };
test('normalizePermit: 공식 허가사항 원문(PDF) 링크는 nedrug.mfds.go.kr만 허용한다', () => {
  const withDocs = normalizePermit({ ...permit, EE_DOC_ID: 'HTTPS://NEDRUG.MFDS.GO.KR/PBP/CMN/PDFDOWNLOAD/123/EE', UD_DOC_ID: 'https://nedrug.mfds.go.kr/PBP/CMN/PDFDOWNLOAD/123/UD', NB_DOC_ID: 'https://evil.com/fake' });
  assert.equal(withDocs.efficacyDocUrl, 'https://nedrug.mfds.go.kr/PBP/CMN/PDFDOWNLOAD/123/EE');
  assert.equal(withDocs.precautionDocUrl, 'https://nedrug.mfds.go.kr/PBP/CMN/PDFDOWNLOAD/123/UD');
  assert.equal(withDocs.officialDocUrl, '', '허용되지 않은 호스트는 빈 문자열');
  assert.equal(normalizePermit(permit).officialDocUrl, '', '필드가 없으면 빈 문자열');
});
test('공식 endpoint와 대소문자별 파라미터, 하나의 키, 실제 필드 매핑', async () => {
  const calls = [];
  globalThis.fetch = async url => { calls.push(url); return reply([url.pathname.includes('DrugPrdt') ? permit : easy]); };
  const [result] = await enrichMedicines([pill], 'one+key=');
  assert.equal(calls.length, 2);
  for (const [kind, source] of Object.entries(SOURCES)) {
    const url = calls.find(url => url.origin + url.pathname === source.endpoint); assert.ok(url);
    assert.equal(url.searchParams.get(source.key), 'one+key='); assert.equal(url.searchParams.get(source.id), '123');
    assert.equal(url.searchParams.get('type'), 'json'); assert.equal(url.searchParams.get('pageNo'), '1');
  }
  assert.equal(result.long, 12); assert.equal(result.permit.status, 'ok'); assert.equal(result.easy.status, 'ok');
  assert.equal(result.permit.data.ingredients, '시험성분'); assert.equal(result.permit.data.materials, '원료');
  for (const [field, value] of Object.entries({ efficacy: '효능', usage: '사용법', warning: '경고', precautions: '주의', interactions: '상호작용', sideEffects: '부작용', storage: '보관' })) assert.equal(result.easy.data[field], value);
  assert.ok(!JSON.stringify(result).includes('one+key'));
});
test('이름이 같아도 품목번호 불일치·중복·불완전 페이지는 병합하지 않는다', async () => {
  for (const [rows, total] of [[[ { ...permit, ITEM_SEQ: '999' } ], 1], [[permit, permit], 2], [[permit], 11]]) {
    globalThis.fetch = async url => url.pathname.includes('DrugPrdt') ? reply(rows, total) : reply([]);
    const [result] = await enrichMedicines([pill], 'key');
    assert.equal(result.permit.status, 'unmatched'); assert.equal(result.permit.data, null); assert.equal(result.easy.status, 'not_found');
  }
});
test('XML·인증오류·네트워크 장애 시 낱알정보와 성공한 보완정보 유지', async () => {
  for (const failure of [() => new Response('<error>key</error>'), () => Response.json({ header: { resultCode: '30' } }), () => { throw new Error('key'); }]) {
    globalThis.fetch = async url => url.pathname.includes('DrugPrdt') ? reply([permit]) : failure();
    const [result] = await enrichMedicines([pill], 'key');
    assert.equal(result.permit.status, 'ok'); assert.equal(result.easy.status, 'error'); assert.equal(result.long, 12);
  }
});
test('완전 병합 캐시 적중 시 세 API 모두 재호출하지 않고 부분 실패는 짧게 캐싱', async () => {
  for (const fail of [false, true]) {
    let saved; const calls = []; const pending = [];
    globalThis.fetch = async (url, options) => {
      calls.push(url);
      if (url.hostname === 'demo.supabase.co') {
        if (options.method === 'POST') { saved = JSON.parse(options.body); return new Response(null, { status: 204 }); }
        return Response.json(saved ? [{ payload: saved.payload }] : []);
      }
      if (url.pathname.includes('MdcinGrn')) return reply([{ ITEM_SEQ: '123', ITEM_NAME: '시험약', LENG_LONG: '12', LENG_SHORT: '6', THICK: '4' }]);
      if (url.pathname.includes('DrugPrdt')) return reply([permit]);
      return fail ? new Response('error', { status: 500 }) : reply([easy]);
    };
    const env = { MFDS_SERVICE_KEY: 'one+key=', SUPABASE_URL: 'https://demo.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test' };
    const request = () => new Request('https://app.example/api/medicines?q=시험약');
    const response = await worker.fetch(request(), env, { waitUntil: p => pending.push(p) }); await Promise.all(pending);
    assert.equal(response.status, 200); assert.equal(saved.payload.partial, fail);
    assert.equal(saved.payload.items[0].permit.data.ingredients, '시험성분');
    assert.ok((Date.parse(saved.expires_at) - Date.now()) < (fail ? 61000 : 86401000));
    assert.ok((Date.parse(saved.expires_at) - Date.now()) > (fail ? 50000 : 86000000));
    assert.equal(calls.filter(url => url.hostname === 'apis.data.go.kr').length, 3);
    const n = calls.length; await worker.fetch(request(), env, { waitUntil() {} });
    assert.equal(calls.length, n + 1); assert.equal(calls.at(-1).hostname, 'demo.supabase.co');
  }
});
