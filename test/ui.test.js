import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { Window } from 'happy-dom';
import { normalize } from '../src/worker.js';
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
// Synthetic values, not a real medicine. Field names follow the official Swagger.
const complete = normalize({ ITEM_SEQ: '123', ITEM_NAME: '시험약 <img src=x onerror=alert(1)>', ENTP_NAME: '시험회사', DRUG_SHAPE: '원형', LENG_LONG: '12', LENG_SHORT: '10', THICK: '4', ITEM_IMAGE: 'https://nedrug.mfds.go.kr/test.png', COLOR_CLASS1: '하양', COLOR_CLASS2: '분홍', PRINT_FRONT: 'A1', PRINT_BACK: 'B2', LINE_FRONT: '+', CHART: '시험용 성상', FORM_CODE_NAME: '정제' });
const missing = normalize({ ITEM_SEQ: '456', ITEM_NAME: '치수누락 시험약', ENTP_NAME: '시험회사', LENG_LONG: '8', LENG_SHORT: '6', THICK: '3~4' });
const payload = (items = [complete, missing], page = 1, total = 2) => ({ items, page, total, pageSize: 20, fetchedAt: '2026-09-12T00:00:00Z' });
async function settle() { for (let i = 0; i < 5; i++) await setImmediate(); }
function setup(t, fetcher = async () => Response.json(payload())) {
  // Only the repository script and synthetic fixtures run here; external scripts are disabled.
  const window = new Window({ url: 'https://size-pill.example', settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  t.after(() => window.happyDOM.close());
  window.document.write(html.replace('<script src="/app.js" defer></script>', ''));
  window.fetch = fetcher;
  window.eval(script);
  const $ = selector => window.document.querySelector(selector);
  const input = (selector, value) => { $(selector).value = value; $(selector).dispatchEvent(new window.Event('input')); };
  const submit = async () => { $('#searchForm').dispatchEvent(new window.Event('submit', { cancelable: true })); await settle(); };
  return { window, $, input, submit };
}

test('검색·상세 식별정보·XSS 방어·누락 치수 전환 및 직접입력 복귀', async t => {
  const { $, submit, input } = setup(t);
  input('#query', '시험약'); await submit();
  assert.equal($('#results').children.length, 2);
  $('#results button').click();
  assert.equal($('#long').value, '12'); assert.equal($('#short').value, '10'); assert.equal($('#long').readOnly, true);
  assert.equal($('#pill').style.getPropertyValue('--long'), '12');
  assert.ok($('#identityFacts').textContent.includes('A1')); assert.ok($('#identityFacts').textContent.includes('B2'));
  assert.ok($('#identityFacts').textContent.includes('하양 / 분홍'));
  assert.equal($('#medicineImage img').src, complete.imageUrl);
  assert.equal($('#results [onerror]'), null); assert.equal($('#results .result-copy img'), null);
  assert.equal($('#medicineDetails').hidden, false);
  $('#results').children[1].click();
  assert.equal($('#thick').value, ''); assert.equal($('#medicineImage img'), null);
  assert.ok($('#identityFacts').textContent.includes('3~4 (원문'));
  $('[data-view="side"]').click(); assert.equal($('#pill').hidden, true);
  $('[data-view="front"]').click(); assert.equal($('#pill').hidden, false);
  $('#manual').click(); assert.equal($('#long').readOnly, false); assert.equal($('#medicineDetails').hidden, true);
  input('#long', '15'); assert.equal($('#pill').style.getPropertyValue('--long'), '15');
});

test('업체명·품목번호 필터를 페이지 이동에도 유지한다', async t => {
  const calls = [];
  const { $, input, submit } = setup(t, async path => {
    const params = new URL(path, 'https://size-pill.example').searchParams; calls.push(params);
    return Response.json(payload([complete], Number(params.get('pageNo')), 21));
  });
  input('#query', '시험약'); input('#companyQuery', '시험회사'); input('#itemSeqQuery', '123'); await submit();
  $('#nextPage').click(); await settle();
  assert.equal(calls.length, 2); assert.equal(calls[1].get('pageNo'), '2');
  for (const params of calls) {
    assert.equal(params.get('item_name'), '시험약'); assert.equal(params.get('entp_name'), '시험회사'); assert.equal(params.get('item_seq'), '123');
    assert.equal(params.has('serviceKey'), false);
  }
  assert.equal($('#nextPage').disabled, true);
});

test('이미지 오류와 빈 결과·API 오류를 안내한다', async t => {
  let response = Response.json(payload());
  const { $, window, input, submit } = setup(t, async () => response);
  input('#query', '시험약'); await submit(); $('#results button').click();
  $('#medicineImage img').dispatchEvent(new window.Event('error'));
  assert.ok($('#medicineImage').textContent.includes('불러올 수 없습니다'));
  response = Response.json(payload([], 1, 0)); await submit(); assert.equal($('#results').children.length, 0);
  assert.ok($('#searchStatus').textContent.includes('검색 결과가 없습니다'));
  response = Response.json({ error: '잠시 후 다시 검색해주세요.' }, { status: 502 }); await submit();
  assert.equal($('#searchStatus').textContent, '잠시 후 다시 검색해주세요.');
});

test('늦게 끝난 이전 요청의 오류가 새 검색 결과를 덮어쓰지 않는다', async t => {
  let rejectOld; let calls = 0;
  const { $, input, submit } = setup(t, () => ++calls === 1 ? new Promise((_, reject) => { rejectOld = reject; }) : Promise.resolve(Response.json(payload())));
  input('#query', '이전약'); await submit();
  input('#query', '다음약'); await submit();
  rejectOld(new Error('old error')); await settle();
  assert.equal($('#results').children.length, 2); assert.ok($('#searchStatus').textContent.includes('총 2개'));
});

test('화면 보정·앞옆면 치수·액체 측정·카메라 동작을 유지한다', async t => {
  const { $, window, input, submit } = setup(t);
  input('#query', '시험약'); await submit(); $('#results button').click();
  $('[data-view="side"]').click(); assert.equal($('#pill').style.getPropertyValue('--short'), '4');
  $('[data-view="front"]').click(); assert.equal($('#pill').style.getPropertyValue('--short'), '10');
  $('#toggleCal').click(); input('#calRange', '120'); $('#saveCal').click();
  assert.ok(Math.abs(Number(window.document.documentElement.style.getPropertyValue('--ppmm')) - 3.7795275591 * 1.2) < .00001);
  assert.equal(JSON.parse(window.localStorage.getItem('pillCalV2')).scale, 1.2);
  $('[data-mode="liquid"]').click(); assert.ok($('#liquidTool').classList.contains('active'));
  input('#levelRange', '50'); assert.equal($('#currentMl').value, '50');
  const stream = new window.MediaStream(); let requested;
  Object.defineProperty(window.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async options => { requested = options; return stream; } } });
  $('#camera').play = async () => {};
  await $('#startCamera').onclick();
  assert.equal(requested.audio, false); assert.equal(requested.video.facingMode.ideal, 'environment');
  assert.equal($('#camera').srcObject, stream); assert.ok($('#cameraWrap').classList.contains('live'));
  $('[data-mode="pill"]').click(); assert.equal($('#pillTool').classList.contains('hidden'), false);
});

test('성분·복약정보 표시와 제품 전환 시 이전 정보 제거', async t => {
  const supplemented = { ...complete, permit: { status: 'ok', data: { ingredients: '시험성분', permitKind: '허가' } }, easy: { status: 'ok', data: { efficacy: '<script>alert(1)</script>효능', usage: '사용법', warning: '경고', interactions: '상호작용', sideEffects: '부작용', storage: '보관' } } };
  const absent = { ...missing, permit: { status: 'error', data: null }, easy: { status: 'not_found', data: null } };
  const { $, input, submit } = setup(t, async () => Response.json(payload([supplemented, absent])));
  input('#query', '시험약'); await submit(); $('#results button').click();
  assert.ok($('#permitFacts').textContent.includes('시험성분'));
  for (const value of ['효능', '사용법', '경고', '상호작용', '부작용', '보관']) assert.ok($('#easyFacts').textContent.includes(value));
  assert.equal($('#easyFacts script'), null);
  $('#results').children[1].click();
  assert.equal($('#permitFacts').children.length, 0); assert.equal($('#easyFacts').children.length, 0);
  assert.ok($('#permitStatus').textContent.includes('불러오지 못했습니다'));
  assert.ok($('#easyStatus').textContent.includes('제공되는 정보가 없습니다'));
});

test('허가정보·복약정보·추가정보·출처는 검색 결과 화면에서 숨기되 데이터는 유지한다', async t => {
  const supplemented = { ...complete, permit: { status: 'ok', data: { ingredients: '시험성분' } }, easy: { status: 'ok', data: { efficacy: '효능' } } };
  const { $, input, submit } = setup(t, async () => Response.json(payload([supplemented, missing])));
  input('#query', '시험약'); await submit(); $('#results button').click();
  assert.equal($('#extraDetails').hidden, true);
  assert.ok(!!$('#extraDetails').closest('#medicineDetails'));
  // Underlying data must still populate (kept for a future detail screen), just not shown.
  assert.ok($('#permitFacts').textContent.includes('시험성분'));
  assert.ok($('#easyFacts').textContent.includes('효능'));
  assert.ok($('#extraFacts').textContent.includes(complete.id));
  // Core identity facts remain directly visible (not inside a hidden or collapsed section).
  assert.equal($('#identityFacts').closest('[hidden]'), null);
});

test('식별 정보에는 핵심 항목만 표시하고, 맛/향은 공식 텍스트에 명시된 경우에만 노출한다', async t => {
  const flavored = normalize({ ITEM_SEQ: '789', ITEM_NAME: '딸기맛 시험 씹어먹는정', ENTP_NAME: '시험회사', DRUG_SHAPE: '원형', LENG_LONG: '10', LENG_SHORT: '10', THICK: '4', CHART: '분홍색의 딸기향이 나는 씹어먹는 정제' });
  const unflavored = { ...complete };
  const { $, input, submit } = setup(t, async () => Response.json(payload([flavored, unflavored])));
  input('#query', '시험약'); await submit();
  $('#results').children[0].click();
  assert.ok($('#identityFacts').textContent.includes('맛/향'));
  assert.ok($('#identityFacts').textContent.includes('딸기향'));
  $('#results').children[1].click();
  assert.ok(!$('#identityFacts').textContent.includes('맛/향'));
});

test('맛과 향이 모두 명시된 경우 "맛/향" 한 줄이 아니라 "맛"·"향" 두 줄로 각각 표시한다', async t => {
  const both = normalize({ ITEM_SEQ: '654', ITEM_NAME: '시험 씹어먹는정', ENTP_NAME: '시험회사', DRUG_SHAPE: '원형', LENG_LONG: '10', LENG_SHORT: '10', THICK: '4', CHART: '단맛이 나는 딸기향의 밝은 분홍색 씹어먹는 정제' });
  const { $, input, submit } = setup(t, async () => Response.json(payload([both])));
  input('#query', '시험약'); await submit(); $('#results button').click();
  const text = $('#identityFacts').textContent;
  assert.ok(!text.includes('맛/향'), '두 종류가 모두 있으면 결합 행을 쓰지 않는다');
  assert.ok(text.includes('단맛'));
  assert.ok(text.includes('딸기향'));
});

test('색상/성분만으로 맛을 추측하지 않고, "방향" 같은 비관련 단어는 맛/향으로 오인하지 않는다', async t => {
  const noFlavorWord = normalize({ ITEM_SEQ: '321', ITEM_NAME: '시험약', ENTP_NAME: '시험회사', DRUG_SHAPE: '원형', LENG_LONG: '10', LENG_SHORT: '10', THICK: '4', CHART: '흰색의 원형 필름코팅정으로 세로 방향 분할선이 있다', COLOR_CLASS1: '분홍' });
  const { $, input, submit } = setup(t, async () => Response.json(payload([noFlavorWord])));
  input('#query', '시험약'); await submit(); $('#results button').click();
  assert.ok(!$('#identityFacts').textContent.includes('맛/향'));
});

test('장축·단축·두께가 모두 있으면 "크기" 요약(L × S × T mm)을 먼저 보여주고, 하나라도 없으면 숨긴다', async t => {
  const { $, input, submit } = setup(t, async () => Response.json(payload([complete, missing])));
  input('#query', '시험약'); await submit();
  $('#results').children[0].click();
  assert.equal($('#sizeSummary').hidden, false);
  assert.ok($('#sizeSummary').textContent.includes('12 × 10 × 4 mm'));
  $('#results').children[1].click(); // missing THICK ("3~4" is not a clean number)
  assert.equal($('#sizeSummary').hidden, true);
});

test('검색 결과 카드는 제조사·품목번호/모양/색상·장축×단축을 각각 별도 줄로 보여준다', async t => {
  const { $, input, submit } = setup(t, async () => Response.json(payload([complete])));
  input('#query', '시험약'); await submit();
  const metaLines = [...$('#results .result-copy').querySelectorAll('.r-meta')].map(el => el.textContent);
  assert.ok(metaLines.some(t => t === complete.company), '제조사가 별도 줄에 있어야 한다');
  assert.ok(metaLines.some(t => t.includes(complete.id) && t.includes(complete.shape)), '품목번호·모양·색상 줄');
  assert.ok(metaLines.some(t => t.includes(`${complete.long} × ${complete.short} mm`)), '장축 × 단축 줄');
});

test('네트워크가 끊기면 상단 배너가 나타나고, 복구되면 사라진다', async t => {
  const { $, window } = setup(t);
  assert.equal($('#networkBanner').hidden, true);
  window.dispatchEvent(new window.Event('offline'));
  assert.equal($('#networkBanner').hidden, false);
  window.dispatchEvent(new window.Event('online'));
  assert.equal($('#networkBanner').hidden, true);
});

test('앱 버전과 개인정보처리방침·이용약관 링크가 표시된다', async t => {
  const { $ } = setup(t);
  assert.ok($('#appVersion').textContent.length > 0);
  assert.ok($('#appVersionFooter').textContent.length > 0);
  assert.ok($('#privacyLink'));
  assert.ok($('#termsLink'));
});

test('2D/3D를 전환할 수 있고, 회전 슬라이더·앞/옆/뒤 버튼은 더 이상 존재하지 않는다(드래그 전용 조작)', async t => {
  const { $, input, submit } = setup(t);
  input('#query', '시험약'); await submit(); $('#results button').click();
  assert.equal($('#view2d').hidden, false); assert.equal($('#view3d').hidden, true);
  $('[data-dim="3d"]').click();
  assert.equal($('#view2d').hidden, true); assert.equal($('#view3d').hidden, false);
  // The rotation slider and front/side/back shortcut buttons were removed; only drag/wheel/pinch (OrbitControls) remain.
  assert.equal($('#rotate3d'), null);
  assert.equal($('[data-orient]'), null);
  // A short usage hint is shown instead of controls.
  assert.ok($('#scene3d').textContent.includes('드래그하여 회전'));
  // The real-size/magnified toggle remains.
  assert.ok($('[data-zoom="1"]'));
  assert.ok($('[data-zoom="2"]'));
  $('[data-dim="2d"]').click();
  assert.equal($('#view2d').hidden, false); assert.equal($('#view3d').hidden, true);
});

test('3D 씬은 렌더러 로딩 여부와 무관하게 2D 검색·선택·화면 보정 흐름을 절대 막지 않는다', async t => {
  // In this DOM test harness, the three.js/OrbitControls dynamic import cannot resolve (no real
  // network/module loader), so `three3d` stays null - this asserts the rest of the app still works.
  const { $, input, submit } = setup(t);
  input('#query', '시험약'); await submit(); $('#results button').click();
  assert.equal($('#long').value, '12'); assert.equal($('#pill').hidden, false);
  $('[data-dim="3d"]').click(); $('[data-dim="2d"]').click();
  $('#toggleCal').click(); input('#calRange', '110'); $('#saveCal').click();
  assert.equal($('#pill').hidden, false);
  assert.equal($('#pill').style.getPropertyValue('--long'), '12');
});
