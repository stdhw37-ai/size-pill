import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { Window } from 'happy-dom';
import { normalize } from '../src/worker.js';
import * as auth from '../public/auth.js';
import * as prescriptions from '../public/prescriptions.js';
import * as realDoseCalc from '../public/dose-calc.js';
import * as dailyDose from '../public/prescription-dose.js';
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const medicineFlowScript = await readFile(new URL('../public/medicine-flow.js', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
// Synthetic values, not a real medicine. Field names follow the official Swagger.
const complete = normalize({ ITEM_SEQ: '123', ITEM_NAME: '시험약 <img src=x onerror=alert(1)>', ENTP_NAME: '시험회사', DRUG_SHAPE: '원형', LENG_LONG: '12', LENG_SHORT: '10', THICK: '4', ITEM_IMAGE: 'https://nedrug.mfds.go.kr/test.png', COLOR_CLASS1: '하양', COLOR_CLASS2: '분홍', PRINT_FRONT: 'A1', PRINT_BACK: 'B2', LINE_FRONT: '+', CHART: '시험용 성상', FORM_CODE_NAME: '정제' });
const missing = normalize({ ITEM_SEQ: '456', ITEM_NAME: '치수누락 시험약', ENTP_NAME: '시험회사', LENG_LONG: '8', LENG_SHORT: '6', THICK: '3~4' });
const payload = (items = [complete, missing], page = 1, total = 2) => ({ items, page, total, pageSize: 20, fetchedAt: '2026-09-12T00:00:00Z' });
async function settle() { for (let i = 0; i < 5; i++) await setImmediate(); }
// skipAuthGate defaults true so the ~200 pre-login tests below keep clicking straight into the app
// exactly as before (see app.js's initAuth() comment). Auth-gate tests pass skipAuthGate:false and
// manualAuth:true instead: manualAuth stops initAuth() from also attempting the real (always-fails-in
// -happy-dom) dynamic import('./auth.js') itself, so the test can drive the gate deterministically via
// window.__rxTest.applyAuthResolution(auth, ...) - a real, Node-imported auth.js - without a second,
// async resolution attempt racing in and silently overwriting the state the test just set up.
function setup(t, fetcher = async () => Response.json(payload()), { skipAuthGate = true, manualAuth = false } = {}) {
  // Only the repository script and synthetic fixtures run here; external scripts are disabled.
  const window = new Window({ url: 'https://size-pill.example', settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  t.after(() => window.happyDOM.close());
  window.document.write(html.replace('<script src="/app.js" defer></script>', ''));
  window.fetch = fetcher;
  window.__TEST_SKIP_AUTH_GATE__ = skipAuthGate;
  window.__TEST_MANUAL_AUTH__ = manualAuth;
  window.eval(medicineFlowScript);
  // prescriptions.js도 auth.js/dose-calc.js와 같은 이유로 이 하네스에서 동적 import()가 실패한다(happy
  // -dom의 disableJavaScriptFileLoading) - setPrescriptionsApi로 실제(Node import) 모듈을 직접 주입해
  // loadPrescriptionsApi()의 동적 import를 우회한다. 저장/조회 로직 자체는 이 실제 모듈이 수행한다.
  window.eval(script + '\nwindow.__rxTest = { setMedSchema(value) { medSchema = value; }, setPrescriptionsApi(value) { prescriptionsApi = value; }, setDoseCalc(value) { doseCalc = value; }, setRxDailyCalc(value) { rxDailyCalc = value; }, setPatientAgeYears(value) { patientAgeYears = value; }, getGroups() { return rxGroups; }, getPatientAgeYears() { return patientAgeYears; }, getPatientWeightKg() { return patientWeightKg; }, setPatientWeightKg(kg) { patientWeightKg = kg; }, getAuthGateOpen() { return authGateOpen; }, getCurrentProfile() { return currentProfile; }, applyAuthResolution(resolvedAuthApi, session, profile, config, consent) { return applyAuthResolution(resolvedAuthApi, session, profile, config, consent); }, setFlowSearchTimeoutMs(ms) { FLOW_SEARCH_TIMEOUT_MS = ms; } };');
  const $ = selector => window.document.querySelector(selector);
  const input = (selector, value) => { $(selector).value = value; $(selector).dispatchEvent(new window.Event('input')); };
  const submit = async () => { $('#searchForm').dispatchEvent(new window.Event('submit', { cancelable: true })); await settle(); };
  return { window, $, input, submit };
}

function pickRx(window, index = 0) {
  const doc = window.document;
  doc.querySelectorAll('#rxSelectedList .rx-row-button')[index].click();
  doc.querySelector('#rxDetailDialog .rx-action-product').click();
  const radio = doc.querySelector('#rxDetailDialog input[type=radio]');
  assert.ok(radio, '공식 제품 후보가 상세에서 보인다');
  radio.checked = true; radio.dispatchEvent(new window.Event('change'));
  doc.querySelector('#rxDetailDialog .rx-product-confirm').click();
}
function installRx(window, items, doseAmount = 1) {
  window.__rxTest.setRxDailyCalc(dailyDose); window.__rxTest.setPatientAgeYears(32);
  window.__prescriptionItems = items;
  window.eval(`window.__rxTest.getGroups().splice(0, window.__rxTest.getGroups().length, ...window.__prescriptionItems.map((item, index) => ({ id: index + 9000, term: item.name, source: 'ocr',
    row: { drugName: item.name, rawName: item.name, dosePerAdministration: ${doseAmount}, doseUnit: '캡슐', frequencyPerDay: 2, durationDays: 60, needsReview: false },
    candidates: [], chosen: { item, kind: 'pill', fetchedAt: '2026-09-15T00:00:00Z' } }))); renderRxGroups();`);
}
const dailyCapsule = { ...complete, id: '200402284', name: '에도스캡슐(에르도스테인)', form: '캡슐',
  permit: { status: 'ok', data: { ingredients: '에르도스테인', materials: '총량 : 1캡슐 중|성분명 : 에르도스테인|분량 : 300|단위 : 밀리그램' } },
  easy: { status: 'ok', data: { usage: '성인은 1회 1캡슐(300 mg)씩, 1일 2~3회 복용합니다.' } } };

test('검색·상세 식별정보·XSS 방어·누락 치수 전환 및 직접입력 복귀', async t => {
  const { $, submit, input } = setup(t);
  input('#query', '시험약'); await submit();
  assert.equal($('#results').children.length, 2);
  $('#results button').click();
  assert.equal($('#long').value, '12'); assert.equal($('#short').value, '10'); assert.equal($('#long').readOnly, true);
  assert.ok($('#sizeSummary').textContent.includes('12 × 10 × 4 mm'));
  assert.ok($('#identityFacts').textContent.includes('A1')); assert.ok($('#identityFacts').textContent.includes('B2'));
  assert.ok($('#identityFacts').textContent.includes('하양 / 분홍'));
  assert.equal($('#medicineImage img').src, complete.imageUrl);
  assert.equal($('#results [onerror]'), null); assert.equal($('#results .result-copy img'), null);
  assert.equal($('#medicineDetails').hidden, false);
  $('#results').children[1].click();
  assert.equal($('#thick').value, ''); assert.equal($('#medicineImage img'), null);
  assert.ok($('#identityFacts').textContent.includes('3~4 (원문'));
  $('#manual').click(); assert.equal($('#long').readOnly, false); assert.equal($('#medicineDetails').hidden, true);
  input('#thick', '4'); input('#long', '15'); assert.ok($('#sizeSummary').textContent.includes('15 × 6 × 4 mm'));
});

test('업체명·품목번호 필터를 페이지 이동에도 유지한다', async t => {
  const calls = [];
  const { $, input, submit } = setup(t, async path => {
    const url = new URL(path, 'https://size-pill.example'), params = url.searchParams;
    calls.push({ pathname: url.pathname, params });
    return Response.json(payload([complete], Number(params.get('pageNo')), 21));
  });
  input('#query', '시험약'); input('#companyQuery', '시험회사'); input('#itemSeqQuery', '123'); await submit();
  $('#nextPage').click(); await settle();
  // 통합검색(요청 1/8)이라 검색마다 /api/medicines·/api/liquids 두 곳을 함께 부른다 - 페이지네이션은
  // 계속 /api/medicines 기준이다.
  const medicineCalls = calls.filter(c => c.pathname === '/api/medicines');
  assert.equal(medicineCalls.length, 2); assert.equal(medicineCalls[1].params.get('pageNo'), '2');
  assert.ok(calls.some(c => c.pathname === '/api/liquids'), '허가정보 소스도 함께 조회한다');
  for (const { params } of calls) {
    assert.equal(params.get('item_name'), '시험약'); assert.equal(params.get('entp_name'), '시험회사'); assert.equal(params.get('item_seq'), '123');
    assert.equal(params.has('serviceKey'), false);
  }
  assert.equal($('#nextPage').disabled, true);
});

test('약 검색 목록은 light=1로 가벼운 데이터만 요청하고, 항목별 허가정보를 미리 받아오지 않는다', async t => {
  const calls = [];
  const { $, input, submit } = setup(t, async path => {
    const url = new URL(path, 'https://size-pill.example');
    calls.push(url.pathname + url.search);
    if (url.pathname === '/api/liquids') return Response.json(payload([], 1, 0));
    return Response.json(payload());
  });
  input('#query', '시험약'); await submit();
  const medicineCall = calls.find(c => c.startsWith('/api/medicines'));
  assert.ok(medicineCall.includes('light=1'), '목록 검색은 light=1이어야 한다');
  assert.equal(calls.length, 2, `목록 검색은 /api/medicines·/api/liquids 각 1회여야 한다 (실제: ${calls.length})`);
});

test('검색 목록에서 선택한 제품의 상세(허가정보·e약은요)는 선택 시점에만 지연 조회한다', async t => {
  const light = { ...complete, permit: { status: 'not_requested', data: null }, easy: { status: 'not_requested', data: null } };
  const calls = [];
  const { $, submit, input } = setup(t, async path => {
    const url = new URL(path, 'https://size-pill.example');
    calls.push(url.pathname + url.search);
    if (url.pathname === '/api/liquids') return Response.json(payload([], 1, 0));
    if (url.searchParams.get('item_seq') === light.id) {
      return Response.json(payload([{ ...light, permit: { status: 'ok', data: { storage: '실온보관' } }, easy: { status: 'ok', data: { usage: '1일 2회 복용' } } }], 1, 1));
    }
    return Response.json(payload([light]));
  });
  input('#query', '시험약'); await submit();
  assert.equal(calls.filter(c => c.includes('item_seq=' + light.id)).length, 0, '목록 조회 단계에서는 item_seq 단일 조회가 없어야 한다');
  $('#results button').click();
  await settle();
  assert.ok(calls.some(c => c.includes('item_seq=' + light.id)), '제품을 선택하면 item_seq로 상세를 지연 조회해야 한다');
  assert.ok($('#coreInfoStorage').textContent.includes('실온보관'), '지연 조회한 보관방법이 핵심정보 카드에 반영되어야 한다');
});

test('같은 검색어로 버튼을 연달아 눌러도(진행 중) 중복 request가 발생하지 않는다', async t => {
  let calls = 0, resolveFirst;
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const { input, window, $ } = setup(t, async () => { calls++; await first; return Response.json(payload()); });
  input('#query', '시험약');
  $('#searchForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle();
  $('#searchForm').dispatchEvent(new window.Event('submit', { cancelable: true })); // 진행 중에 다시 제출
  resolveFirst();
  await settle();
  assert.equal(calls, 2, '동일 조건이 진행 중일 때 재제출은 추가 request를 만들지 않아야 한다(medicines+liquids 각 1회)');
});

test('이미지 오류와 빈 결과·API 오류를 안내한다', async t => {
  // search()가 이제 /api/medicines와 /api/liquids를 함께 조회하므로(통합검색), 같은 Response 인스턴스를
  // 두 번 재사용할 수 없다(body는 한 번만 읽을 수 있다) - 매 fetch 호출마다 새 Response를 만든다.
  let respond = () => Response.json(payload());
  const { $, window, input, submit } = setup(t, async () => respond());
  input('#query', '시험약'); await submit(); $('#results button').click();
  $('#medicineImage img').dispatchEvent(new window.Event('error'));
  assert.ok($('#medicineImage').textContent.includes('불러올 수 없습니다'));
  respond = () => Response.json(payload([], 1, 0)); await submit(); assert.equal($('#results .result'), null); assert.ok($('#results .empty-state'));
  assert.ok($('#searchStatus').textContent.includes('검색 결과가 없습니다'));
  respond = () => Response.json({ error: '잠시 후 다시 검색해주세요.' }, { status: 502 }); await submit();
  assert.equal($('#searchStatus').textContent, '잠시 후 다시 검색해주세요.');
});

test('통합검색: 정제·시럽·산제·외용제가 한 검색에서 제형 배지와 함께 나오고, 빠른 확인 칩은 같은 결과를 필터만 한다', async t => {
  const tablet = { ...complete, name: '코미정' };
  const syrup = { id: '901', name: '코미시럽', company: '코오롱제약(주)', form: '시럽제', permit: { status: 'ok', data: { packaging: '500mL/병' } } };
  const powder = { id: '902', name: '코미산', company: '코오롱제약(주)', form: '산제', permit: { status: 'ok', data: { packaging: '1g/포 × 20포' } } };
  const ointment = { id: '903', name: '코미크림', company: '코오롱제약(주)', description: '백색의 크림제' };
  const { $, window, input, submit } = setup(t, async path => {
    if (String(path).startsWith('/api/liquids')) return Response.json(payload([syrup, powder, ointment], 1, 3));
    return Response.json(payload([tablet], 1, 1));
  });
  input('#query', '코미'); await submit();
  const badges = () => [...$('#results').children].map(el => ({ name: el.querySelector('b').textContent, badge: el.querySelector('.badge').textContent }));
  assert.equal($('#results').children.length, 4, '정제·시럽·산제·외용제가 모두 한 목록에 나온다');
  assert.deepEqual(new Set(badges().map(b => b.name)), new Set(['코미정', '코미시럽', '코미산', '코미크림']));
  assert.ok(badges().some(b => b.name === '코미정' && b.badge.includes('정')), '정제 배지');
  assert.ok(badges().some(b => b.name === '코미시럽' && b.badge.includes('시럽')), '시럽 배지');

  // 크기 확인: 같은 통합검색 결과를 정제/캡슐만 남기는 필터일 뿐이다 (요청 3/8).
  $('#quickChipSize').click();
  input('#query', '코미'); await submit();
  assert.equal($('#results').children.length, 1);
  assert.equal($('#results b').textContent, '코미정');

  // 맛/복용감: 정제뿐 아니라 시럽·산제까지 검색되지만(요청 3), 외용제(크림)는 맛과 무관하므로 제외된다.
  $('[data-mode="home"]').click(); $('#quickChipTaste').click();
  input('#query', '코미'); await submit();
  const tasteNames = [...$('#results').children].map(el => el.querySelector('b').textContent);
  assert.deepEqual(new Set(tasteNames), new Set(['코미정', '코미시럽', '코미산']), '정제·시럽·산제는 포함, 외용제는 제외');

  // 일반 "약 검색" 진입으로 돌아오면 필터가 풀린다.
  $('[data-mode="home"]').click(); $('.home-search-cta').click();
  input('#query', '코미'); await submit();
  assert.equal($('#results').children.length, 4, '일반 검색으로 돌아오면 다시 전체가 보인다');
});

test('늦게 끝난 이전 요청의 오류가 새 검색 결과를 덮어쓰지 않는다', async t => {
  let rejectOld; let calls = 0;
  const { $, input, submit } = setup(t, () => ++calls === 1 ? new Promise((_, reject) => { rejectOld = reject; }) : Promise.resolve(Response.json(payload())));
  input('#query', '이전약'); await submit();
  input('#query', '다음약'); await submit();
  rejectOld(new Error('old error')); await settle();
  assert.equal($('#results').children.length, 2); assert.ok($('#searchStatus').textContent.includes('총 2개'));
});

test('화면 보정·액체 측정·카메라 동작을 유지한다', async t => {
  const { $, window, input, submit } = setup(t);
  input('#query', '시험약'); await submit(); $('#results button').click();
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

test('공식 문구가 강도를 명시한 경우에만 "강한 OO맛"처럼 구조화하고, 임의로 강도를 추론하지 않는다', async t => {
  const strongPrefix = normalize({ ITEM_SEQ: '111', ITEM_NAME: '강한맛 시험약', ENTP_NAME: '시험회사', DRUG_SHAPE: '원형', LENG_LONG: '10', LENG_SHORT: '10', THICK: '4', CHART: '강한 쓴맛이 나는 하양의 원형 정제' });
  const strongSuffix = normalize({ ITEM_SEQ: '112', ITEM_NAME: '강도표기 시험약', ENTP_NAME: '시험회사', DRUG_SHAPE: '원형', LENG_LONG: '10', LENG_SHORT: '10', THICK: '4', CHART: '쓴맛이 강함' });
  const plain = normalize({ ITEM_SEQ: '113', ITEM_NAME: '보통맛 시험약', ENTP_NAME: '시험회사', DRUG_SHAPE: '원형', LENG_LONG: '10', LENG_SHORT: '10', THICK: '4', CHART: '쓴맛이 있는 하양의 원형 정제' });
  const { $, input, submit } = setup(t, async () => Response.json(payload([strongPrefix, strongSuffix, plain], 1, 3)));
  input('#query', '시험약'); await submit();
  $('#results').children[0].click();
  assert.ok($('#flavorChips').textContent.includes('강한 쓴맛'), '문구에 명시된 강도 수식어를 그대로 반영한다');
  $('#results').children[1].click();
  assert.ok($('#flavorChips').textContent.includes('강한 쓴맛'), '"쓴맛이 강함"처럼 뒤에 붙는 표현도 인식한다');
  $('#results').children[2].click();
  assert.ok($('#flavorChips').textContent.includes('쓴맛') && !$('#flavorChips').textContent.includes('강한'), '강도 표현이 없으면 임의로 붙이지 않는다');
});

test('맛/향 문구가 성상(CHART)에 없어도 제품허가정보의 첨가제 이름에 있으면 확인한다', async t => {
  const additiveFlavor = normalize({ ITEM_SEQ: '222', ITEM_NAME: '첨가제향 시험약', ENTP_NAME: '시험회사', DRUG_SHAPE: '원형', LENG_LONG: '10', LENG_SHORT: '10', THICK: '4', CHART: '하양의 원형 정제' });
  additiveFlavor.permit = { status: 'ok', data: { additives: '[M001]정제수|[M002]오렌지향|[M003]결정셀룰로스' } };
  const { $, input, submit } = setup(t, async () => Response.json(payload([additiveFlavor])));
  input('#query', '시험약'); await submit(); $('#results button').click();
  assert.equal($('#flavorBadge').hidden, false);
  assert.ok($('#flavorChips').textContent.includes('오렌지향'));
});

test('연질캡슐처럼 공식 문구에 맛/향이 전혀 없으면 겉보기 색만으로 추정하지 않고 "등록된 맛 정보 없음"을 보여준다', async t => {
  // 실제 탁센400이부프로펜연질캡슐 데이터 형태: 반투명한 파란 캡슐이지만 CHART/성상 어디에도 맛/향 문구가 없다.
  const softCapsule = normalize({ ITEM_SEQ: '333', ITEM_NAME: '탁센400이부프로펜연질캡슐', ENTP_NAME: '시험회사', DRUG_SHAPE: '타원형', LENG_LONG: '16.7', LENG_SHORT: '9.9', THICK: '9.9', COLOR_CLASS1: '파랑, 투명', CHART: '무색 내지 엷은 청색의 액상 내용물이든 청색의 투명한 타원형 연질캡슐' });
  const { $, input, submit } = setup(t, async () => Response.json(payload([softCapsule])));
  input('#query', '시험약'); await submit(); $('#results button').click();
  assert.equal($('#flavorBadge').hidden, false, '정보가 없어도 배지는 계속 보인다(요청 7) - 숨기지 않는다');
  assert.equal($('#flavorChips').textContent, '등록된 맛 정보 없음', '색상만으로 맛을 추정해 채우지 않는다');
});

test('상세정보를 펼치지 않아도 모양·색상·식별표시 요약 줄이 보이고, 맛/향이 확인되면 별도 배지로 표시한다', async t => {
  const flavored = normalize({ ITEM_SEQ: '789', ITEM_NAME: '딸기맛 시험 씹어먹는정', ENTP_NAME: '시험회사', DRUG_SHAPE: '원형', LENG_LONG: '10', LENG_SHORT: '10', THICK: '4', COLOR_CLASS1: '분홍', CHART: '분홍색의 딸기향이 나는 씹어먹는 정제' });
  const bare = normalize({ ITEM_SEQ: '999', ITEM_NAME: '정보없는 시험약', ENTP_NAME: '시험회사', LENG_LONG: '10', LENG_SHORT: '8', THICK: '3' }); // 모양/색상/식별표시/맛향 전부 없음
  const { $, input, submit } = setup(t, async () => Response.json(payload([flavored, complete, bare], 1, 3)));
  input('#query', '시험약'); await submit();
  $('#results').children[0].click();
  assert.equal($('#quickFacts').hidden, false);
  assert.ok($('#quickFacts').textContent.includes('원형'), '요약 줄에 모양이 보인다');
  assert.ok(!$('#quickFacts').textContent.includes('향'), '맛/향은 별도 배지로 분리되어 요약 줄에는 섞이지 않는다');
  assert.equal($('#flavorBadge').hidden, false);
  assert.ok($('#flavorChips').textContent.includes('딸기향'));
  $('#results').children[1].click(); // complete: 모양·색상·식별표시는 있지만 맛/향 표현은 없는 제품
  assert.equal($('#quickFacts').hidden, false, '맛/향이 없어도 모양·색상 요약은 계속 보인다');
  assert.ok($('#quickFacts').textContent.includes(complete.shape));
  assert.equal($('#flavorBadge').hidden, false, '맛/향 정보가 없어도 배지는 숨기지 않고 "등록된 맛 정보 없음"을 보여준다 (요청 7)');
  assert.equal($('#flavorChips').textContent, '등록된 맛 정보 없음');
  $('#results').children[2].click(); // bare: 정말 아무 요약 정보도 없는 제품
  assert.equal($('#quickFacts').hidden, true);
  assert.equal($('#flavorBadge').hidden, false);
  assert.equal($('#flavorChips').textContent, '등록된 맛 정보 없음');
});

test('제품 사진을 누르면 확대 모달이 열리고, 3D 화면에는 같은 사진을 반복해서 보여주지 않는다', async t => {
  const { $, input, submit } = setup(t);
  input('#query', '시험약'); await submit(); $('#results').children[0].click(); // complete: 이미지 있음
  assert.equal($('#quickPhotoBtn').hidden, false);
  assert.equal($('#photoModal').hasAttribute('open'), false);
  $('#quickPhotoBtn').click();
  assert.ok($('#photoModalImage img'), '모달에 같은 제품 사진이 채워진다');
  assert.equal($('#photoModalImage img').src, complete.imageUrl);
  $('#closePhotoModal').click();
  assert.equal($('#compareRow'), null, '3D 화면 위에 사진을 다시 보여주는 별도 비교 영역은 더 이상 없다');
  $('#results').children[1].click(); // missing: 이미지 없음
  assert.equal($('#quickPhotoBtn').hidden, true);
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

test('정제 검색: 핵심정보 카드가 3D보다 먼저 보이고 복용방법·보관방법·제형을 보여주며, 3D 실물크기는 기본적으로 접혀 있다 (요청 3/9, 완료보고 테스트 1)', async t => {
  const tablet = { ...complete, easy: { status: 'ok', data: { usage: '성인은 1회 1~2정씩, 1일 3회 복용합니다.', storage: '실온 보관' } }, permit: { status: 'ok', data: { storage: '실온(1~30℃) 보관' } } };
  const { $, window, input, submit } = setup(t, async () => Response.json(payload([tablet])));
  window.__rxTest.setDoseCalc(realDoseCalc);
  input('#query', '시험약'); await submit();
  $('#results').children[0].click();
  assert.equal($('#coreInfoCard').hidden, false, '핵심정보 카드가 보인다');
  assert.ok($('#coreInfoDose').textContent.includes('1회 1~2정'), '공식 용법에서 1회 복용량을 읽는다');
  assert.ok($('#coreInfoDose').textContent.includes('하루 3회'));
  assert.equal($('#coreInfoStorage').textContent, '실온(1~30℃) 보관');
  assert.ok($('#quickFacts').textContent.includes(complete.form), '제형이 요약 줄에 보인다');
  // 요청 2/7/8: 3D는 정제/캡슐의 "도구" 카드로, 접힌 아코디언이 아니라 결과 화면에 바로 보인다.
  assert.equal($('#pillToolCard').hidden, false, '실물크기 도구 카드가 결과 화면에 바로 보인다');
  assert.ok($('#scene3d'), '3D 씬이 도구 카드 안에 있다');
  assert.ok($('#sizeSummary').textContent.includes('mm'), '크기 자체는 핵심정보 카드에서도 보인다');
  assert.equal($('#manualEntryDetails').open, false, '치수 직접 입력(고급 기능)은 기본적으로 접혀 있다');
});

test('맛 데이터가 없는 제품은 배지에 "등록된 맛 정보 없음"만 보여주고 임의로 맛을 만들지 않는다 (완료보고 테스트 6)', async t => {
  const noFlavor = { ...complete, description: '흰색의 원형 필름코팅정', permit: null };
  const { $, input, submit } = setup(t, async () => Response.json(payload([noFlavor])));
  input('#query', '시험약'); await submit(); $('#results').children[0].click();
  assert.equal($('#flavorBadge').hidden, false);
  assert.equal($('#flavorChips').textContent, '등록된 맛 정보 없음');
});

test('검색 결과 카드는 제조사·모양/색상·장축×단축을 각각 별도 줄로 보여주고, 품목일련번호는 카드에 노출하지 않는다', async t => {
  const { $, input, submit } = setup(t, async () => Response.json(payload([complete])));
  input('#query', '시험약'); await submit();
  const metaLines = [...$('#results .result-copy').querySelectorAll('.r-meta')].map(el => el.textContent);
  assert.ok(metaLines.some(t => t === complete.company), '제조사가 별도 줄에 있어야 한다');
  assert.ok(metaLines.some(t => t.includes(complete.shape) && t.includes(complete.colorFront)), '모양·색상 줄');
  assert.ok(metaLines.some(t => t.includes(`${complete.long} × ${complete.short} mm`)), '장축 × 단축 줄');
  // 품목일련번호는 카드를 복잡하게 만드는 보조정보라 카드에는 없고, 선택 후 상세정보(추가 품목 정보)에만 있다.
  assert.ok(!metaLines.some(t => t.includes(complete.id)), '품목일련번호는 카드에 노출하지 않는다');
});

test('검색 결과가 5개보다 많으면 처음 5개만 보이고, "더보기"를 누르면 5개씩 더 나타난다', async t => {
  const many = Array.from({ length: 12 }, (_, i) => normalize({ ITEM_SEQ: String(i), ITEM_NAME: `시험약${i}`, ENTP_NAME: '시험회사', DRUG_SHAPE: '원형', LENG_LONG: '10', LENG_SHORT: '10', THICK: '4' }));
  const { $, input, submit } = setup(t, async () => Response.json(payload(many, 1, many.length)));
  input('#query', '시험약'); await submit();
  assert.equal($('#results').children.length, 5, '처음엔 5개만 렌더링');
  assert.equal($('#showMoreResults').hidden, false);
  $('#showMoreResults').click();
  assert.equal($('#results').children.length, 10);
  assert.equal($('#showMoreResults').hidden, false, '아직 2개 남음');
  $('#showMoreResults').click();
  assert.equal($('#results').children.length, 12, '남은 만큼만 채워지고 넘치지 않는다');
  assert.equal($('#showMoreResults').hidden, true, '더 보여줄 항목이 없으면 숨긴다');
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

test('앱은 Home 화면으로 시작하고, 카드/하단 네비게이션으로 각 화면을 전환할 수 있다', async t => {
  const { $ } = setup(t);
  assert.equal($('#screenHome').hidden, false, 'Home이 기본 화면');
  assert.equal($('#pillTool').classList.contains('hidden'), true);
  assert.equal($('#screenSettings').hidden, true);
  $('[data-mode="pill"]').click(); // Home의 "알약 실물크기 확인하기" 카드
  assert.equal($('#screenHome').hidden, true);
  assert.equal($('#pillTool').classList.contains('hidden'), false);
  assert.equal($('#pillTool').dataset.step, 'search', '처음 진입하면 검색 단계');
  $('[data-mode="settings"]').click();
  assert.equal($('#screenSettings').hidden, false);
  assert.equal($('#pillTool').classList.contains('hidden'), true);
  $('[data-mode="home"]').click();
  assert.equal($('#screenHome').hidden, false);
});

test('홈의 "시럽·포 용량" 빠른 확인은 액체약 화면으로 바로 연결된다', async t => {
  const { $ } = setup(t);
  const chip = [...$('.quick-chip-row').children].find(b => b.textContent.includes('시럽·포 용량'));
  assert.ok(chip, 'Home에 "시럽·포 용량" 빠른 확인이 있다');
  chip.click();
  assert.equal($('#liquidTool').classList.contains('active'), true);
  assert.equal($('#liquidSearchWay').hidden, false, '기본은 액체약 검색 방식');
});

test('제품을 선택하면 모바일 단계가 검색에서 실물크기 결과로 넘어가고, 뒤로가기로 검색으로 돌아간다', async t => {
  const { $, input, submit } = setup(t);
  $('[data-mode="pill"]').click();
  input('#query', '시험약'); await submit();
  assert.equal($('#pillTool').dataset.step, 'search');
  $('#results button').click();
  assert.equal($('#pillTool').dataset.step, 'result', '제품 선택 시 실물크기 화면으로 전환');
  assert.equal($('#resultName').textContent, complete.name);
  assert.ok($('#resultCompany').textContent.includes(complete.company));
  $('#backToSearchFromResult').click();
  assert.equal($('#pillTool').dataset.step, 'search');
  $('#backToHomeFromSearch').click();
  assert.equal($('#screenHome').hidden, false);
});

test('제품 상세정보는 접힌 아코디언이 아니라 항상 보이고, 치수 직접 입력(고급 기능)만 접혀 있으며 API 치수가 없으면 기본으로 펼쳐진다', async t => {
  const { $, input, submit } = setup(t, async () => Response.json(payload([complete, missing])));
  input('#query', '시험약'); await submit();
  $('#results').children[0].click(); // complete: 치수 전부 있음
  assert.equal($('#detailsAccordion').hidden, false, '제품 상세정보는 항상 보인다 (요청 8)');
  assert.equal($('#manualEntryDetails').open, false, '치수가 API로 채워졌으면 직접입력(고급 기능)은 기본적으로 접힌다');
  // Core identity facts stay fully present and directly visible, not tucked inside any hidden or
  // collapsed section - the whole point of no longer wrapping product details in an accordion.
  assert.equal($('#identityFacts').closest('[hidden]'), null);
  $('#results').children[1].click(); // missing: THICK가 범위값이라 두께 없음
  assert.equal($('#manualEntryDetails').open, true, '치수가 불완전하면 직접입력을 눈에 띄게 펼쳐둔다');
  $('#manual').click();
  assert.equal($('#detailsAccordion').hidden, true, '직접 입력 모드에는 상세정보가 없다');
  assert.equal($('#manualEntryDetails').open, true);
});

test('제품을 선택하면 "최근 확인한 약"에 추가되고, 칩을 누르면 품목일련번호로 같은 제품을 다시 불러온다', async t => {
  // A fetcher that actually distinguishes an item_seq lookup from a plain name search, so clicking
  // the recent chip is verified to round-trip through the real item_seq query path (not just
  // "whichever result happens to render first").
  const { $, input, submit } = setup(t, async path => {
    const params = new URL(path, 'https://size-pill.example').searchParams;
    if (params.get('item_seq') === complete.id) return Response.json(payload([complete], 1, 1));
    return Response.json(payload([complete, missing]));
  });
  assert.equal($('#recentSection').hidden, true, '기록이 없으면 숨김');
  input('#query', '시험약'); await submit(); $('#results button').click();
  assert.equal($('#recentSection').hidden, false);
  assert.ok($('#recentRow').textContent.includes(complete.name));
  $('#manual').click(); // 결과 화면을 벗어나도 기록은 유지
  $('[data-mode="home"]').click();
  $('#recentRow button').click();
  await settle();
  assert.equal($('#resultName').textContent, complete.name, '최근 항목을 눌러 같은 제품을 품목일련번호로 다시 불러온다');
  assert.equal($('#pillTool').dataset.step, 'result');
});

test('화면 보정 상태 문구가 보정 전/후를 명확히 구분해서 보여준다', async t => {
  const { $, input } = setup(t);
  assert.ok($('#calStatusText').textContent.includes('필요'));
  $('#toggleCal').click(); input('#calRange', '120'); $('#saveCal').click();
  assert.ok($('#calStatusText').textContent.includes('완료'));
  assert.ok($('#settingsCalStatus').textContent.includes('완료'));
});

test('3D 모델이 유일한 실물크기 화면이며, 옛 2D 탭/격자/앞뒤면 버튼은 어떤 상태에서도 존재하지 않는다', async t => {
  const { $, input, submit } = setup(t);
  // Before any product is picked (default manual-entry example state).
  $('[data-mode="pill"]').click();
  assert.equal($('#view2d'), null); assert.equal($('#pill'), null); assert.equal($('#measure'), null);
  assert.equal($('[data-dim]'), null); assert.equal($('[data-view]'), null);
  // 요청 2: 검색 단계(3D 도구 카드가 아직 없는 상태)에서는 결과 화면 자체가 보이지 않는다.
  assert.equal($('#resultView').hidden, true, '검색 단계에서는 결과 화면(3D 포함)이 보이지 않는다');
  // After selecting a real product - the result step shows the tool card with the 3D view directly.
  input('#query', '시험약'); await submit(); $('#results button').click();
  assert.equal($('#view2d'), null); assert.equal($('#resultView').hidden, false); assert.equal($('#scene3d').closest('[hidden]'), null);
  // After manual entry.
  $('#manual').click();
  assert.equal($('#view2d'), null); assert.equal($('#resultView').hidden, false); assert.equal($('#scene3d').closest('[hidden]'), null);
  // The rotation slider and front/side/back shortcut buttons were removed; only drag/wheel/pinch (OrbitControls) remain.
  assert.equal($('#rotate3d'), null);
  assert.equal($('[data-orient]'), null);
  // A short usage hint is shown instead of controls.
  assert.ok($('#scene3d').textContent.includes('드래그하여 회전'));
  // Only the real-size/magnified toggle remains, and its user-facing labels are exactly these two.
  assert.ok($('[data-zoom="1"]')); assert.ok($('[data-zoom="2"]'));
  assert.equal($('[data-zoom="1"]').textContent, '실제 크기');
  assert.equal($('[data-zoom="2"]').textContent, '확대 보기');
  assert.equal(html.includes('2D 실물크기'), false, '"2D 실물크기" 문구는 어디에도 남아 있지 않아야 한다');
  assert.equal(html.includes('>앞면<'), false, '"앞면" 버튼 문구는 어디에도 남아 있지 않아야 한다');
  assert.equal(html.includes('>옆면<'), false, '"옆면" 버튼 문구는 어디에도 남아 있지 않아야 한다');
});

test('3D 씬은 렌더러 로딩 여부와 무관하게 검색·선택·화면 보정 흐름을 절대 막지 않는다', async t => {
  // In this DOM test harness, the three.js/OrbitControls dynamic import cannot resolve (no real
  // network/module loader), so `three3d` stays null - this asserts the rest of the app still works.
  const { $, input, submit } = setup(t);
  input('#query', '시험약'); await submit(); $('#results button').click();
  assert.equal($('#long').value, '12');
  assert.ok($('#sizeSummary').textContent.includes('12 × 10 × 4 mm'));
  $('#toggleCal').click(); input('#calRange', '110'); $('#saveCal').click();
  assert.ok($('#sizeSummary').textContent.includes('12 × 10 × 4 mm'));
});

test('처방전 후보 선택·상세·제품 변경·삭제는 목록 다음 화면에서 동작한다', async t => {
 const a = { ...complete, name: '텔미암정40/10mg' }, b = { ...complete, id: '124', name: '텔미암정40/5mg' };
 const { $, window, input, submit } = setup(t, async () => Response.json(payload([b,a])));
 await window.eval("processRxNames(['텔미암 40/1O'])");
 assert.equal($('#rxCandidates'), null); assert.equal($('#rxSelectedList input'), null);
 pickRx(window); assert.ok(window.__rxTest.getGroups()[0].chosen);
 $('#rxDetailDialog .rx-action-size').click(); assert.equal($('#pillTool').dataset.step, 'result');
 $('[data-mode="prescription"]').click(); $('#rxSelectedList .rx-row-button').click();
 $('#rxDetailDialog .rx-action-product').click(); $('#rxDetailDialog .rx-product-search').click();
 assert.equal($('#rxSearchContext').hidden, false); input('#query','텔미암'); await submit(); $('#results button').click();
 assert.equal($('#rxSelectedList').children.length,1);
 $('#rxSelectedList .rx-row-button').click(); $('#rxDetailDialog .rx-action-remove').click();
 assert.equal($('#rxSelectedList').children.length,0); $('#rxClear').click(); assert.equal($('#rxSelectedSection').hidden,true);
});

test('약 직접 추가: 페이지 이동 없이 같은 화면 안에서 알약·액체 전체 제형을 검색하고, 복용정보를 입력해 처방 목록에 추가한다 (요청 6/7/8/9/10/28)', async t => {
  const pill = { ...complete, id: '201', name: '세토펜정325mg' };
  const liquid = { ...complete, id: '202', name: '세토펜현탁액', form: '현탁액', description: '경구용 현탁액', permit: { status: 'ok', data: { packaging: '15mL/포 × 20포' } } };
  const schema = await import('../public/prescription-schema.js');
  const calls = [];
  const { $, window } = setup(t, async path => {
    calls.push(path);
    if (path.startsWith('/api/liquids')) return Response.json(payload([liquid], 1, 1));
    return Response.json(payload([pill], 1, 1));
  });
  window.__rxTest.setMedSchema(schema);
  $('[data-mode="prescription"]').click();
  $('#rxAdd').click();
  assert.equal($('#rxAddPanel').hidden, false, '패널이 같은 화면 안에서 열린다');
  assert.equal($('#pillTool').classList.contains('hidden'), true, '알약 실물크기 검색 화면(pill screen)으로 이동하지 않는다 (요청 6)');
  assert.equal($('#prescriptionTool').hidden, false);

  $('#rxAddQuery').value = '세토펜';
  $('#rxAddSearchForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle();
  assert.ok(calls.some(p => p.startsWith('/api/medicines')) && calls.some(p => p.startsWith('/api/liquids')), '정제/캡슐뿐 아니라 액체약도 함께 검색한다 (요청 7)');
  assert.equal($('#rxAddResults').children.length, 2, 'solid-oral로 걸러내지 않고 모든 제형을 보여준다');

  // 액체 제품을 선택하면 공식 포장정보(15mL/포)를 기준으로 단위 추천·환산 힌트를 보여준다 (요청 9) -
  // 포장이 "15mL/포 × 20포"로 낱개 포장 단위이므로 포를 기본 추천하고 1포=15mL 환산 힌트를 함께 보여준다.
  const liquidButton = [...window.document.querySelectorAll('#rxAddResults button')].find(b => b.textContent.includes('세토펜현탁액'));
  liquidButton.click();
  assert.equal($('#rxAddDoseForm').hidden, false);
  assert.equal($('#rxAddSelectedName').textContent, '세토펜현탁액');
  assert.equal($('#rxAddDoseUnit').value, '포', '포장 단위가 포이므로 포를 기본 추천한다');
  const unitOptions = [...window.document.querySelectorAll('#rxAddDoseUnit option')].map(o => o.value);
  assert.deepEqual(unitOptions, ['mL', '포']);
  assert.equal($('#rxAddPouchHint').hidden, false);
  assert.ok($('#rxAddPouchHint').textContent.includes('15mL'), '1포 = 15mL 환산 힌트를 보여준다');
  $('#rxAddDoseUnit').value = 'mL'; $('#rxAddDoseUnit').dispatchEvent(new window.Event('change'));
  assert.equal($('#rxAddPouchHint').hidden, true, 'mL을 직접 선택하면 포 환산 힌트는 숨긴다');
  $('#rxAddDoseUnit').value = '포'; $('#rxAddDoseUnit').dispatchEvent(new window.Event('change'));

  $('#rxAddDoseAmount').value = '3.5'; $('#rxAddFrequency').value = '3'; $('#rxAddDuration').value = '5';
  $('#rxAddConfirm').click(); await settle();

  assert.equal($('#rxAddPanel').hidden, true, '추가 후 패널이 닫힌다');
  assert.equal($('#rxSelectedList').children.length, 1);
  assert.ok($('#rxSelectedList').textContent.includes('세토펜현탁액'));
  $('#rxSelectedList .rx-row-button').click(); assert.ok($('#rxDetailDialog').textContent.includes('직접 추가한 처방')); $('#rxDetailDialog .rx-detail-close').click();
  assert.equal(window.__rxTest.getGroups()[0].chosen.kind, 'liquid');
  assert.equal(window.__rxTest.getGroups()[0].row.dosePerAdministration, 3.5);
  assert.equal(window.__rxTest.getGroups()[0].row.doseUnit, '포');
  assert.equal(window.__rxTest.getGroups()[0].row.frequencyPerDay, 3);
  assert.equal(window.__rxTest.getGroups()[0].row.durationDays, 5);

  // solid-oral 제품도 같은 패널에서 검색·추가할 수 있다 (요청 7) - 정/캡슐 단위를 추천한다.
  $('#rxAdd').click();
  $('#rxAddQuery').value = '세토펜';
  $('#rxAddSearchForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle();
  const pillButton = [...window.document.querySelectorAll('#rxAddResults button')].find(b => b.textContent.includes('세토펜정325mg'));
  pillButton.click();
  assert.equal($('#rxAddDoseUnit').value, '정');
  $('#rxAddCancelDose').click();
  assert.equal($('#rxAddDoseForm').hidden, true); assert.equal($('#rxAddResults').hidden, false);
  $('#rxAddClose').click();
  assert.equal($('#rxAddPanel').hidden, true);
});

// 실제 재현된 버그: 같은 품목(예: 캡슐 제품)이 낱알식별(/api/medicines, enrichMedicines로 성분·사용법까지
// 채워짐)과 일반 허가정보(/api/liquids, 목록 조회에서는 항상 easy:'not_requested') 검색에 모두 걸리면,
// 나중에 넣은 쪽이 이기는 병합 순서 때문에 더 얕은 허가정보 쪽이 낱알식별 데이터를 덮어써서 "약 직접
// 추가"로 넣은 약의 용량 분석이 항상 "공식 정보가 없어요"로 보이고 있었다(에도스캡슐 등에서 실제 재현).
test('약 직접 추가: 같은 품목이 두 검색 소스에 모두 있으면 성분·사용법이 채워진 낱알식별 데이터가 우선한다', async t => {
  const thin = { id: '200402284', name: '에도스캡슐(에르도스테인)', company: '영일제약(주)', permit: { status: 'ok', data: {} }, easy: { status: 'not_requested', data: null } };
  const rich = { ...complete, id: '200402284', name: '에도스캡슐(에르도스테인)', form: '경질캡슐제',
    permit: { status: 'ok', data: { materials: '성분명 : 에르도스테인|분량 : 300|단위 : 밀리그램' } },
    easy: { status: 'ok', data: { usage: '성인은 1회 1캡슐(300 mg)씩, 1일 2~3회 복용합니다.' } } };
  const { $, window } = setup(t, async path => path.startsWith('/api/liquids') ? Response.json(payload([thin], 1, 1)) : Response.json(payload([rich], 1, 1)));
  const schema = await import('../public/prescription-schema.js');
  window.__rxTest.setMedSchema(schema);
  $('[data-mode="prescription"]').click();
  $('#rxAdd').click();
  $('#rxAddQuery').value = '에도스';
  $('#rxAddSearchForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle();
  assert.equal($('#rxAddResults').children.length, 1, '같은 id는 하나로 합쳐진다');
  [...window.document.querySelectorAll('#rxAddResults button')][0].click();
  $('#rxAddDoseAmount').value = '1'; $('#rxAddFrequency').value = '2'; $('#rxAddDuration').value = '60';
  $('#rxAddConfirm').click(); await settle();
  const item = window.__rxTest.getGroups()[0].chosen.item;
  assert.ok(item.easy?.data?.usage, '허가정보 쪽이 아니라 사용법이 채워진 낱알식별 데이터가 선택된다');
  assert.equal(item.permit?.data?.materials, '성분명 : 에르도스테인|분량 : 300|단위 : 밀리그램');
});

test('일반 검색에서도 시럽 등 액체약은 알약 3D 화면이 아니라 액체 화면으로 이동한다', async t => {
  // Regression for item 1/2 of the request: #searchForm only queries /api/medicines (the pill
  // dataset), but a name search there can still surface a liquid product by name match - this must
  // route the same way the prescription flow already does (isOralLiquidCandidate), never assume
  // 'pill' just because the result came from the pill-search box.
  const liquid = { ...complete, form: '시럽제', name: '듀파락-이지시럽', description: '경구용 시럽제', permit: { status: 'ok', data: { packaging: '15mL × 30포' } } };
  const { $, input, submit } = setup(t, async () => Response.json(payload([liquid], 1, 1)));
  input('#query', '듀파락'); await submit();
  $('#results button').click();
  assert.equal($('#liquidTool').classList.contains('active'), true);
  assert.equal($('#pillTool').classList.contains('hidden'), true);
  assert.equal($('#liquidName').textContent, '듀파락-이지시럽');
});

test('처방전 상세의 제형 기능은 기존 액제 화면으로 연결되고 목록에는 나타나지 않는다', async t => {
 const item = { ...complete, form:'시럽제', name:'듀파락-이지시럽', permit:{status:'ok',data:{packaging:'15mL/포'}} };
 const {window,$} = setup(t, async()=>Response.json(payload([item])));
 await window.eval("processRxNames(['듀파락-이지시럽'])"); pickRx(window);
 assert.equal($('#rxSelectedList .rx-action-size'),null);
 $('#rxDetailDialog .rx-action-size').click();
 assert.equal($('#liquidTool').classList.contains('active'),true); assert.equal($('#pillTool').classList.contains('hidden'),true);
});

test('OCR 후보 추출은 개인정보를 제외하고 약명·함량만 남긴다', t => {
  const { window } = setup(t);
  assert.deepEqual(Array.from(window.eval("extractRxNames('홍길동 900101-1234567\\n서울병원\\n텔미암정 40/10mg 1 2 30\\n아모잘탄정5/50mg')")), ['텔미암정 40/10mg', '아모잘탄정5/50mg']);
  assert.deepEqual(Array.from(window.eval("extractRxNames('텔 미 암 정 40/10mg')")), ['텔미암정 40/10mg']);
});

test('액체약 공식 포장 용량·분율·맛/향을 표시하고 미제공 정보를 추측하지 않는다', async t => {
  // Packaging text names only pouch units (no "병") so classifyContainerType() resolves to 'pouch'
  // unambiguously - this test is about volume/fraction/flavor display, not type classification
  // (see the dedicated container-type tests below).
  const liquid = { ...complete, form: '시럽제', name: '시험시럽', description: '딸기향의 시럽제', permit: { status: 'ok', data: { packaging: '20mL × 30포, 5mL × 10포' } } };
  const paths = [];
  const { $, input, window } = setup(t, async path => { paths.push(path); return Response.json(payload([liquid])); });
  $('[data-mode="liquid"]').click(); input('#liquidQuery', '시험시럽');
  $('#liquidSearch').dispatchEvent(new window.Event('submit')); await settle();
  assert.ok(paths[0].startsWith('/api/liquids?')); $('#liquidResults button').click();
  assert.equal($('#liquidGuide').hidden, false); assert.equal($('#bottleNotice').hidden, true); assert.equal($('#containerTypeChoice').hidden, true);
  assert.ok($('#liquidFlavor').textContent.includes('딸기향'));
  assert.equal($('#liquidPackage').options.length, 3); assert.equal($('#liquidPackage').value, '');
  input('#liquidPackage', '20'); $('[data-fraction="0.3333333333333333"]').click();
  assert.ok($('#fractionVolume').textContent.includes('6.7 mL'));
  input('#customFraction', '40%'); assert.ok($('#fractionVolume').textContent.includes('8 mL'));
  input('#customFraction', '200%'); assert.ok($('#fractionError').textContent.includes('입력')); assert.ok($('#fractionVolume').textContent.includes('8 mL'));
  input('#liquidManualMl', '-5'); assert.ok(!$('#fractionVolume').textContent.includes('mL'));
  assert.ok($('#liquidGuide').textContent.includes('정확한 용량은 계량도구를 사용해주세요'));
  assert.equal($('#cameraAdvanced').open, false);
});

test('시럽 검색: 맛 · 1회 복용량(mL) · 복용횟수 · 보관방법을 보여주고 알약 3D 모델은 표시하지 않는다 (완료보고 테스트 3)', async t => {
  const syrup = { ...complete, form: '시럽제', name: '시험시럽', description: '딸기향의 시럽제',
    easy: { status: 'ok', data: { usage: '만 12세 이상은 10 mL씩 복용하며, 1일 3회 복용합니다.', storage: '실온 보관' } },
    permit: { status: 'ok', data: { packaging: '100mL/병', storage: '차광, 실온 보관' } } };
  const { $, window, input } = setup(t, async () => Response.json(payload([syrup])));
  window.__rxTest.setDoseCalc(realDoseCalc);
  $('[data-mode="liquid"]').click(); input('#liquidQuery', '시험시럽');
  $('#liquidSearch').dispatchEvent(new window.Event('submit')); await settle();
  $('#liquidResults button').click();
  assert.ok($('#liquidFlavor').textContent.includes('딸기향'), '맛/향을 보여준다');
  assert.equal($('#liquidCoreInfoCard').hidden, false);
  assert.ok($('#liquidCoreInfoDose').textContent.includes('1회 10mL'), '공식 용법에서 mL 복용량을 읽는다');
  assert.ok($('#liquidCoreInfoDose').textContent.includes('하루 3회'), '복용횟수를 함께 보여준다');
  assert.equal($('#liquidCoreInfoStorage').textContent, '차광, 실온 보관');
  assert.equal($('#pillTool').classList.contains('hidden'), true, '알약 3D 모델(pill screen)은 표시되지 않는다');
  assert.equal($('#liquidTool').classList.contains('active'), true);
});

test('산제/포 제품 검색: 맛 · 복용방법을 보여주고 포 분할 가이드(기존 액체약 포/스틱 기능)로 연결하며, 알약 3D 모델은 표시하지 않는다 (완료보고 테스트 4)', async t => {
  const powder = { id: '501', name: '시험산제', company: '시험제약', form: '산제', description: '흰색의 산제',
    easy: { status: 'ok', data: { usage: '1회 1포씩 1일 3회 복용합니다.', storage: '실온 보관' } },
    permit: { status: 'ok', data: { packaging: '1g/포 × 20포', storage: '실온 보관' } } };
  const { $, input, submit } = setup(t, async () => Response.json(payload([powder], 1, 1)));
  input('#query', '시험산제'); await submit();
  $('#results').children[0].click();
  await settle(); // loadLiquidPhoto()의 비동기 이미지 조회가 테스트 종료 후까지 남지 않게 정리한다
  assert.equal($('#pillTool').classList.contains('hidden'), true, '알약 3D 모델은 표시되지 않는다');
  assert.equal($('#liquidTool').classList.contains('active'), true, '기존 포/스틱 분할 가이드 화면으로 연결된다');
  assert.equal($('#liquidGuide').hidden, false, '포 분할 가이드 영역이 보인다');
  assert.ok($('#liquidFlavor').textContent.length > 0, '맛 정보 영역이 보인다(등록된 정보가 없으면 없음으로 표시)');
  assert.equal($('#liquidCoreInfoCard').hidden, false);
  assert.notEqual($('#liquidCoreInfoDose').textContent, '정보 없음', '복용방법 원문을 보여준다');
});

test('연고 검색: 사용방법 · 보관방법을 보여주고 알약 3D 모델은 표시하지 않는다 (완료보고 테스트 5)', async t => {
  const ointment = { id: '502', name: '시험연고', company: '시험제약', description: '백색의 연고',
    easy: { status: 'ok', data: { usage: '환부에 적당량을 1일 2~3회 바릅니다.', precautions: '눈 주위에는 사용하지 마십시오.', storage: '실온 보관' } } };
  const { $, input, submit } = setup(t, async () => Response.json(payload([ointment], 1, 1)));
  input('#query', '시험연고'); await submit();
  $('#results').children[0].click();
  assert.equal($('#pillTool').classList.contains('hidden'), true, '알약 3D 모델은 표시되지 않는다');
  assert.equal($('#liquidTool').classList.contains('active'), false);
  const dialogText = $('#medicineInfoDialog').textContent;
  assert.ok(dialogText.includes('환부에 적당량을 1일 2~3회 바릅니다'), '사용방법을 보여준다');
  assert.ok(dialogText.includes('실온 보관'), '보관방법을 보여준다');
  assert.ok(dialogText.includes('눈 주위에는 사용하지 마십시오'), '주의사항을 보여준다');
});

test('액체약 새 검색 결과가 늦게 끝난 이전 요청으로 바뀌지 않는다', async t => {
  let oldResolve;
  const { $, window, input } = setup(t, path => path.includes(encodeURIComponent('이전시럽')) ? new Promise(resolve => { oldResolve = resolve; }) : Promise.resolve(Response.json(payload([{ ...complete, form: '시럽제', name: '다음시럽' }]))));
  input('#liquidQuery', '이전시럽'); $('#liquidSearch').dispatchEvent(new window.Event('submit')); await settle();
  input('#liquidQuery', '다음시럽'); $('#liquidSearch').dispatchEvent(new window.Event('submit')); await settle();
  oldResolve(Response.json(payload([{ ...complete, form: '시럽제', name: '이전시럽' }]))); await settle();
  assert.ok($('#liquidResults').textContent.includes('다음시럽')); assert.ok(!$('#liquidResults').textContent.includes('이전시럽'));
});

// A 1x1 PNG, valid enough for happy-dom's lightweight decoder to fire a real 'load' with a
// naturalWidth/Height - unlike a real browser, no canvas adapter is configured here (see
// BrowserSettingsFactory's canvasAdapter default), so canvas.getContext('2d') returns null and
// neither automatic detection nor a saved override rect can ever produce cropped pixels. That
// exercises exactly the "official photo exists, but no crop could be made" case: production code
// must show the real photo as-is here, never a generic schematic - the schematic is reserved for
// data.status === 'not_found' (no official photo at all).
const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
test('공식 사진은 있지만 crop을 만들 수 없을 때 원본을 그대로 보여주고, "이미지 없음"과는 구분한다', async t => {
  const { $, window } = setup(t);
  window.fetch = async () => Response.json({ status: 'ok', id: '9', imageData: onePixelPng, source: '시험 출처' });
  // Goes through applyContainerType('pouch', ...) rather than calling loadLiquidPhoto directly, so
  // currentContainerType is set the same way selectLiquid() would set it in production - the guard
  // in loadLiquidPhoto()/renderPhotoOverlay() that blocks anything but 'pouch' (see the bottle tests
  // below) would otherwise silently no-op this call.
  await window.eval("applyContainerType('pouch', {id:'9',name:'시험시럽'})"); await settle();
  // Crop (auto+override) failed, but a real photo exists: show it as-is.
  assert.equal($('#liquidProductPhoto').hidden, false);
  assert.equal($('#liquidProductPhoto').src, onePixelPng);
  assert.ok($('#liquidImageStatus').textContent.includes('전체를 표시합니다'));
  assert.equal($('#usableAdjustment').hidden, false);
  $('[data-fraction="0.3333333333333333"]').click();
  assert.equal($('#photoFractionLine').hidden, false);
  // Top-based: torn open at the top and drunk downward, so 1/3 sits 1/3 of the way DOWN FROM THE TOP.
  assert.equal($('#photoFractionLine').style.top, (6 + (94 - 6) * (1 / 3)) + '%');
  // A saved override rect degrades the same way when canvas still isn't available to draw it -
  // still the real photo.
  window.fetch = async () => Response.json({ status: 'ok', id: '200502778', imageData: onePixelPng, source: '시험 출처' });
  await window.eval("applyContainerType('pouch', {id:'200502778',name:'백초시럽플러스'})"); await settle();
  assert.equal($('#liquidProductPhoto').hidden, false);
  // 공식 사진이 전혀 없으면(not_found) 참고용 도형·분할선·label을 절대 그리지 않는다 - "제품 사진이
  // 없어요" 안내와 촬영/선택 버튼만 보여준다("허공에 뜬 1/2 label" 버그의 재발 방지).
  window.fetch = async () => Response.json({ status: 'not_found', id: '10' });
  await window.eval("applyContainerType('pouch', {id:'10',name:'사진없는시럽'})"); await settle();
  assert.equal($('#liquidPhotoStage').hidden, true, '사진 영역 자체를 렌더링하지 않는다');
  assert.equal($('#photoFractionLine').hidden, true, '분할선을 그리지 않는다');
  assert.equal($('#liquidUploadOwnPrompt').hidden, false, '"제품 사진이 없어요" + 촬영/선택 버튼만 보여준다');
  window.fetch = async () => Response.json({ error: '다시 시도해주세요' }, { status: 502 });
  await window.eval("applyContainerType('pouch', {id:'11',name:'연결오류시럽'})"); await settle();
  assert.equal($('#liquidPhotoStage').hidden, true); assert.equal($('#photoFractionLine').hidden, true);
  assert.equal($('#liquidImageRetry').hidden, false);
});

test('classifyContainerType은 공식 포장단위 문구로 포/병/판단불가를 구분한다', t => {
  const { window } = setup(t);
  assert.equal(window.eval("classifyContainerType('20mL × 30포')"), 'pouch');
  assert.equal(window.eval("classifyContainerType('5mL/스틱 x 10')"), 'pouch');
  assert.equal(window.eval("classifyContainerType('500mL/병')"), 'bottle');
  assert.equal(window.eval("classifyContainerType('100mL/보틀')"), 'bottle');
  assert.equal(window.eval("classifyContainerType('20mL × 30포, 100mL/병')"), 'unknown', '포와 병이 모두 있으면 자동 판정하지 않는다');
  assert.equal(window.eval("classifyContainerType('')"), 'unknown');
  assert.equal(window.eval("classifyContainerType(undefined)"), 'unknown');
});

test('resolveContainerType은 포장단위 문구 다음으로 호일/스틱 포장 문구, 그다음 저장된 override 순으로 확인한다', t => {
  const { window } = setup(t);
  assert.equal(window.eval("resolveContainerType({id:'1', permit:{data:{packaging:'20mL × 30포'}}})"), 'pouch', '포장단위 문구만으로 이미 확정되면 그대로 사용');
  assert.equal(window.eval("resolveContainerType({id:'2', permit:{data:{packaging:'', description:'알루미늄 호일로 포장된 스틱형 제제'}}})"), 'pouch', '포장단위가 비어 있어도 허가정보 문구에 호일/스틱 포장이 명시되면 포로 판정');
  assert.equal(window.eval("resolveContainerType({id:'3', permit:{data:{packaging:'500mL/병', description:'알루미늄 호일 포장'}}})"), 'bottle', '병 문구가 명시되면 호일 언급이 있어도 포로 뒤집지 않는다');
  // 코푸시럽에스(196900058): 실제로는 포장단위 문구만으로 이미 'pouch'로 확정되지만, override도 그 자체로
  // 신뢰할 수 있는 결과를 내도록 보장한다 - 사용자가 매번 포장 형태를 선택하지 않아도 된다.
  assert.equal(window.eval("resolveContainerType({id:'196900058', permit:{data:{packaging:''}}})"), 'pouch', '패키징 문구가 비어 있어도 저장된 override로 확정');
  assert.equal(window.eval("resolveContainerType({id:'999999', permit:{data:{packaging:''}}})"), 'unknown', 'override도 문구도 없으면 여전히 판단불가');
});

test('병 형태 제품은 분할선 기능을 제공하지 않고 계량도구를 안내하며, 계산은 사진 없이 숫자로만 제공한다', async t => {
  const bottle = { ...complete, form: '시럽제', name: '코미시럽', company: '코오롱제약(주)', description: '단맛, 딸기향의 시럽제', permit: { status: 'ok', data: { packaging: '500mL/병' } } };
  const { $, input, window } = setup(t, async () => Response.json(payload([bottle])));
  input('#liquidQuery', '코미시럽'); $('#liquidSearch').dispatchEvent(new window.Event('submit')); await settle();
  $('#liquidResults button').click();
  assert.equal($('#bottleNotice').hidden, false); assert.equal($('#liquidGuide').hidden, true); assert.equal($('#containerTypeChoice').hidden, true);
  // Product header (name/company/flavor/packaging) shows on the bottle screen too, just without
  // any fraction-line machinery - #bottleNotice has no photoFractionLine element at all.
  assert.equal($('#bottleProductName').textContent, '코미시럽'); assert.equal($('#bottleProductCompany').textContent, '코오롱제약(주)');
  assert.equal($('#bottleProductPackaging').textContent, '포장 단위: 500mL/병');
  assert.equal($('#bottleNotice').querySelector('#photoFractionLine, [data-fraction]'), null);
  assert.ok($('#bottleNotice').textContent.includes('⚠ 병 제품은 분할선으로 용량을 확인할 수 없어요'));
  assert.ok($('#bottleNotice').textContent.includes('계량컵'));
  $('#bottleCalcBtn').click();
  assert.equal($('#bottleCalculator').hidden, false); assert.equal($('#bottleNotice').hidden, true);
  // No image anywhere in the bottle calculator - a fraction line can never be drawn on a bottle photo.
  assert.equal($('#bottleCalculator').querySelector('img'), null);
  // 병 제품은 "1회 복용량이 전체의 몇 %"를 먼저 보여준다 - 절반을 먹으라는 뜻으로 보이는 분율 계산은
  // 접힌 "분율로 확인하기" 안에서만 보조로 제공한다.
  input('#bottleVolumeSelect', '500'); input('#bottleDoseMl', '5');
  assert.equal($('#bottleDoseResult').textContent, '총 용량 500 mL 중 1회 복용량 5 mL → 전체의 1%');
  assert.equal($('[data-bottle-fraction]').closest('details').open, false, '분율 선택은 기본적으로 접혀 있다');
  $('[data-bottle-fraction="0.3333333333333333"]').click();
  // [총 용량] × [분율] = [계산된 용량] order, "약" only on a result that actually got rounded.
  assert.equal($('#bottleVolumeResult').textContent, '500 mL × 1/3 = 약 166.7 mL');
  $('[data-bottle-fraction="0.5"]').click();
  assert.equal($('#bottleVolumeResult').textContent, '500 mL × 1/2 = 250 mL');
  assert.ok($('#bottleCalculator').textContent.includes('계량컵이나 경구용 주사기로 실제 용량을 확인하세요'));
});

test('포 제품에서 병 제품으로 바로 전환해도(새 검색 없이) 분율선이 남아있지 않는다', async t => {
  const { $, window } = setup(t);
  window.eval(`
    window.__pouch = { id: '196900058', name: '코푸시럽에스', permit: { data: { packaging: '20mL × 6포' } } };
    window.__bottle = { id: '199800766', name: '코미시럽', permit: { data: { packaging: '500mL/병' } } };
  `);
  // Force the pouch branch into its "photo shown" state without depending on canvas (see the
  // "공식 사진은 있지만 crop을..." test above for why this harness can't exercise the real image
  // pipeline) - directly drive applyPouchCrop's success path via loadLiquidPhoto isn't needed here;
  // selectLiquid() already reaches applyContainerType('pouch', ...) and shows #liquidGuide/#fractions.
  window.eval("selectLiquid(window.__pouch)"); await settle();
  assert.equal($('#liquidGuide').hidden, false);
  window.eval("selectLiquid(window.__bottle)"); await settle();
  assert.equal($('#liquidGuide').hidden, true); assert.equal($('#bottleNotice').hidden, false);
  assert.equal($('#photoFractionLine').hidden, true);
});

test('포장 형태를 자동 판정하지 못하면 사용자에게 선택하게 하고, "잘 모르겠어요"는 안전하게 계량도구 안내로 보낸다', async t => {
  const unknown = { ...complete, form: '시럽제', name: '애매한시럽', permit: { status: 'ok', data: { packaging: '' } } };
  const { $, input, window } = setup(t, async () => Response.json(payload([unknown])));
  input('#liquidQuery', '애매한시럽'); $('#liquidSearch').dispatchEvent(new window.Event('submit')); await settle();
  $('#liquidResults button').click();
  assert.equal($('#containerTypeChoice').hidden, false); assert.equal($('#liquidGuide').hidden, true); assert.equal($('#bottleNotice').hidden, true);
  $('#containerTypeUnsure').click();
  assert.equal($('#bottleNotice').hidden, false); assert.equal($('#containerTypeChoice').hidden, true);
  $('#bottleIsActuallyPouch').click();
  assert.equal($('#liquidGuide').hidden, false); assert.equal($('#bottleNotice').hidden, true);
});

test('건강기능식품처럼 제품 DB에 없는 사진도 업로드해서 분율 가이드를 사용할 수 있다', async t => {
  const { $, window } = setup(t);
  $('#liquidWayUpload').click();
  assert.equal($('#liquidUploadWay').hidden, false); assert.equal($('#liquidSearchWay').hidden, true);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const bin = Buffer.from(png, 'base64');
  await window.eval(`
    const bytes = new Uint8Array([${bin.join(',')}]);
    const file = new File([bytes], 'photo.png', { type: 'image/png' });
    const input = document.querySelector('#uploadFile');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
  `);
  await settle();
  assert.equal($('#uploadGuide').hidden, false);
  // Standalone upload entry point has no product-DB match, so the "확인되지 않았습니다" note must show.
  assert.equal($('#uploadDbNote').hidden, false);
  // No canvas in this harness (see the earlier crop test) - automatic detection cannot run, so the
  // manual region picker must appear instead of silently failing.
  assert.equal($('#uploadCropAdjust').hidden, false);
  assert.equal($('#uploadCropTop').value, '10'); assert.equal($('#uploadCropBottom').value, '90');
  $('#uploadCropLeft').value = '25'; $('#uploadCropLeft').dispatchEvent(new window.Event('input'));
  assert.equal($('#uploadCropBox').style.left, '25%');
});

test('isOralLiquidCandidate는 이름 끝의 "액"만으로는 놓치던 알긴산나트륨류(예: 알지에스액)를 포함하고, 비경구 액상은 계속 제외한다', t => {
  const { window } = setup(t);
  const asItem = (name, description = '') => `{ id: '1', name: ${JSON.stringify(name)}, description: ${JSON.stringify(description)} }`;
  // 실제 API 응답에서 확인한 사례: 이름이 "시럽|현탁액|내복액|내용액|경구용액|경구액" 중 어느 것도 포함하지
  // 않아 기존 정규식이 놓쳤지만, CHART(성상)는 "...점성이 있는 액제"였다.
  assert.equal(window.eval(`isOralLiquidCandidate(${asItem('알지에스액(알긴산나트륨)', '알루미늄 호일 파우치에 들어있는 연한 갈색의 점성이 있는 액제')})`), true);
  assert.equal(window.eval(`isOralLiquidCandidate(${asItem('알지셀액(알긴산나트륨)', '연갈색의 점성이 있는 액제')})`), true);
  assert.equal(window.eval(`isOralLiquidCandidate(${asItem('코미시럽')})`), true, '기존 방식(이름에 "시럽")도 계속 통과해야 한다');
  // 실제 API에서 확인한, 이름에 "액"이 있지만 경구용이 아닌 사례들 - CHART에 "액제/현탁액"이 나와도 제외되어야 한다.
  assert.equal(window.eval(`isOralLiquidCandidate(${asItem('지노클렌질세정액', '황갈색의 액제.')})`), false, '세정액(상처 세정용)은 제외');
  assert.equal(window.eval(`isOralLiquidCandidate(${asItem('아사콜관장액4그람/100밀리리터(메살라진)', '갈색현탁액')})`), false, '관장액은 제외');
  assert.equal(window.eval(`isOralLiquidCandidate(${asItem('벤토린흡입액(살부타몰황산염)', '무색~연한 노란색의 투명한 액제')})`), false, '흡입액은 제외');
  assert.equal(window.eval(`isOralLiquidCandidate(${asItem('나리스타에스점비액')})`), false, '점비액은 제외');
  assert.equal(window.eval(`isOralLiquidCandidate(${asItem('알레크롬점안액(크로모글리크산나트륨)')})`), false, '점안액은 기존대로 제외');
  assert.equal(window.eval(`isOralLiquidCandidate(${asItem('케어가글액(박하향)')})`), false, '가글액은 기존대로 제외');
});

test('포장 형태를 자동 확인하지 못해도 "검색 결과 없음"이 아니라 제품명·제조사·제형·포장단위를 먼저 보여준다', async t => {
  const ambiguous = { ...complete, form: '시럽제', name: '애매한시럽', company: '애매제약', description: '무색투명한 액', permit: { status: 'ok', data: { packaging: '' } } };
  const { $, input, window } = setup(t, async () => Response.json(payload([ambiguous])));
  input('#liquidQuery', '애매한시럽'); $('#liquidSearch').dispatchEvent(new window.Event('submit')); await settle();
  $('#liquidResults button').click();
  assert.equal($('#containerTypeChoice').hidden, false);
  assert.equal($('#containerTypeProductName').textContent, '애매한시럽');
  assert.equal($('#containerTypeProductCompany').textContent, '애매제약');
  assert.ok($('#containerTypeChoice').textContent.includes('포장 형태를 확인해주세요'));
});

test('내 약 보관함: 검색 결과에서 저장·해제하고 localStorage에 itemSeq 기반 구조로 남긴다', async t => {
  const { $, submit, input, window } = setup(t);
  input('#query', '시험약'); await submit();
  const heart = $('#results .save-heart');
  assert.equal(heart.textContent, '♡ 저장'); assert.equal(heart.getAttribute('aria-pressed'), 'false');
  heart.click();
  assert.equal(heart.textContent, '♥ 저장됨'); assert.equal(heart.getAttribute('aria-pressed'), 'true');
  // 검색 결과 카드를 클릭한 것으로 취급되어 제품이 선택되면 안 된다 (하트는 별도 동작).
  assert.equal($('#resultName').textContent, '직접 입력 예시');
  const saved = JSON.parse(window.localStorage.getItem('savedMedicinesV1'));
  assert.equal(saved.length, 1);
  assert.deepEqual(Object.keys(saved[0]).sort(), ['color', 'dosageForm', 'entpName', 'imageUrl', 'itemName', 'itemSeq', 'kind', 'length', 'metadata', 'savedAt', 'shape', 'thickness', 'width'].sort());
  assert.equal(saved[0].itemSeq, '123'); assert.equal(saved[0].itemName, complete.name); assert.equal(saved[0].length, 12); assert.equal(saved[0].width, 10); assert.equal(saved[0].kind, 'pill');
  // 홈의 "최근 확인한 약"과는 완전히 다른 키에 저장된다 - 제품을 선택한 적이 없으니 최근 목록은 비어 있다.
  assert.equal(JSON.parse(window.localStorage.getItem('recentMedicines') || '[]').length, 0);
  heart.click();
  assert.equal(heart.textContent, '♡ 저장'); assert.equal(JSON.parse(window.localStorage.getItem('savedMedicinesV1')).length, 0);
});

test('내 약 보관함 화면: 목록·삭제·2개 이상 선택 시 비교 버튼 활성화', async t => {
  const { $, window } = setup(t);
  window.eval(`
    saveMedicine({ id:'1', name:'텔미암정40/10mg', company:'한화제약', long:12.32, short:6.79, thick:4.14, shape:'타원형', form:'필름코팅정' }, 'pill');
    saveMedicine({ id:'2', name:'탁센400', company:'하나제약', long:16.7, short:9.9, thick:6.1, shape:'장방형', form:'필름코팅정' }, 'pill');
  `);
  $('[data-mode="storage"]').click();
  assert.equal($('#storageTool').hidden, false);
  assert.equal($('#storageCount').textContent, '저장한 약 2개');
  assert.equal($('#storageList').children.length, 2);
  assert.equal($('#storageCompareBtn').disabled, true);
  const checks = [...window.document.querySelectorAll('.storage-check')];
  checks[0].checked = true; checks[0].dispatchEvent(new window.Event('change'));
  assert.equal($('#storageCompareBtn').disabled, true, '1개만 선택하면 아직 비활성');
  checks[1].checked = true; checks[1].dispatchEvent(new window.Event('change'));
  assert.equal($('#storageCompareBtn').disabled, false);
  $('#storageCompareBtn').click();
  assert.equal($('#storageComparison').hidden, false);
  assert.equal($('#storageCompareList').children.length, 2);
  // 삭제는 즉시 목록과 저장소 모두에서 사라진다.
  $('#storageList .storage-card button:last-child').click();
  assert.equal($('#storageList').children.length, 1);
  assert.equal(JSON.parse(window.localStorage.getItem('savedMedicinesV1')).length, 1);
});

test('처방약 확정은 자동 저장하지 않고 상세에서 보관함 저장을 제공한다', async t => {
 const {window,$}=setup(t,async()=>Response.json(payload([{...complete,name:'시험캡슐'}])));
 await window.eval("processRxNames(['시험캡슐'])"); pickRx(window);
 assert.equal(JSON.parse(window.localStorage.getItem('savedMedicinesV1')||'[]').length,0);
 $('#rxDetailDialog .save-heart').click(); assert.equal(JSON.parse(window.localStorage.getItem('savedMedicinesV1')).length,1);
});

// dose-calc.js는 pouch-crop.js와 같은 동적 import 패턴이라 이 테스트 하네스(disableJavaScriptFileLoading)
// 에서는 항상 null이다 - 실제 계산/파싱 정확성은 test/dose-calc.test.js가 순수 함수로 직접 검증하고,
// 여기서는 모듈이 없을 때도 절대 죽지 않고 "추가 정보가 필요합니다" 쪽으로 안전하게 빠지는지만 확인한다.
// 실제 브라우저(동적 import 동작)에서의 범위 계산·bar 렌더링은 실행 후 스크린샷으로 별도 확인했다.
test('처방전 용량 누락은 상세에서 안내하며 비교 막대를 표시하지 않는다', async t => {
 const {window,$}=setup(t); installRx(window,[dailyCapsule]);
 window.__rxTest.getGroups()[0].row.frequencyPerDay=null;
 $('#rxSelectedList .rx-row-button').click(); $('#rxDetailDialog .rx-action-analyze').click(); await settle();
 assert.ok($('#rxDetailDialog').textContent.includes('확인해주세요')); assert.equal($('.rx-daily-bar'),null);
});

test('상세에서 처방 수치를 수정하면 원문과 공식 제품을 유지하며 취소는 변경하지 않는다', async t => {
 const {window,$}=setup(t); installRx(window,[dailyCapsule]);
 const group=window.__rxTest.getGroups()[0]; const original=group.row.rawName;
 $('#rxSelectedList .rx-row-button').click(); $('#rxDetailDialog .rx-action-edit').click();
 const form=$('.rx-prescription-editor'); form.querySelector('[name=frequencyPerDay]').value='3';
 form.dispatchEvent(new window.Event('submit',{cancelable:true})); await settle();
 assert.equal(group.row.frequencyPerDay,3);assert.equal(group.row.rawName,original);assert.equal(group.chosen.item.id,dailyCapsule.id);
 $('#rxDetailDialog .rx-action-edit').click(); $('[name=frequencyPerDay]').value='5'; $('.rx-prescription-editor .rx-detail-actions button').click();
 assert.equal(group.row.frequencyPerDay,3); assert.ok($('#rxSelectedList').textContent.includes('하루 3회'));
});

test('productCode 기반 MFDS 교차검증: 유일한 보험코드 일치 후보를 자동 선택한다', async t => {
  // 공식 API는 item_name/entp_name/item_seq로만 검색 가능하고 보험코드(EDI_CODE) 자체를 검색 조건으로
  // 받지 않는다(docs/mfds-api.md) - 그래서 검색은 여전히 이름 기준이고, 각 결과 후보 자신의
  // insuranceCode를 처방전에서 읽은 productCode와 사후 비교해 강한 매치만 표시한다 (item 5).
  const schema = await import('../public/prescription-schema.js');
  const matching = normalize({ ITEM_SEQ: '900', ITEM_NAME: '가나다정', ENTP_NAME: '가나다제약', EDI_CODE: '644913501' });
  const other = normalize({ ITEM_SEQ: '901', ITEM_NAME: '가나다정 (구법)', ENTP_NAME: '가나다제약', EDI_CODE: '999999999' });
  const { window, $ } = setup(t, async () => Response.json(payload([other, matching], 1, 2)));
  window.__rxTest.setMedSchema(schema);
  window.testRow = schema.clampMedication({ productCode: '644913501', drugName: '가나다정', dosePerAdministration: 1, frequencyPerDay: 1, durationDays: 5, confidence: { productCode: .9, drugName: .9, dose: .9, frequency: .9, duration: .9 } });
  await window.eval('processRxNames([window.testRow])');
  $('#rxSelectedList .rx-row-button').click(); $('#rxDetailDialog .rx-action-product').click();
  assert.equal($('#rxDetailDialog input:checked')?.value, '900');
  assert.equal(window.__rxTest.getGroups()[0].candidates[0].strongMatch, true);
  assert.equal(window.__rxTest.getGroups()[0].candidates[1].strongMatch, false);
  assert.equal($('#rxCandidates .rx-strong-match'), null, 'matching strategy는 일반 UI에 노출하지 않는다');
  assert.equal(window.__rxTest.getGroups()[0].chosen.item.id, '900');
  assert.equal(window.__rxTest.getGroups()[0].matchingStatus, 'exact-code');
});

test('알약 API 장애에도 처방약 상세에서 액체 후보 선택과 가이드 이동이 가능하다', async t => {
 const item={...complete,form:'시럽제',name:'듀파락-이지시럽',permit:{status:'ok',data:{packaging:'15mL/포'}}};
 const {window,$}=setup(t,async path=>path.startsWith('/api/medicines?')?Response.json({error:'실패'},{status:503}):Response.json(payload([item])));
 await window.eval("processRxNames(['듀파락-이지시럽'])"); pickRx(window);
 assert.equal(window.__rxTest.getGroups()[0].chosen.kind,'liquid'); $('#rxDetailDialog .rx-action-size').click();
 assert.equal($('#liquidTool').classList.contains('active'),true);assert.equal($('#pillTool').classList.contains('hidden'),true);
});

test('공식 단일 코드 자동 선택 후 처방 단위·CTA·저장 metadata를 연결한다', async t => {
  const schema = await import('../public/prescription-schema.js');
  const item = { ...complete, form: '경질캡슐', name: '에도스캡슐', insuranceCode: '649401610' };
  const { window, $ } = setup(t, async () => Response.json(payload([item], 1, 1)));
  window.__rxTest.setMedSchema(schema);
  window.med = schema.clampMedication({ productCode: '649401610', rawName: '에도스캡슐/1캡슐', drugName: '에도스캡슐', dosePerAdministration: 1, frequencyPerDay: 2, durationDays: 60 });
  await window.eval('processRxNames([window.med])');
  assert.equal(window.__rxTest.getGroups()[0].matchingStatus, 'exact-code');
  assert.ok($('#rxSelectedList').textContent.includes('1캡슐 · 하루 2회 · 60일'));
  $('#rxSelectedList .rx-row-button').click();
  assert.equal($('#rxDetailDialog .rx-action-size').textContent, '실물 크기');
  $('#rxDetailDialog .save-heart').click();
  const saved = JSON.parse(window.localStorage.getItem('savedMedicinesV1'))[0].metadata;
  assert.equal(saved.productCode, '649401610'); assert.equal(saved.medicineForm, 'solid-oral');
  assert.equal(saved.dosePerAdministration, 1); assert.equal(saved.frequencyPerDay, 2); assert.equal(saved.durationDays, 60);
  assert.equal(saved.doseUnit, '캡슐');
});

test('G: MFDS 전체 실패에도 OCR 네 행과 처방내용·수정 기능을 유지한다', async t => {
  const schema = await import('../public/prescription-schema.js');
  const { window, $ } = setup(t, async () => Response.json({ error: 'upstream' }, { status: 502 }));
  window.__rxTest.setMedSchema(schema);
  window.meds = ['듀파락-이지시럽', '에도스캡슐', '애니코프캡슐300mg', '셀벡스캡슐(내복)'].map((drugName, i) => schema.clampMedication({ drugName, dosePerAdministration: 1, doseUnit: i ? '캡슐' : '포', frequencyPerDay: i ? 2 : 3, durationDays: i ? 60 : 10 }));
  await window.eval('processRxNames(window.meds)');
  assert.equal(window.__rxTest.getGroups().length, 4);
  assert.equal(window.document.querySelectorAll('.rx-document-row').length,4);
  assert.ok($('#rxSelectedList').textContent.includes('1포 · 하루 3회 · 10일'));
  assert.equal($('#rxSelectedList input'),null); assert.equal($('#rxSelectedList details'),null);
  $('#rxSelectedList .rx-row-button').click(); $('#rxDetailDialog .rx-action-edit').click();
  assert.ok($('.rx-prescription-editor'));
});

test('item 14: MFDS 검색이 응답 없이 멈춰도(hang) "공식 제품 후보를 찾고 있습니다…" 상태에 무한정 머무르지 않는다', async t => {
  // Regression for the reported "일부 제품이 pending 상태에 오래 머무른다" symptom: flowSearch's fetch
  // previously had no timeout of its own, only the group's shared AbortController (which nothing ever
  // aborted here) - so a hung upstream response left the card stuck forever. A never-resolving fetch
  // mock reproduces exactly that; setFlowSearchTimeoutMs shrinks the real safety timeout so the test
  // doesn't have to wait out the real 15s value.
  // A real fetch honors `signal` (rejects on abort); a naive mock that just never resolves would make
  // Promise.allSettled() below hang forever regardless of the timeout fix, which isn't what a real hung
  // upstream looks like - so this mock deliberately does what a real implementation does here.
  const { window } = setup(t, (url, init) => new Promise((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  }));
  window.eval('window.__rxTest.setFlowSearchTimeoutMs(20)');
  await window.eval("processRxNames(['텔미암정40/10mg'])");
  await new Promise(resolve => setTimeout(resolve, 150)); // let the real 20ms AbortSignal.timeout fire
  await settle();
  const status = window.__rxTest.getGroups()[0].status;
  assert.notEqual(status, '공식 제품 후보를 찾고 있습니다…', '무기한 대기 상태에 머무르지 않는다');
  assert.ok(/확인이 필요합니다|검색 연결을 확인/.test(status), `대신 실패 상태로 전환되어야 한다: "${status}"`);
});

test('F: 직접 selectMedicine 호출도 bottle을 liquid로 보내고 포장 강제 전환을 차단한다', t => {
  const { window, $ } = setup(t);
  window.bottle = { ...complete, form: '시럽제', name: '시험시럽', permit: { data: { packaging: '500mL/병' } } };
  window.eval('selectMedicine(window.bottle)');
  assert.equal($('#liquidTool').classList.contains('active'), true);
  assert.equal($('#pillTool').classList.contains('hidden'), true);
  assert.equal($('#bottleNotice').hidden, false);
  $('#bottleIsActuallyPouch').click();
  assert.equal($('#liquidGuide').hidden, true);
  assert.equal($('#bottleNotice').hidden, false);
  assert.ok($('#bottleNotice').textContent.includes('계량컵 또는 경구용 주사기'));
});

test('other/unknown 상세 진입은 3D 대신 공통 제품 정보/확인 UI를 연다', t => {
  const { window, $ } = setup(t);
  window.eval("selectMedicine({id:'other',name:'시험연고',form:'연고제'})");
  assert.ok($('#medicineInfoDialog').textContent.includes('의약품 정보'));
  assert.equal($('#resultName').textContent, '직접 입력 예시');
  $('#medicineInfoDialog button').click();
  window.eval("selectMedicine({id:'unknown',name:'시험제품'})");
  assert.ok($('#medicineInfoDialog').textContent.includes('제품 유형 확인 필요'));
});

test('과거 pill로 저장된 시럽도 저장 목록·비교·최근 조회에서 공통 분류로 보호한다', async t => {
  const liquid = { ...complete, form: '시럽제', name: '시험시럽', permit: { data: { packaging: '100mL/병' } } };
  const { window, $ } = setup(t, async path => Response.json(payload(path.startsWith('/api/liquids') ? [liquid] : [], 1, path.startsWith('/api/liquids') ? 1 : 0)));
  window.localStorage.setItem('savedMedicinesV1', JSON.stringify([{ itemSeq: liquid.id, itemName: liquid.name, dosageForm: '시럽제', kind: 'pill', length: 12, width: 8, thickness: 4 }]));
  window.eval('renderStorageList()'); assert.equal($('#storageList input').disabled, true);
  $('#storageList .flow-actions button').click(); await settle();
  assert.equal($('#liquidTool').classList.contains('active'), true);
  await window.eval("openRecent('123')");
  assert.equal($('#liquidTool').classList.contains('active'), true);
  assert.equal($('#pillTool').classList.contains('hidden'), true);
});

// Deterministic DOB fixture: "yesterday" turned N years old, computed relative to the real clock so
// this stays correct no matter when the suite runs (never hardcode an absolute "오늘" date).
function isoDate(d) { return d.toISOString().slice(0, 10); }
function dobForAge(years) {
  const today = new Date();
  return isoDate(new Date(today.getFullYear() - years, today.getMonth(), today.getDate() - 1));
}
function fakeAccessToken(sub) { return `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`; }
const FAKE_CONFIG = { supabaseUrl: 'https://proj.supabase.co', anonKey: 'anon-key' };

// Regression: initAuth() previously closed the gate (showed home) whenever /api/auth/config had no
// anon key configured yet, or the auth module/network failed for any other reason - "session 없음"
// must always mean the login screen, with no fallback/dev-mode bypass. In this harness, real
// initAuth() (manualAuth:false, i.e. the actual production code path) always hits its own catch{}
// branch because happy-dom's disableJavaScriptFileLoading makes dynamic import('./auth.js') fail -
// which is exactly the "auth unavailable" case this test needs, without any extra mocking.
test('로그인 게이트: 로그인 설정을 확인할 수 없을 때도(auth 모듈/설정 실패) 홈으로 넘어가지 않고 로그인 화면에 머무른다', async t => {
  const { window, $ } = setup(t, undefined, { skipAuthGate: false, manualAuth: false });
  await settle();
  assert.equal($('#screenHome').hidden, true, 'auth 설정/모듈을 확인할 수 없어도 홈으로 넘어가지 않는다');
  assert.equal($('#screenLogin').hidden, false);
  assert.equal(window.__rxTest.getAuthGateOpen(), true);
  assert.ok($('#loginStatus').textContent.length > 0, '무슨 일이 있었는지 상태 메시지를 남긴다');
});

test('로그인 게이트: 비로그인 사용자는 로그인 화면부터 보고, 게이트가 열려 있는 동안 nav로 다른 화면에 접근할 수 없다', t => {
  const { window, $ } = setup(t, undefined, { skipAuthGate: false, manualAuth: true });
  assert.equal($('#screenLogin').hidden, false, '초기 동기 렌더는 곧바로 로그인 화면이다 (home이 잠깐 보이지 않는다)');
  assert.equal($('#screenHome').hidden, true);
  assert.equal(window.document.body.classList.contains('gate-active'), true);
  assert.ok($('#loginProviders').children.length === 0, 'auth 모듈이 아직 없으면 provider 버튼도 아직 없다');
  const next = window.__rxTest.applyAuthResolution(auth, null, null);
  assert.equal(next, 'login');
  assert.equal(window.__rxTest.getAuthGateOpen(), true);
  $('[data-mode="home"]').click();
  assert.equal($('#screenHome').hidden, true, '게이트가 열려 있으면 nav를 눌러도 다른 화면으로 갈 수 없다');
  assert.equal($('#screenLogin').hidden, false);
});

test('로그인 게이트: 로그인했지만 프로필이 없으면 온보딩 화면부터 보여주고, 저장 전에는 홈으로 넘어갈 수 없다', t => {
  const { window, $ } = setup(t, undefined, { skipAuthGate: false, manualAuth: true });
  const session = { accessToken: fakeAccessToken('user-1'), refreshToken: 'r1', expiresAt: Date.now() + 3600_000 };
  const next = window.__rxTest.applyAuthResolution(auth, session, null, FAKE_CONFIG);
  assert.equal(next, 'consent-onboarding');
  assert.equal($('#screenConsent').hidden, false);
  assert.equal($('#screenProfile').hidden, true);
  assert.equal($('#consentNext').disabled, true);
  assert.equal(window.__rxTest.getAuthGateOpen(), true);
  $('[data-mode="home"]').click();
  assert.equal($('#screenHome').hidden, true, '온보딩을 마치기 전에는 홈으로 넘어갈 수 없다');
});

test('프로필 저장: 체중은 0 이하/비현실적으로 큰 값을 거부하고, 저장하면 홈으로 전환되며 생년월일·체중이 dose analysis에 바로 연결된다', async t => {
  const consent = publishTestDocuments(t);
  const savedRows = [];
  const { window, $ } = setup(t, async (url, init) => {
    if (String(url).includes('/rest/v1/profiles') && init?.method === 'POST') {
      const row = JSON.parse(init.body)[0]; savedRows.push(row); return Response.json([row]);
    }
    return Response.json(payload());
  }, { skipAuthGate: false, manualAuth: true });
  const session = { accessToken: fakeAccessToken('user-1'), refreshToken: 'r1', expiresAt: Date.now() + 3600_000 };
  window.__rxTest.applyAuthResolution(auth, session, null, FAKE_CONFIG, consent);

  const submit = async () => { $('#profileForm').dispatchEvent(new window.Event('submit', { cancelable: true })); await settle(); };
  $('#profileWeight').value = '-5'; $('#profileWeight').dispatchEvent(new window.Event('input')); await submit();
  assert.ok($('#profileStatus').textContent.includes('0보다 크고'));
  assert.equal(window.__rxTest.getAuthGateOpen(), true, '유효성 검사에 실패하면 온보딩에 머문다');
  assert.equal(savedRows.length, 0);

  $('#profileWeight').value = '9999'; $('#profileWeight').dispatchEvent(new window.Event('input')); await submit();
  assert.ok($('#profileStatus').textContent.includes('0보다 크고'), '비현실적으로 큰 값도 거부한다');
  assert.equal(savedRows.length, 0);

  $('#profileBirthDate').value = dobForAge(32); $('#profileBirthDate').dispatchEvent(new window.Event('input'));
  $('#profileWeight').value = '77'; $('#profileWeight').dispatchEvent(new window.Event('input'));
  await submit();

  assert.equal(savedRows.length, 1);
  assert.equal(savedRows[0].user_id, 'user-1');
  assert.equal(savedRows[0].weight_kg, 77);
  assert.equal(window.__rxTest.getAuthGateOpen(), false, '저장에 성공하면 게이트가 닫히고 홈으로 넘어간다');
  assert.equal($('#screenHome').hidden, false);
  assert.equal(window.__rxTest.getPatientWeightKg(), 77, '프로필 체중이 곧바로 dose analysis 변수로 연결된다');
  assert.equal(window.__rxTest.getPatientAgeYears(), 32, '프로필 생년월일에서 계산한 만 나이가 곧바로 연결된다');
});

test('프로필 완료 상태: 처방전 화면에는 예전 환자정보 입력 대신 프로필 요약·수정 버튼만 있고, 수정 후 원래 화면으로 돌아온다', t => {
  const { window, $ } = setup(t, undefined, { skipAuthGate: false, manualAuth: true });
  const session = { accessToken: fakeAccessToken('user-2'), refreshToken: 'r2', expiresAt: Date.now() + 3600_000 };
  const profile = { user_id: 'user-2', birth_date: dobForAge(32), sex: 'male', weight_kg: 77 };
  assert.equal(window.__rxTest.applyAuthResolution(auth, session, profile, FAKE_CONFIG), 'home');

  $('[data-mode="prescription"]').click();
  assert.equal($('#rxPatientInfo'), null, '예전 생년월일/나이/체중 입력 UI는 더 이상 존재하지 않는다');
  assert.equal($('#rxAgeModeDob'), null); assert.equal($('#rxPatientWeight'), null);
  assert.ok($('#rxProfileSummaryText').textContent.includes('만 32세'));
  assert.ok($('#rxProfileSummaryText').textContent.includes('77kg'));

  $('#rxProfileEditBtn').click();
  assert.equal($('#screenProfile').hidden, false);
  assert.equal($('#profileBackBtn').hidden, false, '프로필 수정에는 뒤로가기가 있다 (온보딩과 다름)');
  assert.equal($('#profileBirthDate').value, profile.birth_date);
  $('#profileBackBtn').click();
  assert.equal($('#prescriptionTool').hidden, false, '뒤로가기는 원래 있던 화면(처방전)으로 돌아온다');
});

test('로그아웃: 세션을 지우고 로그인 화면으로 돌아가며, 프로필 기반 나이·체중도 함께 초기화된다', async t => {
  const { window, $ } = setup(t, async () => Response.json({}), { skipAuthGate: false, manualAuth: true });
  const session = { accessToken: fakeAccessToken('user-3'), refreshToken: 'r3', expiresAt: Date.now() + 3600_000 };
  const profile = { user_id: 'user-3', birth_date: dobForAge(40), sex: 'female', weight_kg: 60 };
  window.__rxTest.applyAuthResolution(auth, session, profile, FAKE_CONFIG);
  assert.equal(window.__rxTest.getPatientAgeYears(), 40);

  $('[data-mode="settings"]').click();
  assert.equal($('#screenSettings').hidden, false);
  $('#settingsLogoutRow').click(); await settle();

  assert.equal(window.__rxTest.getAuthGateOpen(), true);
  assert.equal($('#screenLogin').hidden, false);
  assert.equal(window.__rxTest.getPatientAgeYears(), null);
  assert.equal(window.__rxTest.getPatientWeightKg(), null);
});

// --- 처방전 저장/다시 보기 (요청 1) -----------------------------------------------------------------
function authedHome(t, fetcher, sub = 'user-9') {
  const { window, $ } = setup(t, fetcher, { skipAuthGate: false, manualAuth: true });
  const session = { accessToken: fakeAccessToken(sub), refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
  const profile = { user_id: sub, birth_date: dobForAge(30), sex: 'male', weight_kg: 70 };
  window.__rxTest.applyAuthResolution(auth, session, profile, FAKE_CONFIG);
  window.__rxTest.setPrescriptionsApi(prescriptions);
  return { window, $ };
}

test('처방전 저장: 원본 이미지·OCR 전체 문장 없이 구조화된 항목만 저장하고 상태를 안내한다', async t => {
  const item = { ...complete, name: '에도스캡슐' };
  const writes = [];
  const { window, $ } = authedHome(t, async (url, init) => {
    const u = new URL(url, 'https://size-pill.example');
    if (u.pathname === '/rest/v1/prescriptions' && init?.method === 'POST') {
      const body = JSON.parse(init.body)[0]; writes.push(['prescriptions', body]);
      return Response.json([{ id: 'p1', label: body.label, created_at: '2026-09-14T00:00:00Z' }]);
    }
    if (u.pathname === '/rest/v1/prescription_items' && init?.method === 'POST') { writes.push(['items', JSON.parse(init.body)]); return new Response(null, { status: 201 }); }
    return Response.json(payload([item]));
  });
  $('[data-mode="prescription"]').click();
  await window.eval("processRxNames(['에도스캡슐'])");
  pickRx(window); $('#rxDetailDialog .rx-detail-close').click();
  $('#rxSavePrescription').click(); await settle();
  assert.equal($('#rxSaveStatus').textContent, '처방전을 저장했습니다.');
  assert.equal(writes[0][0], 'prescriptions'); assert.equal(writes[0][1].label, '에도스캡슐'); assert.equal(writes[0][1].user_id, 'user-9');
  const [, itemRows] = writes[1];
  assert.equal(itemRows.length, 1);
  assert.equal(itemRows[0].drug_name, '에도스캡슐'); assert.equal(itemRows[0].item_seq, '123'); assert.equal(itemRows[0].kind, 'pill');
  const serialized = JSON.stringify(itemRows);
  assert.ok(!serialized.includes('imageUrl') && !/raw.?text|ocr.?text/i.test(serialized), '원본 이미지·OCR 전체 문장은 저장 요청에 없다');
});

test('처방전 저장: 로그인하지 않았거나 항목이 없으면 저장을 시도하지 않는다', async t => {
  const { window, $ } = setup(t, async () => Response.json(payload()));
  $('#rxSavePrescription').click(); await settle();
  assert.equal($('#rxSaveStatus').textContent, '로그인 후 저장할 수 있습니다.');
});

test('저장된 처방전 목록·다시 보기: 목록을 열면 저장된 처방전이 보이고, "다시 보기"는 항목을 복원하되 처방전 OCR(vision) 엔드포인트는 절대 다시 호출하지 않는다', async t => {
  const schema = await import('../public/prescription-schema.js');
  const item = { ...complete, name: '에도스캡슐', id: '123' };
  const calls = [];
  const { window, $ } = authedHome(t, async (url) => {
    const u = new URL(url, 'https://size-pill.example');
    calls.push(u.pathname);
    if (u.pathname === '/rest/v1/prescriptions') return Response.json([{ id: 'p1', label: '에도스캡슐', created_at: '2026-09-14T00:00:00Z' }]);
    if (u.pathname === '/rest/v1/prescription_items') return Response.json([{ id: 'i1', drug_name: '에도스캡슐', raw_name: '에도스캡슐', item_seq: '123', kind: 'pill', dose_amount: 1, dose_unit: '캡슐', frequency_per_day: 2, duration_days: 60, needs_review: false }]);
    return Response.json(payload([item]));
  });
  window.__rxTest.setMedSchema(schema);
  $('[data-mode="prescription"]').click();
  await settle();
  assert.ok($('#rxRecentList').textContent.includes('에도스캡슐'));
  $('#rxRecentList .flow-actions button').click(); await settle();
  assert.equal(window.__rxTest.getGroups().length, 1);
  assert.equal(window.__rxTest.getGroups()[0].chosen.item.id, '123');
  assert.equal(window.__rxTest.getGroups()[0].chosen.kind, 'pill');
  assert.equal(window.__rxTest.getGroups()[0].row.dosePerAdministration, 1);
  assert.equal(window.__rxTest.getGroups()[0].row.frequencyPerDay, 2);
  assert.equal($('#prescriptionTool').hidden, false);
  assert.ok(!calls.includes('/api/prescription/extract'), 'Google Vision OCR 엔드포인트를 호출하지 않는다');
});

test('저장된 처방전 다시 보기: 공식 제품을 다시 찾지 못해도 항목은 남고 직접 선택하도록 안내한다', async t => {
  const schema = await import('../public/prescription-schema.js');
  const { window, $ } = authedHome(t, async (url) => {
    const u = new URL(url, 'https://size-pill.example');
    if (u.pathname === '/rest/v1/prescriptions') return Response.json([{ id: 'p1', label: '시험약', created_at: '2026-09-14T00:00:00Z' }]);
    if (u.pathname === '/rest/v1/prescription_items') return Response.json([{ id: 'i1', drug_name: '시험약', raw_name: '시험약', item_seq: '999', kind: 'pill', dose_amount: 1, dose_unit: '정', frequency_per_day: 1, duration_days: 5, needs_review: false }]);
    return Response.json({ error: 'upstream' }, { status: 502 });
  });
  window.__rxTest.setMedSchema(schema);
  $('[data-mode="prescription"]').click();
  await window.eval('reopenPrescription("p1")'); await settle();
  assert.equal(window.__rxTest.getGroups().length, 1);
  assert.equal(window.__rxTest.getGroups()[0].chosen, null);
  assert.ok(window.__rxTest.getGroups()[0].status.includes('제품을 직접 선택'));
});

test('저장된 처방전 목록: 삭제하면 목록에서 사라진다', async t => {
  let deleted = false;
  const rows = [{ id: 'p1', label: '시험약', created_at: '2026-09-14T00:00:00Z' }];
  const { window, $ } = authedHome(t, async (url, init) => {
    const u = new URL(url, 'https://size-pill.example');
    if (u.pathname === '/rest/v1/prescriptions' && init?.method === 'DELETE') { deleted = true; rows.length = 0; return new Response(null, { status: 204 }); }
    if (u.pathname === '/rest/v1/prescriptions') return Response.json(rows);
    return Response.json(payload());
  });
  $('[data-mode="prescription"]').click();
  await settle();
  assert.ok($('#rxRecentList').textContent.includes('시험약'));
  $('#rxRecentList .flow-actions button:last-child').click(); await settle();
  assert.equal(deleted, true);
  assert.ok(!$('#rxRecentList').textContent.includes('시험약'));
});

// 실제 재현된 버그의 end-to-end 회귀: 에도스캡슐(에르도스테인) 처방 - 공식 용법·용량이 "1회 1캡슐
// (300 mg)씩"처럼 정/캡슐 개수 뒤 괄호 안에 mg를 적는 문장이고, 허가사항 자체에 범위가 없는(정확히
// 300mg) 고정 용량이라 "현재 정보만으로는 비교할 수 없습니다"로 끝나던 화면이 실제로 고쳐졌는지
// 렌더링 결과로 확인한다(단위 함수만이 아니라).










test('검색 null 항목·잘못된 캐시 데이터에도 화면을 유지하고 재시도할 수 있다', async t => {
  let fail = true;
  const { window, $, input, submit } = setup(t, async () => fail ? Response.json({ error: '일시 오류' }, { status: 503 }) : Response.json(payload([null, complete])));
  window.localStorage.setItem('recentMedicines', '{"invalid":true}');
  window.eval('renderRecents()');
  input('#query', '시험약'); await submit();
  assert.equal($('#results .empty-state button').textContent, '다시 시도');
  fail = false; $('#results .empty-state button').click(); await settle();
  assert.equal($('#results .result').textContent.includes('시험약'), true);
  assert.equal($('#results').hasAttribute('aria-busy'), false);
});

test('산제에 치수와 모양이 남아 있어도 알약 3D로 전환하지 않는다', async t => {
  const powder = { ...complete, name: '시험산제', form: '산제', permit: { data: { packaging: '1g/포' } } };
  const { window, $, input, submit } = setup(t, async () => Response.json(payload([powder])));
  input('#query', '시험산제'); await submit(); $('#results .result').click();
  assert.equal($('#pillTool').classList.contains('hidden'), true);
  assert.equal($('#liquidTool').classList.contains('active'), true);
  assert.equal(window.MedicineFlow.classifyMedicineForm(null), 'unknown');
  assert.equal(window.MedicineFlow.classifyDisplayForm(undefined), 'other');
});

test('처방전 삭제 실패는 기록을 유지하고 사용자에게 오류를 알린다', async t => {
  const { window, $ } = authedHome(t, async (url, init) => {
    if (init?.method === 'DELETE') return Response.json({ message: 'unavailable' }, { status: 503 });
    return Response.json([{ id: 'p1', label: '시험약', created_at: 'invalid-date' }]);
  });
  $('[data-mode="prescription"]').click(); await settle();
  assert.ok($('#rxRecentList').textContent.includes('날짜 정보 없음'));
  $('#rxRecentList .btn-danger').click(); await settle();
  assert.ok($('#uiToast').textContent.includes('삭제하지 못했습니다'));
  assert.ok($('#rxRecentList').textContent.includes('시험약'));
  assert.equal($('#rxRecentList .btn-danger').disabled, false);
});


test('처방전 회귀: 네 줄 목록 → 한 약 상세 → 하루 용량 비교 → 상세 → 원래 목록', async t => {
 const {window,$}=setup(t); installRx(window,Array.from({length:4},(_,i)=>({...dailyCapsule,id:String(i+1),name:i===1?dailyCapsule.name:'시험약 '+i})));
 assert.equal($('#rxSelectedList').children.length,4); assert.equal($('#rxSelectedList details'),null); assert.equal($('#rxSelectedList .rx-action-analyze'),null);
 window.document.querySelectorAll('#rxSelectedList .rx-row-button')[1].click();
 assert.equal($('#rxDetailDialog .rx-detail-name').textContent.includes('에도스'),true);
 $('#rxDetailDialog .rx-action-analyze').click(); await settle();
 assert.equal($('.rx-daily-total').textContent,'600 mg/일');assert.ok($('.rx-daily-verdict.within'));
 assert.equal($('.rx-daily-marker').style.left,'0%');assert.equal($('.rx-daily-evidence').open,false);
 assert.ok($('.rx-daily-evidence').textContent.includes('300mg/캡슐'));
 $('#rxDetailDialog .rx-detail-back').click(); assert.ok($('#rxDetailDialog .rx-action-edit'));
 $('#rxDetailDialog .rx-detail-back').click(); assert.equal($('#rxDetailDialog').open,false); assert.equal($('#rxSelectedList').children.length,4);
});

test('하루 용량 비교 화면: 아래·경계·중간·위와 정확한 마커 좌표', async t => {
 const {window,$}=setup(t);
 for(const [amount,status,left] of [[.5,'below',0],[1,'within',0],[1.25,'within',50],[1.5,'within',100],[2,'above',100]]) {
  installRx(window,[dailyCapsule],amount); $('#rxSelectedList .rx-row-button').click(); $('#rxDetailDialog .rx-action-analyze').click(); await settle();
  assert.ok($('.rx-daily-verdict.'+status));assert.equal(parseFloat($('.rx-daily-marker').style.left),left);
 }
});

test('공식 원문 있음·정보 없음·조회 실패를 구분하고 현재 하루 총량은 유지한다', async t => {
 const {window,$}=setup(t,async()=>Response.json({error:'실패'},{status:503}));
 for(const [usage,status,message] of [['초기 및 유지용량을 조절한다.','ok','자동 비교가 어려워요'],['','unmatched','공식 용법·용량 정보가 없어요'],['','error','공식 정보를 불러오지 못했어요']]) {
  installRx(window,[{...dailyCapsule,easy:{status,data:{usage}}}]);$('#rxSelectedList .rx-row-button').click();$('#rxDetailDialog .rx-action-analyze').click();await settle();
  assert.equal($('.rx-daily-total').textContent,'600 mg/일');assert.ok($('#rxDetailDialog').textContent.includes(message));assert.equal($('.rx-daily-bar'),null);
 }
});

// Only test fixtures publish documents; production remains blocked until reviewed URLs exist.
function publishTestDocuments(t) {
  const original = structuredClone(auth.CONSENT_DOCUMENTS);
  for (const [key, doc] of Object.entries(auth.CONSENT_DOCUMENTS)) Object.assign(doc, { version: 'test-v1', url: `/test-policies/${key}` });
  t.after(() => { for (const key of Object.keys(original)) Object.assign(auth.CONSENT_DOCUMENTS[key], original[key]); });
  return { terms: { accepted: true, version: 'test-v1' }, privacy: { accepted: true, version: 'test-v1' }, marketing: { accepted: false, version: 'test-v1' } };
}
test('신규 가입: 필수 동의 → 기존 프로필 입력 → 홈, 선택 거절 저장, 재로그인은 동의 생략', async t => {
  publishTestDocuments(t);
  const calls = [];
  const { window, $ } = setup(t, async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith('/auth/v1/user')) return Response.json({ user_metadata: JSON.parse(init.body).data });
    if (String(url).includes('/rest/v1/profiles')) return Response.json(JSON.parse(init.body));
    return Response.json({});
  }, { skipAuthGate: false, manualAuth: true });
  const session = { accessToken: fakeAccessToken('new-user') };
  window.__rxTest.applyAuthResolution(auth, session, null, FAKE_CONFIG);
  assert.equal($('#consentNext').disabled, true);
  $('#consentAll').click();
  assert.equal($('#consentMarketing').checked, true);
  $('#consentMarketing').click();
  assert.equal($('#consentAll').indeterminate, true);
  assert.equal($('#consentNext').disabled, false);
  $('#consentForm').dispatchEvent(new window.Event('submit', { cancelable: true })); await settle();
  assert.equal($('#screenProfile').hidden, false);
  assert.equal($('#profileSave').textContent, '시작하기');
  assert.equal($('#profileBirthDate').value, '');
  $('#profileForm').dispatchEvent(new window.Event('submit', { cancelable: true })); await settle();
  assert.equal($('#screenHome').hidden, false);
  assert.equal(calls.filter(url => url.includes('/auth/v1/user')).length, 1);
  assert.equal(calls.filter(url => url.includes('/rest/v1/profiles')).length, 1);
  assert.equal(window.__rxTest.getCurrentProfile().user_id, 'new-user');
  window.__rxTest.applyAuthResolution(auth, session, { user_id: 'new-user' }, FAKE_CONFIG);
  assert.equal($('#screenHome').hidden, false);
});
test('동의 저장 실패 시 입력 유지 및 재시도, 프로필 제출로 동의를 건너뛸 수 없다', async t => {
  publishTestDocuments(t);
  const { window, $ } = setup(t, async () => new Response(null, { status: 503 }), { skipAuthGate: false, manualAuth: true });
  window.__rxTest.applyAuthResolution(auth, { accessToken: fakeAccessToken('me') }, null, FAKE_CONFIG);
  $('#consentAll').click();
  $('#consentForm').dispatchEvent(new window.Event('submit', { cancelable: true })); await settle();
  assert.equal($('#screenConsent').hidden, false);
  assert.equal($('#consentTerms').checked, true);
  assert.equal($('#consentNext').disabled, false);
  assert.match($('#consentStatus').textContent, /저장하지 못/);
  $('#profileForm').dispatchEvent(new window.Event('submit', { cancelable: true })); await settle();
  assert.equal($('#screenConsent').hidden, false);
  assert.equal($('#screenHome').hidden, true);
});
