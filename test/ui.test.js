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
