import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { dimension, normalize, imageUrl, cacheKey } from '../src/worker.js';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const request = query => new Request('https://example.com/api/medicines?' + query);
const env = { MFDS_SERVICE_KEY: 'fake+key=' };
const ctx = { waitUntil: promise => promise };
const item = { ITEM_SEQ: '123', ITEM_NAME: '<b>시험약</b>', ENTP_NAME: '시험회사', LENG_LONG: '12.5', LENG_SHORT: '6', THICK: '' };
const upstream = (items = [item]) => Response.json({ header: { resultCode: '00' }, body: { items, totalCount: 1 } });
test('치수는 엄격히 해석하고 누락·범위값을 임의로 채우지 않는다', () => {
  for (const value of ['', null, '약 10', '10~12', '0', '-2', 'Infinity', '101']) assert.equal(dimension(value), null);
  assert.equal(dimension(' 12.5 '), 12.5);
  assert.equal(normalize(item).thick, null);
});
test('짧은 검색어·잘못된 페이지·미설정 키는 API를 호출하지 않는다', async () => {
  globalThis.fetch = () => assert.fail('unexpected request');
  assert.equal((await worker.fetch(request('q=a'), env, ctx)).status, 400);
  assert.equal((await worker.fetch(request('q=약이름&page=0'), env, ctx)).status, 400);
  assert.equal((await worker.fetch(request('q=약이름'), {}, ctx)).status, 503);
});
test('공식 API 필드와 인코딩된 키를 정상 매핑한다', async () => {
  globalThis.fetch = async url => {
    assert.equal(url.hostname, 'apis.data.go.kr');
    assert.equal(url.searchParams.get('serviceKey'), 'fake+key=');
    assert.equal(url.searchParams.get('item_name'), '시험약');
    assert.equal(url.searchParams.get('pageNo'), '2');
    return upstream();
  };
  const response = await worker.fetch(request('q=시험약&page=2'), { MFDS_SERVICE_KEY: 'fake%2Bkey%3D' }, ctx);
  assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.items[0].long, 12.5); assert.equal(data.items[0].thick, null); assert.equal(data.page, 2);
  assert.ok(!JSON.stringify(data).includes('fake'));
});
test('XML 오류·잘못된 JSON 스키마·인증 오류는 빈 결과로 위장하지 않는다', async () => {
  for (const response of [new Response('<error>secret</error>'), Response.json({}), Response.json({ header: { resultCode: '30' } })]) {
    globalThis.fetch = async () => response;
    const result = await worker.fetch(request('q=시험약'), env, ctx); assert.equal(result.status, 502); assert.ok(!(await result.text()).includes('secret'));
  }
});
test('중첩 item 및 빈 검색 결과 처리', async () => {
  globalThis.fetch = async () => upstream({ item });
  assert.equal((await (await worker.fetch(request('q=시험약'), env, ctx)).json()).items.length, 1);
  globalThis.fetch = async () => Response.json({ header: { resultCode: '00' }, body: { items: '', totalCount: 0 } });
  assert.deepEqual((await (await worker.fetch(request('q=없는약'), env, ctx)).json()).items, []);
});
test('Supabase 캐시 적중 시 식약처를 호출하지 않는다', async () => {
  globalThis.fetch = async (url, options) => {
    assert.equal(url.hostname, 'demo.supabase.co'); assert.equal(options.headers.apikey, 'sb_secret_test'); assert.equal(options.headers.Authorization, undefined);
    assert.ok(url.searchParams.get('expires_at').startsWith('gt.'));
    return Response.json([{ payload: { schemaVersion: 3, items: [normalize(item)], total: 1, page: 1, pageSize: 20, fetchedAt: '2026-09-12T00:00:00.000Z' } }]);
  };
  assert.equal((await worker.fetch(request('q=시험약'), { ...env, SUPABASE_URL: 'https://demo.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test' }, ctx)).status, 200);
});
test('캐시 장애 시 원본 조회 및 캐시 갱신, 쓰기 장애에도 검색 성공', async () => {
  const writes = [];
  globalThis.fetch = async (url, options) => {
    if (url.hostname === 'apis.data.go.kr') return upstream();
    if (options.method === 'POST') { writes.push(JSON.parse(options.body)); throw new Error('offline'); }
    throw new Error('offline');
  };
  const pending = [];
  const result = await worker.fetch(request('q=시험약'), { ...env, SUPABASE_URL: 'https://demo.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test' }, { waitUntil: p => pending.push(p) });
  await Promise.all(pending); assert.equal(result.status, 200); assert.equal(writes.length, 1); assert.equal(writes[0].payload.items[0].long, 12.5);
});
test('호출 제한 적용', async () => {
  globalThis.fetch = () => assert.fail('unexpected request');
  assert.equal((await worker.fetch(request('q=시험약'), { ...env, SEARCH_LIMITER: { limit: async () => ({ success: false }) } }, ctx)).status, 429);
});

test('실제 명세의 이미지·색상·식별표시·부가정보를 매핑하고 미지 필드는 노출하지 않는다', () => {
  const data = normalize({ ...item, ITEM_IMAGE: 'http://nedrug.mfds.go.kr/pbp/cmn/itemImageDownload/123',
    DRUG_SHAPE: '장방형', COLOR_CLASS1: '하양', COLOR_CLASS2: '분홍', PRINT_FRONT: 'A1', PRINT_BACK: 'B2',
    LINE_FRONT: '+', LINE_BACK: '-', CHART: '시험용 성상', FORM_CODE_NAME: '필름코팅정',
    CLASS_NAME: '시험분류', CLASS_NO: '000', ETC_OTC_NAME: '일반의약품', ITEM_ENG_NAME: 'Test only',
    ENTP_SEQ: '456', ITEM_PERMIT_DATE: '20000101', IMG_REGIST_TS: '20000102', CHANGE_DATE: '20000103',
    MARK_CODE_FRONT_ANAL: '앞마크', MARK_CODE_BACK_ANAL: '뒤마크',
    MARK_CODE_FRONT_IMG: 'https://nedrug.mfds.go.kr/front.png', MARK_CODE_BACK_IMG: 'https://nedrug.mfds.go.kr/back.png',
    MARK_CODE_FRONT: 'F', MARK_CODE_BACK: 'B', EDI_CODE: '111', BIZRNO: '222', STD_CD: '333',
    THICK: '4~5', serviceKey: 'never expose' });
  assert.equal(data.imageUrl, 'https://nedrug.mfds.go.kr/pbp/cmn/itemImageDownload/123');
  for (const [key, value] of Object.entries({ shape: '장방형', colorFront: '하양', colorBack: '분홍', printFront: 'A1', printBack: 'B2', lineFront: '+', lineBack: '-', description: '시험용 성상', form: '필름코팅정', className: '시험분류', classCode: '000', medicineType: '일반의약품', englishName: 'Test only', companyId: '456', permitDate: '20000101', imageDate: '20000102', changed: '20000103', markFront: '앞마크', markBack: '뒤마크', markImageFront: 'https://nedrug.mfds.go.kr/front.png', markImageBack: 'https://nedrug.mfds.go.kr/back.png', markCodeFront: 'F', markCodeBack: 'B', insuranceCode: '111', businessNumber: '222', standardCode: '333' })) assert.equal(data[key], value, key);
  assert.equal(data.thick, null); assert.equal(data.dimensionsRaw.thick, '4~5');
  assert.equal(data.serviceKey, undefined);
});

test('이미지 URL은 식약처 HTTPS로 제한한다', () => {
  for (const url of ['javascript:alert(1)', 'data:image/svg+xml,evil', 'https://mfds.go.kr.evil.com/a', 'https://evil.com/a', 'https://user:pass@nedrug.mfds.go.kr/a', 'https://nedrug.mfds.go.kr:8080/a', '', null]) assert.equal(imageUrl(url), '');
  assert.equal(imageUrl('http://nedrug.mfds.go.kr/a'), 'https://nedrug.mfds.go.kr/a');
});

test('업체명·품목일련번호·페이지 크기를 공식 요청변수에 전달한다', async () => {
  globalThis.fetch = async url => {
    for (const [key, expected] of Object.entries({ item_name: '시험약', entp_name: '회사 & 가', item_seq: '123', pageNo: '3', numOfRows: '7', type: 'json' })) assert.equal(url.searchParams.get(key), expected);
    return upstream();
  };
  const response = await worker.fetch(request(new URLSearchParams({ item_name: '시험약', entp_name: '회사 & 가', item_seq: '123', pageNo: '3', numOfRows: '7' })), env, ctx);
  assert.equal(response.status, 200); assert.equal((await response.json()).pageSize, 7);
});

test('업체 또는 품목번호 단독 검색 및 잘못된 조건 차단', async () => {
  for (const params of ['entp_name=회사', 'item_seq=123']) {
    globalThis.fetch = async url => { assert.equal(url.searchParams.has('item_name'), false); return upstream(); };
    assert.equal((await worker.fetch(request(params), env, ctx)).status, 200);
  }
  globalThis.fetch = () => assert.fail('unexpected upstream request');
  for (const params of ['item_seq=1x', 'q=시험약&numOfRows=101', 'q=시험약&numOfRows=0', 'q=시험약&pageNo=1.5', 'entp_name=%00', '', 'item_name=a']) assert.equal((await worker.fetch(request(params), env, ctx)).status, 400);
});

test('캐시 키는 모든 검색 조건과 응답 버전을 구분하고 필터 문자를 포함하지 않는다', async () => {
  const filters = ['시험약,*()', '회사', '123', 1, 20];
  const first = await cacheKey(filters);
  assert.match(first, /^mfds-v3:[a-f0-9]{64}$/);
  assert.equal(await cacheKey(filters), first);
  for (let i = 0; i < filters.length; i++) { const changed = [...filters]; changed[i] += '1'; assert.notEqual(await cacheKey(changed), first); }
});

test('service role 환경변수 별칭 및 기존 캐시 무효화 후 갱신', async () => {
  const pending = []; let upstreamCalls = 0, writes = 0;
  globalThis.fetch = async (url, options) => {
    if (url.hostname === 'apis.data.go.kr') { if (url.pathname.includes('MdcinGrn')) { upstreamCalls++; return upstream(); } return Response.json({ header: { resultCode: '00' }, body: { totalCount: 0, items: [] } }); }
    assert.equal(options.headers.apikey, 'test.jwt.key');
    assert.equal(options.headers.Authorization, 'Bearer test.jwt.key');
    if (options.method === 'POST') {
      const body = JSON.parse(options.body); assert.equal(body.payload.schemaVersion, 3);
      assert.deepEqual(Object.keys(body).sort(), ['cache_key', 'expires_at', 'payload']);
      assert.match(body.cache_key, /^mfds-v3:/); writes++; return new Response(null, { status: 204 });
    }
    return Response.json([{ payload: { items: [item], total: 1 } }]);
  };
  const response = await worker.fetch(request('q=시험약'), { ...env, SUPABASE_URL: 'https://demo.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test.jwt.key' }, { waitUntil: p => pending.push(p) });
  await Promise.all(pending);
  assert.equal(response.status, 200); assert.equal(upstreamCalls, 1); assert.equal(writes, 1);
});

test('잘못된 totalCount는 결과 없음으로 취급하지 않는다', async () => {
  for (const totalCount of [null, '', -1, 1.5, 'oops']) {
    globalThis.fetch = async () => Response.json({ header: { resultCode: '00' }, body: { totalCount, items: [] } });
    assert.equal((await worker.fetch(request('q=시험약'), env, ctx)).status, 502);
  }
});
