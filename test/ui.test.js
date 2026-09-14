import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { Window } from 'happy-dom';
import { normalize } from '../src/worker.js';
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const medicineFlowScript = await readFile(new URL('../public/medicine-flow.js', import.meta.url), 'utf8');
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
  window.eval(medicineFlowScript);
  window.eval(script + '\nwindow.__rxTest = { setMedSchema(value) { medSchema = value; }, getGroups() { return rxGroups; } };');
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

test('연질캡슐처럼 공식 문구에 맛/향이 전혀 없으면 겉보기 색만으로 추정하지 않고 배지를 숨긴다', async t => {
  // 실제 탁센400이부프로펜연질캡슐 데이터 형태: 반투명한 파란 캡슐이지만 CHART/성상 어디에도 맛/향 문구가 없다.
  const softCapsule = normalize({ ITEM_SEQ: '333', ITEM_NAME: '탁센400이부프로펜연질캡슐', ENTP_NAME: '시험회사', DRUG_SHAPE: '타원형', LENG_LONG: '16.7', LENG_SHORT: '9.9', THICK: '9.9', COLOR_CLASS1: '파랑, 투명', CHART: '무색 내지 엷은 청색의 액상 내용물이든 청색의 투명한 타원형 연질캡슐' });
  const { $, input, submit } = setup(t, async () => Response.json(payload([softCapsule])));
  input('#query', '시험약'); await submit(); $('#results button').click();
  assert.equal($('#flavorBadge').hidden, true, '색상만으로 맛을 추정해 배지를 보여주면 안 된다');
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
  assert.equal($('#flavorBadge').hidden, true, '맛/향 정보가 없으면 "미제공"이 아니라 배지 자체를 숨긴다');
  $('#results').children[2].click(); // bare: 정말 아무 요약 정보도 없는 제품
  assert.equal($('#quickFacts').hidden, true);
  assert.equal($('#flavorBadge').hidden, true);
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

test('상세정보와 치수 직접 입력은 접힌 아코디언 안에 있고, API 치수가 없으면 직접입력이 기본으로 펼쳐진다', async t => {
  const { $, input, submit } = setup(t, async () => Response.json(payload([complete, missing])));
  input('#query', '시험약'); await submit();
  $('#results').children[0].click(); // complete: 치수 전부 있음
  assert.equal($('#detailsAccordion').hidden, false);
  assert.equal($('#detailsAccordion').open, false, '상세정보는 기본적으로 접혀 있어야 한다');
  assert.equal($('#manualEntryDetails').open, false, '치수가 API로 채워졌으면 직접입력은 기본적으로 접힌다');
  // Core identity facts stay fully present in the DOM (readable via textContent) even though the
  // accordion around them starts closed - <details> without `open` never sets the `hidden`
  // attribute, so this still holds exactly like before this screen was reorganized into accordions.
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
  assert.equal($('#view3d').hidden, false, '3D 뷰는 항상 보인다');
  // After selecting a real product.
  input('#query', '시험약'); await submit(); $('#results button').click();
  assert.equal($('#view2d'), null); assert.equal($('#view3d').hidden, false);
  // After manual entry.
  $('#manual').click();
  assert.equal($('#view2d'), null); assert.equal($('#view3d').hidden, false);
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

test('처방전은 textarea 없이 항목별 단일 후보를 확정하고 검색으로 추가·수정·삭제한다', async t => {
  const a = { ...complete, name: '텔미암정40/10mg' }, b = { ...complete, id: '124', name: '텔미암정40/5mg', long: 18 };
  const { $, window, input, submit } = setup(t, async () => Response.json(payload([b, a])));
  $('[data-mode="prescription"]').click(); assert.equal($('#prescriptionTool textarea'), null);
  await window.eval("processRxNames(['텔미암 40/1O'])");
  assert.equal($('#rxCandidates input').type, 'radio'); assert.equal($('#rxCandidates input').checked, false); assert.equal($('#rxCompare').disabled, true);
  const checks = [...window.document.querySelectorAll('#rxCandidates input')];
  checks[0].checked = true; checks[0].dispatchEvent(new window.Event('change')); $('#rxCandidates .flow-actions button').click();
  assert.equal($('#rxSelectedList').children.length, 1); assert.ok($('#rxSelectedList').textContent.includes(a.name));
  $('#rxAdd').click(); assert.equal($('#rxSearchContext').hidden, false); input('#query', '텔미암'); await submit(); $('#results button').click();
  assert.equal($('#prescriptionTool').hidden, false); assert.equal($('#rxSelectedList').children.length, 2);
  $('#rxCompare').click(); assert.equal($('#rxCompareList').children.length, 2);
  $('#rxSelectedList button').click(); assert.equal($('#resultName').textContent, a.name); assert.equal($('#pillTool').dataset.step, 'result');
  $('[data-mode="prescription"]').click(); $('#rxSelectedList .flow-actions button:last-child').click(); assert.equal($('#rxSelectedList').children.length, 1);
  $('#rxCandidates .flow-actions button:last-child').click(); input('#query', '텔미암'); await submit(); $('#results button').click();
  assert.equal($('#rxSelectedList').children.length, 1, '같은 공식 품목은 중복 저장하지 않는다');
  $('#rxClear').click(); assert.equal($('#rxCandidates').children.length, 0); assert.equal($('#rxSelectedList').children.length, 0);
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

test('처방약 비교 화면에서도 액체약 카드는 알약 3D가 아니라 액체 화면으로 이동한다', async t => {
  // Regression for item 1/2/9: #rxCompare built every card's onclick around selectMedicine()
  // unconditionally, so a liquid item chosen in the prescription flow still opened the pill 3D view
  // once it reached the compare list, even though its own selection correctly recorded kind:'liquid'.
  const pill = { ...complete, name: '텔미암정40/10mg' };
  const liquidItem = { ...complete, form: '시럽제', id: '999', name: '듀파락-이지시럽', description: '경구용 시럽제', permit: { status: 'ok', data: { packaging: '15mL × 30포' } } };
  const { $, window } = setup(t, async path => {
    const term = new URL(path, 'http://x').searchParams.get('item_name') || '';
    return Response.json(payload(term.includes('듀파락') ? [liquidItem] : [pill], 1, 1));
  });
  await window.eval("processRxNames(['텔미암정40/10mg'])");
  window.document.querySelector('#rxCandidates input').checked = true;
  window.document.querySelector('#rxCandidates input').dispatchEvent(new window.Event('change'));
  window.document.querySelector('#rxCandidates .flow-actions button').click();
  await window.eval("processRxNames(['듀파락-이지시럽'])");
  const groups = window.document.querySelectorAll('.rx-group');
  const secondRadio = groups[groups.length - 1].querySelector('input');
  secondRadio.checked = true; secondRadio.dispatchEvent(new window.Event('change'));
  groups[groups.length - 1].querySelector('.flow-actions button').click();
  assert.equal(window.__rxTest.getGroups().at(-1).chosen.kind, 'liquid');
  $('#rxCompare').click();
  assert.equal($('#rxCompareList').children.length, 2);
  [...$('#rxCompareList').children].find(b => b.textContent.includes('듀파락')).click();
  assert.equal($('#liquidTool').classList.contains('active'), true);
  assert.equal($('#pillTool').classList.contains('hidden'), true);
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
  assert.ok($('#liquidGuide').textContent.includes('대략적인 분할 위치를 확인하기 위한 시각적 가이드'));
  assert.equal($('#cameraAdvanced').open, false);
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
  // Crop (auto+override) failed, but a real photo exists: show it as-is, not the generic schematic.
  assert.equal($('#liquidProductPhoto').hidden, false); assert.equal($('#liquidFallback').hidden, true);
  assert.equal($('#liquidProductPhoto').src, onePixelPng);
  assert.ok($('#liquidImageStatus').textContent.includes('전체를 표시합니다'));
  assert.equal($('#usableAdjustment').hidden, false);
  $('[data-fraction="0.3333333333333333"]').click();
  assert.equal($('#photoFractionLine').hidden, false);
  // Top-based: torn open at the top and drunk downward, so 1/3 sits 1/3 of the way DOWN FROM THE TOP.
  assert.equal($('#photoFractionLine').style.top, (6 + (94 - 6) * (1 / 3)) + '%');
  // A saved override rect degrades the same way when canvas still isn't available to draw it -
  // still the real photo, never the schematic.
  window.fetch = async () => Response.json({ status: 'ok', id: '200502778', imageData: onePixelPng, source: '시험 출처' });
  await window.eval("applyContainerType('pouch', {id:'200502778',name:'백초시럽플러스'})"); await settle();
  assert.equal($('#liquidProductPhoto').hidden, false); assert.equal($('#liquidFallback').hidden, true);
  window.fetch = async () => Response.json({ status: 'not_found', id: '10' });
  await window.eval("applyContainerType('pouch', {id:'10',name:'사진없는시럽'})"); await settle();
  assert.equal($('#liquidFallback').hidden, false); assert.ok($('#liquidImageStatus').textContent.includes('공식 포장 사진이 없어'));
  // No official photo at all: offer the user's own photo as an alternative way into the fraction guide.
  assert.equal($('#liquidUploadOwnPrompt').hidden, false);
  window.fetch = async () => Response.json({ error: '다시 시도해주세요' }, { status: 502 });
  await window.eval("applyContainerType('pouch', {id:'11',name:'연결오류시럽'})"); await settle();
  assert.equal($('#liquidFallback').hidden, true); assert.equal($('#liquidImageRetry').hidden, false);
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
  input('#bottleVolumeSelect', '500'); $('[data-bottle-fraction="0.3333333333333333"]').click();
  // [총 용량] × [분율] = [계산된 용량] order, "약" only on a result that actually got rounded.
  assert.equal($('#bottleVolumeResult').textContent, '500 mL × 1/3 = 약 166.7 mL');
  $('[data-bottle-fraction="0.5"]').click();
  assert.equal($('#bottleVolumeResult').textContent, '500 mL × 1/2 = 250 mL');
  assert.ok($('#bottleCalculator').textContent.includes('눈금이 있는 계량도구를 이용해 측정'));
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
  assert.ok($('#containerTypeChoice').textContent.includes('포장 형태를 자동으로 확인하지 못했습니다'));
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

test('처방전에서 확정한 약은 자동으로 저장되지 않고, [♡ 저장] 버튼을 눌러야만 내 약 보관함에 들어간다', async t => {
  const a = { ...complete, name: '텔미암정40/10mg' };
  const { $, window, input, submit } = setup(t, async () => Response.json(payload([a])));
  await window.eval("processRxNames(['텔미암 40/10'])");
  const radio = $('#rxCandidates input'); radio.checked = true; radio.dispatchEvent(new window.Event('change'));
  $('#rxCandidates .flow-actions button').click();
  assert.equal(JSON.parse(window.localStorage.getItem('savedMedicinesV1') || '[]').length, 0, '확정만으로는 저장되지 않는다');
  const heart = $('#rxSelectedList .save-heart'); assert.ok(heart); heart.click();
  const saved = JSON.parse(window.localStorage.getItem('savedMedicinesV1'));
  assert.equal(saved.length, 1); assert.equal(saved[0].itemSeq, '123');
});

// dose-calc.js는 pouch-crop.js와 같은 동적 import 패턴이라 이 테스트 하네스(disableJavaScriptFileLoading)
// 에서는 항상 null이다 - 실제 계산/파싱 정확성은 test/dose-calc.test.js가 순수 함수로 직접 검증하고,
// 여기서는 모듈이 없을 때도 절대 죽지 않고 "추가 정보가 필요합니다" 쪽으로 안전하게 빠지는지만 확인한다.
// 실제 브라우저(동적 import 동작)에서의 범위 계산·bar 렌더링은 실행 후 스크린샷으로 별도 확인했다.
test('처방 용량 분석: 처방전에서 용량을 읽지 못하면 간략 표시에 "읽지 못함"을 보여주고, 계산 모듈이 없을 때도 안전하게 안내만 한다', async t => {
  const a = { ...complete, name: '텔미암정40/10mg' };
  const { $, window } = setup(t, async () => Response.json(payload([a])));
  await window.eval("processRxNames(['텔미암정40/10mg'])"); // rawText를 주지 않아 ocrDose가 없는 상태를 재현
  await settle();
  const radio = $('#rxCandidates input'); radio.checked = true; radio.dispatchEvent(new window.Event('change'));
  $('#rxCandidates .flow-actions button').click();
  assert.ok($('#rxSelectedList .rx-dose-summary').textContent.includes('처방전에서 읽지 못함'));
  $('#rxSelectedList .flow-actions button:nth-child(2)').click(); // "용량 분석 보기"
  await settle();
  const panel = $('.rx-dose-detail');
  assert.equal(panel.hidden, false);
  assert.ok(panel.textContent.includes('추가 정보가 필요합니다'));
  assert.ok(!/적정|부적정(?!\S*안|경우)|과량|안전한 처방|잘못된 처방/.test(panel.textContent), '단정적 표현이 없어야 한다');
});

test('추출 결과(unified schema)를 먼저 표시하고 인식 수정은 원문을 보존하며 후보를 다시 검색한다', async t => {
  const schema = await import('../public/prescription-schema.js');
  const paths = [];
  const { window, $ } = setup(t, async path => { paths.push(path); return Response.json(payload([])); });
  window.__rxTest.setMedSchema(schema);
  window.testRow = schema.clampMedication({
    productCode: '644913501', rawName: '듀파락-이지시럽/15mL/포', drugName: '듀파락-이지시럽',
    strengthOrPackage: '15mL/포', doseUnit: '포', dosePerAdministration: 1, frequencyPerDay: 3, durationDays: 10,
    confidence: { productCode: .5, drugName: .5, dose: .95, frequency: .95, duration: .95 } // 낮은 confidence -> needsReview
  });
  await window.eval('processRxNames([window.testRow])');
  assert.ok($('#rxCandidates').textContent.includes('1포 × 하루 3회 × 10일'));
  assert.ok($('#rxCandidates').textContent.includes('⚠ 인식 결과를 확인해주세요'));
  $('#rxCandidates button').click();
  $('[name="drugName"]').value = '수정시럽'; $('[name="frequencyPerDay"]').value = '2';
  $('.rx-recognition-editor').dispatchEvent(new window.Event('submit', { cancelable: true })); await settle();
  assert.ok($('#rxCandidates').textContent.includes('1포 × 하루 2회 × 10일'));
  assert.equal(window.__rxTest.getGroups()[0].row.rawName, '듀파락-이지시럽/15mL/포');
  assert.ok(paths.some(path => decodeURIComponent(path).includes('수정시럽')));
  assert.equal(window.__rxTest.getGroups()[0].chosen, null);
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
  const labels = $('#rxCandidates').querySelectorAll('.rx-choice');
  assert.equal(labels.length, 2);
  assert.equal(window.__rxTest.getGroups()[0].candidates[0].strongMatch, true);
  assert.equal(window.__rxTest.getGroups()[0].candidates[1].strongMatch, false);
  assert.equal($('#rxCandidates .rx-strong-match'), null, 'matching strategy는 일반 UI에 노출하지 않는다');
  assert.equal($('#rxCandidates input:checked')?.value, '900');
  assert.equal(window.__rxTest.getGroups()[0].chosen.item.id, '900');
  assert.equal(window.__rxTest.getGroups()[0].matchingStatus, 'exact-code');
});

test('처방전 시럽은 알약 검색 장애에도 액체 후보를 선택하고 liquid 화면으로 이동한다', async t => {
  const liquid = { ...complete, form: '시럽제', name: '듀파락-이지시럽', description: '경구용 시럽제', permit: { status: 'ok', data: { packaging: '15mL × 30포' } } };
  const { window, $ } = setup(t, async path => path.startsWith('/api/medicines?') ? Response.json({ error: '실패' }, { status: 503 }) : Response.json(payload([liquid])));
  await window.eval("processRxNames(['듀파락-이지시럽'])");
  const radio = $('#rxCandidates input'); assert.ok(radio);
  radio.checked = true; radio.dispatchEvent(new window.Event('change')); $('#rxCandidates .flow-actions button').click();
  assert.equal(window.__rxTest.getGroups()[0].chosen.kind, 'liquid');
  $('#rxSelectedList .flow-actions button').click();
  assert.equal($('#liquidTool').classList.contains('active'), true); assert.equal($('#pillTool').classList.contains('hidden'), true);
});

test('공식 단일 코드 자동 선택 후 처방 단위·CTA·저장 metadata를 연결한다', async t => {
  const schema = await import('../public/prescription-schema.js');
  const item = { ...complete, form: '경질캡슐', name: '에도스캡슐', insuranceCode: '649401610' };
  const { window, $ } = setup(t, async () => Response.json(payload([item], 1, 1)));
  window.__rxTest.setMedSchema(schema);
  window.med = schema.clampMedication({ productCode: '649401610', rawName: '에도스캡슐/1캡슐', drugName: '에도스캡슐', dosePerAdministration: 1, frequencyPerDay: 2, durationDays: 60 });
  await window.eval('processRxNames([window.med])');
  assert.equal(window.__rxTest.getGroups()[0].matchingStatus, 'exact-code');
  assert.ok($('#rxCandidates').textContent.includes('1캡슐 × 하루 2회 × 60일'));
  assert.equal($('.rx-product-cta').textContent, '실물크기 보기');
  $('#rxSelectedList .save-heart').click();
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
  assert.equal(window.document.querySelectorAll('.rx-group').length, 4);
  assert.ok($('#rxCandidates').textContent.includes('1포 × 하루 3회 × 10일'));
  assert.ok($('#rxCandidates').textContent.includes('공식 제품 확인이 필요합니다'));
  assert.ok($('#rxCandidates').textContent.includes('제품 직접 선택'));
  assert.ok($('#rxCandidates').textContent.includes('인식 내용 수정'));
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
