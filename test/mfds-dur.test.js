import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { lookupDur, lookupDurAll, DUR_SOURCES } from '../src/mfds-dur.js';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const reply = (items, totalCount = items.length) => Response.json({ header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' }, body: { totalCount, items } });
const row = { INGR_NAME: '아세트아미노펜', INGR_CODE: 'D000123', MIX_TYPE: '단일', ITEM_SEQ: '123', ITEM_NAME: '시험약', ENTP_NAME: '시험회사', MAIN_INGR: '아세트아미노펜', PROHBT_CONTENT: '1일 최대 용량을 초과하지 마십시오.', REMARK: '비고', NOTIFICATION_DATE: '20200101', CHANGE_DATE: '20260101' };

test('실제 필드 매핑: 용량주의/투여기간주의 두 API 모두 ITEM_SEQ 일치 건만 정규화하고 데이터가 있으면 available이다', async () => {
  const calls = [];
  globalThis.fetch = async url => { calls.push(url); return reply([row, { ...row, ITEM_SEQ: '999' }]); };
  const result = await lookupDur('capacity', '123', 'key', AbortSignal.timeout(2000));
  assert.equal(result.status, 'available');
  assert.equal(result.data.length, 1, 'ITEM_SEQ가 다른 행은 제외한다');
  assert.equal(result.data[0].content, '1일 최대 용량을 초과하지 마십시오.');
  assert.equal(result.data[0].ingredientName, '아세트아미노펜');
  assert.equal(calls[0].searchParams.get('itemSeq'), '123');
  assert.equal(calls[0].origin + calls[0].pathname, DUR_SOURCES.capacity.endpoint);
});

test('API 호출은 정상이지만 이 품목에 해당 DUR 데이터가 없으면 no-data이다 (실제 확인: 에도스캡슐 200402284는 capacity/period 모두 totalCount 0)', async () => {
  globalThis.fetch = async () => reply([], 0);
  const result = await lookupDur('capacity', '200402284', 'key', AbortSignal.timeout(2000));
  assert.equal(result.status, 'no-data');
  assert.deepEqual(result.data, []);
});

test('ITEM_SEQ가 일치하는 행이 응답에 하나도 없으면(다른 품목만 있음) no-data이지 available이 아니다', async () => {
  globalThis.fetch = async () => reply([{ ...row, ITEM_SEQ: '999' }], 1);
  const result = await lookupDur('period', '123', 'key', AbortSignal.timeout(2000));
  assert.equal(result.status, 'no-data');
});

test('서비스키가 이 API에 아직 등록/반영되지 않은 경우(SERVICE_KEY_IS_NOT_REGISTERED_ERROR)는 키가 잘못됐다고 단정하지 않고 pending-or-unavailable로 구분한다', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ OpenAPI_ServiceResponse: { cmmMsgHeader: { errMsg: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR', returnReasonCode: '30' } } }), { status: 403 });
  const result = await lookupDur('period', '123', 'key', AbortSignal.timeout(2000));
  assert.equal(result.status, 'pending-or-unavailable');
  assert.deepEqual(result.data, []);
});

test('네트워크 장애·인증 오류·잘못된 스키마는 error이며 원문을 노출하지 않는다 - 앱 전체 오류로 전파되지 않도록 항상 {status,data} 형태를 반환한다', async () => {
  for (const failure of [() => new Response('<error>secret-key</error>'), () => Response.json({ header: { resultCode: '30' } }), () => { throw new Error('secret-key'); }]) {
    globalThis.fetch = async () => failure();
    const result = await lookupDur('capacity', '123', 'key', AbortSignal.timeout(2000));
    assert.equal(result.status, 'error');
    assert.ok(!JSON.stringify(result).includes('secret-key'));
  }
});

test('lookupDurAll: 용량주의·투여기간주의를 동시에 조회한다', async () => {
  const calls = [];
  globalThis.fetch = async url => { calls.push(url.pathname); return reply([row]); };
  const { capacity, period } = await lookupDurAll('123', 'key', AbortSignal.timeout(2000));
  assert.equal(capacity.status, 'available'); assert.equal(period.status, 'available');
  assert.ok(calls.some(p => p.includes('getCpctyAtentInfoList03')));
  assert.ok(calls.some(p => p.includes('getMdctnPdAtentInfoList03')));
});

test('DUR_SOURCES: 응답 스키마가 다른 노인주의/효능군중복주의/서방정분할주의/병용금기는 이번 정규화 대상에서 제외하고, 같은 스키마인 용량주의/투여기간주의/특정연령대금기/임부금기만 등록한다', () => {
  assert.deepEqual(Object.keys(DUR_SOURCES).sort(), ['ageTaboo', 'capacity', 'period', 'pregnancyTaboo']);
});
