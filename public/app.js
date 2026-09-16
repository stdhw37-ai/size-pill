// Shared feedback primitives; textContent keeps server messages out of HTML.
let uiToastTimer;
function showToast(message, tone = 'success') {
  const toast = document.querySelector('#uiToast');
  if (!toast) return;
  clearTimeout(uiToastTimer); toast.textContent = message; toast.dataset.tone = tone; toast.hidden = false;
  uiToastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
}
function renderLoading(container) {
  container.replaceChildren(); container.setAttribute('aria-busy', 'true');
  const state = document.createElement('div'); state.className = 'loading-state'; state.setAttribute('aria-label', '정보를 불러오는 중'); state.setAttribute('role', 'status');
  for (let i = 0; i < 2; i++) { const row = document.createElement('div'); row.className = 'skeleton'; row.setAttribute('aria-hidden', 'true'); state.append(row); }
  container.append(state);
}
function renderEmpty(container, message, actionLabel, action) {
  container.replaceChildren(); const state = document.createElement('div'); state.className = 'empty-state compact';
  const copy = document.createElement('p'); copy.textContent = message; state.append(copy);
  if (action) { const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-outline'; button.textContent = actionLabel; button.onclick = action; state.append(button); }
  container.append(state);
}
const $ = selector => document.querySelector(selector);
// Web/PWA: relative paths work because the Worker serves both the API and the static assets from
// the same origin. A Capacitor-packaged native app has no same-origin backend - `window.Capacitor`
// is only defined inside that native shell, so this only changes behavior there. Point
// NATIVE_API_BASE at the deployed Worker's public HTTPS URL before shipping a native build; the
// MFDS/Supabase secret keys stay server-side either way, since this only changes *where* the
// browser/webview sends its request, never what runs inside the Worker.
const NATIVE_API_BASE = 'https://YOUR-WORKER-SUBDOMAIN.workers.dev';
const API_BASE = (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) ? NATIVE_API_BASE : '';
// Tied directly to the online/offline events (not a re-read of navigator.onLine): some runtimes
// don't flip navigator.onLine in lockstep with the events, and the events are the reliable signal.
window.addEventListener('online', () => { const el = $('#networkBanner'); if (el) el.hidden = true; });
window.addEventListener('offline', () => { const el = $('#networkBanner'); if (el) el.hidden = false; });
if ($('#networkBanner')) $('#networkBanner').hidden = navigator.onLine !== false;
const root = document.documentElement, longEl = $('#long'), shortEl = $('#short'), thickEl = $('#thick');
let shape = 'oval', selected = null, query = {}, page = 1, controller;
// 진행 중인 검색과 동일한 조건(요청 9)이면 새 request를 만들지 않는다 - 버튼 연타/Enter+클릭 중복 등.
// 결과를 세션 캐시로 재사용하지는 않는다 - 오류 후 "다시 시도"나 같은 검색어의 반복 제출은 항상 최신
// 데이터를 다시 조회해야 하며, 지난 성공 응답을 그대로 보여주면 오류 상태를 감추게 된다.
let searchInFlightKey = null;
function searchCacheKey(q, nextPage) { return JSON.stringify([q.item_name, q.entp_name, q.item_seq, nextPage]); }
// True once the user has picked a real product or explicitly gone to manual entry this session -
// distinguishes "resume where I left off" from a fresh visit, see syncPillStep().
let pillEngaged = false;
let rxSearchTarget = null;
const readCal = () => { try { return JSON.parse(localStorage.getItem('pillCalV2')); } catch { return null; } };
let calibration = readCal();
const validCal = value => value && Number.isFinite(value.scale) && value.scale >= .5 && value.scale <= 1.5;
if (!validCal(calibration)) calibration = null;
function applyCal(value) {
  root.style.setProperty('--ppmm', 3.7795275591 * value);
  const zoom = window.visualViewport?.scale || 1;
  const valid = calibration && calibration.dpr === window.devicePixelRatio && Math.abs(zoom - 1) < .01;
  $('#status').textContent = valid ? '화면 보정 적용 중' : '화면 보정 필요';
  const detail = $('#calStatusText');
  if (detail) { detail.textContent = valid ? '✓ 화면 보정 완료' : '정확한 실물크기를 위해 화면 보정이 필요해요'; detail.classList.toggle('ok', valid); }
  const short = $('#settingsCalStatus');
  if (short) short.textContent = valid ? '보정 완료' : '보정 필요';
  const btn = $('#toggleCal');
  if (btn) btn.textContent = valid ? '다시 보정' : '보정하기';
}
function number(el) { const n = Number(el.value); return el.value.trim() && Number.isFinite(n) && n > 0 && n <= 100 ? n : null; }
// Prescription dose math/parsing (see dose-calc.js) - lazy: it's only a prescription-flow feature,
// so it has no business downloading on every page load (Home included). ensureDoseCalc() is called
// once, the first time the prescription screen actually needs it; a browser/test environment
// without it just skips dose analysis instead of failing either way.
let doseCalc = null, doseCalcPromise = null;
function ensureDoseCalc() { return doseCalcPromise ??= import('./dose-calc.js').then(m => { doseCalc = m; }).catch(() => {}); }
// Login-first gate state (요청 2) - declared here, ahead of showScreen()'s definition, since it's a
// `let` binding showScreen reads on every call; see initAuth()/openGate()/closeGate() near the bottom
// of this file for the only things that change it. Patient dose-analysis fields now come from the
// signed-in user's profile (auth.js) instead of prescription-screen inputs - see
// applyProfileToPatientFields() below.
let authGateOpen = true, authApi = null, authConfigData = null, authSession = null, currentProfile = null;
let profileMode = 'onboarding', profileReturnMode = 'settings';
let patientWeightKg = null, patientAgeYears = null;
// The Three.js/OrbitControls/tablet-geometry bundle is a real, non-trivial download - it has no
// business loading on Home or any other screen that never shows a tablet. ensureThree3D() is
// called once, the first time the pill screen is actually shown (see showScreen()); this stays
// null until then (and in environments without it, e.g. the DOM test harness), and every caller
// already goes through optional chaining (three3d?.update/show/hide) to tolerate that.
let three3d = null, three3dPromise = null;
function ensureThree3D() {
  return three3dPromise ??= (async () => {
    try {
      const [THREE, controlsModule, geometryModule] = await Promise.all([
        import('three'),
        import('/vendor/three/examples/jsm/controls/OrbitControls.js'),
        import('./tablet-geometry.js')
      ]);
      three3d = setupThree3D(THREE, controlsModule.OrbitControls, geometryModule);
      render();
      syncThreeVisibility();
    } catch (err) {
      console.warn('3D 모형을 불러오지 못했습니다.', err);
    }
  })();
}
function setupThree3D(THREE, OrbitControls, { buildTabletGeometry, classifyShape3D, paintCapsuleColors, colorToCss }) {
  const container = $('#scene3d');
  const FOV = 32;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 2000);
  // A near-front start (old: (0,4,40), ~6° above the thickness axis) foreshortened the Z-depth to
  // almost nothing, so a correctly-proportioned tablet still looked flat until manually rotated.
  // Start at a three-quarter angle instead so the thickness edge is visible immediately; magnitude
  // is irrelevant here since applyDistance() below re-solves it from direction alone.
  const startAzimuth = THREE.MathUtils.degToRad(34), startElevation = THREE.MathUtils.degToRad(20);
  camera.position.set(
    Math.sin(startAzimuth) * Math.cos(startElevation),
    Math.sin(startElevation),
    Math.cos(startAzimuth) * Math.cos(startElevation)
  );

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.12;
  controls.enablePan = false; controls.autoRotate = false;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  // THREE.TOUCH has no DOLLY member (only DOLLY_PAN/DOLLY_ROTATE) - the old `TOUCH.DOLLY` was
  // `undefined`, so two-finger touch matched no case in OrbitControls and pinch-zoom silently did
  // nothing. DOLLY_PAN with enablePan=false zooms only, which is exactly pinch-to-zoom.
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

  // No tone-mapping curve and no shadow-casting: the previous ACES + shadow-mapped, single-hot-
  // DirectionalLight(3.6) setup routinely pushed the lit side of the tablet past 1.0 per channel
  // (clipping to white regardless of hue) while the shadowed side/contact shadow crushed toward
  // black - see the report at the end of this function for the full before/after breakdown.
  // A hemisphere light (sky/ground, never zero on either side) does most of the work so every
  // face stays visibly lit and colored; the two directional lights are just faint modeling light.
  // Measured via headless screenshot pixel sampling (see report): three.js divides Lambert diffuse
  // by pi, so these intensities read noticeably dimmer than the numbers suggest - the first pass
  // (1.05/0.12/0.42/0.2) rendered colkin's #ffe066 as a muddy (179,157,70), ~70% of true brightness
  // despite the correct hue ratio. Scaled up ~1.5x here to read as a clearly, unmistakably lit color.
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd7dbd6, 1.7));
  scene.add(new THREE.AmbientLight(0xffffff, 0.18));
  const key = new THREE.DirectionalLight(0xffffff, 0.6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.28);
  scene.add(fill);

  let mesh = null;
  let boundingRadius = 5;
  let hasDims = false;
  // Default to 'fit': a 7mm tablet at the real mm-to-px scale is only ~26 CSS px tall, too small to
  // read shape/thickness/color at a glance. 'real' is still one tap away for an exact-scale check.
  let sizeMode = 'fit';

  function currentPpmm() { return parseFloat(root.style.getPropertyValue('--ppmm')) || 3.7795275591; }
  // Solve the camera distance so that, at the object's depth, 1mm maps to exactly `ppmm` CSS pixels -
  // the same real-size basis the 2D model uses, shared via the same --ppmm value. Independent of
  // the object's own size, so it never drifts from the 2D reference.
  function realSizeDistance() {
    const heightPx = Math.max(1, container.clientHeight);
    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    return heightPx / (2 * currentPpmm() * Math.tan(fovRad / 2));
  }
  // Solve the distance so the tablet's diameter fills `targetFraction` of the shorter viewport side -
  // a view-for-detail framing, deliberately decoupled from the mm-to-px scale above. A 7mm tablet at
  // 3.78 px/mm is only ~26 CSS px tall, which is why the old "x2.2" magnifier still looked tiny.
  function fitDistance(targetFraction = 0.42) {
    const heightPx = Math.max(1, container.clientHeight), widthPx = Math.max(1, container.clientWidth);
    const minSidePx = Math.min(heightPx, widthPx);
    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    return (boundingRadius * heightPx) / (Math.tan(fovRad / 2) * targetFraction * minSidePx);
  }
  function applyDistance() {
    const distance = sizeMode === 'fit' ? fitDistance() : realSizeDistance();
    const direction = camera.position.clone().sub(controls.target);
    if (direction.lengthSq() < 1e-6) direction.set(0, 0.35, 1);
    direction.normalize();
    camera.position.copy(controls.target).addScaledVector(direction, distance);
    controls.minDistance = distance / 6; controls.maxDistance = distance * 5;
    controls.update();
  }
  function syncRendererSize() {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  // Round/oval/oblong/square/capsule are simple enough that the geometry is a faithful shape, not
  // just an approximation. The polygon shapes (삼각형/마름모형/오각형/육각형/팔각형) use a generalized
  // rounded n-gon that matches the *bounding box* exactly but can't reproduce a real product's exact
  // irregular outline (e.g. a specific corner cut or asymmetry) - flagged per the "완벽한 복제가
  // 어려우므로 근사 모델임을 표시" requirement, using classifyShape3D's own SHAPE_MAP as the source of
  // truth for which shapes are approximations rather than duplicating that list here.
  let lastShape3d = null, lastShapeWasFallback = false;
  // Kept to one short line (no repeated "공개 치수·색상·형태를 반영한..." boilerplate on every
  // update) - the approximation disclosure is the only part worth calling out each time.
  function updateNote(hasDims) {
    if (!hasDims) { $('#model3dNote').textContent = '치수 정보가 없어 예시 비율로 표시합니다.'; return; }
    const mode = sizeMode === 'fit' ? '확대 보기' : '실제 크기 · 화면 보정 기준';
    const isPolygonApprox = ['triangle', 'rhombus', 'pentagon', 'hexagon', 'octagon'].includes(lastShape3d);
    const approxNote = (isPolygonApprox || lastShapeWasFallback) ? ' · 공식 치수·모양 기반 근사 모델' : '';
    $('#model3dNote').textContent = `${mode}${approxNote}`;
  }

  function update(l, s, t) {
    hasDims = !!(l && s);
    const long = l || 12, short = s || 6, thick = t || 4;
    const shape3d = classifyShape3D(selected?.shape, shape, `${selected?.description || ''} ${selected?.name || ''}`);
    lastShape3d = shape3d;
    // A selected product whose official DRUG_SHAPE didn't match any known keyword (e.g. "기타", or
    // a novelty outline like a bear-face 츄어블정) falls back to the closest basic shape in
    // classifyShape3D - that fallback is even less faithful than the dedicated polygon shapes, so it
    // gets the same approximation disclosure.
    lastShapeWasFallback = !!selected && !/원형|타원|장방|캡슐|캅셀|사각|삼각|마름모|오각|육각|팔각/.test(`${selected.shape || ''} ${selected.description || ''} ${selected.name || ''}`);
    const geometry = buildTabletGeometry(THREE, { long, short, thick, shape3d });
    geometry.computeBoundingSphere();
    boundingRadius = geometry.boundingSphere.radius;
    const front = colorToCss(selected?.colorFront), back = colorToCss(selected?.colorBack || selected?.colorFront);
    // Matte/semi-matte finish (high roughness, ~0 metalness) so the base color reads clearly instead
    // of a glossy plastic-like specular highlight, and no environment map so specular stays subtle.
    // DoubleSide is a safety net for the hand-built biconvex dome geometry (buildTabletGeometry) -
    // its winding is correct, but rendering both sides costs little on a mesh this small and
    // guarantees no face silently disappears if a future shape's winding is ever slightly off.
    const materialOptions = { roughness: 0.88, metalness: 0, side: THREE.DoubleSide };
    let material;
    if (shape3d === 'capsule') {
      paintCapsuleColors(THREE, geometry, front, back);
      material = new THREE.MeshStandardMaterial({ ...materialOptions, vertexColors: true });
    } else {
      material = new THREE.MeshStandardMaterial({ ...materialOptions, color: new THREE.Color(front) });
    }
    if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
    mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    const radius = Math.max(long, short, thick) * 0.6;
    key.position.set(radius * 0.9, radius * 1.4, radius * 1.7);
    fill.position.set(-radius * 1.3, -radius * 0.5, radius * 1.1);

    updateNote(hasDims);
    syncRendererSize();
    applyDistance();
  }

  document.querySelectorAll('[data-zoom]').forEach(button => button.onclick = () => {
    document.querySelectorAll('[data-zoom]').forEach(el => el.classList.toggle('active', el === button));
    sizeMode = button.dataset.zoom === '2' ? 'fit' : 'real';
    applyDistance();
    updateNote(hasDims);
  });

  let visible = false;
  let resizeObserver;
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => { if (visible) { syncRendererSize(); applyDistance(); } });
    resizeObserver.observe(container);
  }
  window.addEventListener('resize', () => { if (visible) { syncRendererSize(); applyDistance(); } });

  function show() { visible = true; syncRendererSize(); applyDistance(); }
  function hide() { visible = false; }

  function loop() {
    requestAnimationFrame(loop);
    if (!visible) return;
    controls.update();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(loop);

  return { update, show, hide };
}
function render() {
  const l = number(longEl), s = number(shortEl), t = number(thickEl);
  // The headline "L × S × T mm" summary at the top of the result screen: driven directly from the
  // same three inputs selectMedicine()/manual entry both write to, so it's correct for a selected
  // product and for manual entry alike without duplicating the validity check in two places.
  const sizeSummary = $('#sizeSummary');
  if (l && s && t) {
    sizeSummary.hidden = false;
    sizeSummary.replaceChildren();
    const value = document.createElement('strong'); value.textContent = `${l} × ${s} × ${t} mm`;
    const caption = document.createElement('small'); caption.textContent = '장축 × 단축 × 두께';
    sizeSummary.append(value, caption);
  } else {
    sizeSummary.hidden = true;
  }
  // The 3D model is the single, sole renderer for both a selected product and manual entry - there
  // is no separate 2D visual path any more, just this one call with the same three dimensions.
  three3d?.update(l, s, t);
}
function setManual() {
  $('#pillTool').classList.remove('search-idle');
  selected = null;
  [longEl, shortEl, thickEl].forEach(el => el.readOnly = false);
  document.querySelectorAll('.shape').forEach(el => el.disabled = false);
  document.querySelectorAll('.result').forEach(el => el.setAttribute('aria-pressed', 'false'));
  $('#resultName').textContent = '직접 입력 예시';
  $('#resultCompany').textContent = '특정 의약품의 치수가 아닙니다';
  $('#medicineDetails').hidden = true;
  $('#detailsAccordion').hidden = true;
  $('#manualEntryDetails').open = true;
  if ($('#quickFacts')) $('#quickFacts').hidden = true;
  if ($('#quickPhotoBtn')) $('#quickPhotoBtn').hidden = true;
  if ($('#flavorBadge')) $('#flavorBadge').hidden = true;
  // 직접 입력은 실제 제품이 아니라 3D 모형 확인 자체가 목적이므로, 검색 결과와 달리 핵심정보 카드는
  // 숨기고 3D를 바로 펼쳐서 보여준다(요청 3의 "기본은 정보 카드 먼저"는 실제 검색 결과에만 적용).
  if ($('#coreInfoCard')) $('#coreInfoCard').hidden = true;
  pillEngaged = true;
  setPillStep('result');
  render();
}
$('#manual').onclick = setManual;
[longEl, shortEl, thickEl].forEach(el => el.addEventListener('input', render));
document.querySelectorAll('.shape').forEach(button => button.onclick = () => {
  shape = button.dataset.shape;
  document.querySelectorAll('.shape').forEach(el => el.classList.toggle('active', el === button)); render();
});
function infoCell(iconId, label, value) {
  const cell = document.createElement('div'); cell.className = 'info-cell';
  const body = document.createElement('div'); body.className = 'info-body';
  body.append(flowNode('span', label, 'info-label'), flowNode('span', value || '정보 없음'));
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('class', 'icon info-ic'); icon.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', `#${iconId}`); icon.append(use);
  cell.append(icon, body);
  return cell;
}
// 검색 목록은 가벼운 데이터(light=1, 이름/제조사/모양/치수 등)만 담고 있다 - 허가정보/e약은요 같은
// 상세 데이터는 status:'not_requested'로 비어 있다. 사용자가 실제로 이 제품을 선택했을 때만
// item_seq 단일 조회(비용이 2회로 저렴하다)로 채운다. 이미 조회된(상태가 not_requested가 아닌) 항목은
// 다시 요청하지 않는다 - 처방전 매칭 등 기존 호출자가 이미 채워 넘긴 데이터를 덮어쓰지 않기 위함이다.
async function ensureMedicineDetail(item) {
  if (!item || (item.permit?.status !== 'not_requested' && item.easy?.status !== 'not_requested')) return;
  try {
    const response = await fetch(API_BASE + '/api/medicines?' + new URLSearchParams({ item_seq: item.id }), { signal: AbortSignal.timeout(8000) });
    const data = await response.json();
    const fresh = data?.items?.find(i => String(i?.id) === String(item.id));
    if (response.ok && fresh) {
      if (item.permit?.status === 'not_requested') item.permit = fresh.permit;
      if (item.easy?.status === 'not_requested') item.easy = fresh.easy;
    }
  } catch { /* 치수·모양 등 목록에 이미 있던 기본 정보는 이 조회 결과와 무관하게 그대로 표시된다. */ }
}
function renderMedicineDialogBody(dialog, item, destination) {
  dialog.replaceChildren(flowNode('h2', item.name || item.itemName), flowNode('p', item.company || item.entpName || '제조사 미제공'),
    flowNode('p', destination.medicineForm === 'unknown' ? '제품 유형 확인 필요 · 공식 제형 정보를 확인해주세요.' : '의약품 정보'),
    flowNode('p', `제형: ${MedicineFlow.formOf(item) || '미제공'}`), flowNode('p', MedicineFlow.packageOf(item)));
  // 연고/크림/겔/외용제 등(요청 6): 알약 크기 UI 없이 사용방법/보관방법/주의사항을 e약은요 원문 그대로
  // 보여준다 - "사용 부위"·"1회 사용량"처럼 식약처 데이터에 구조화된 필드가 없는 항목은 "정보 없음"으로
  // 정직하게 남기고 추정하지 않는다.
  const e = item.easy?.data;
  const info = document.createElement('div'); info.className = 'summary-info-grid';
  info.append(infoCell('ic-target', '사용부위', e?.applicationSite), infoCell('ic-dose', '사용량', e?.dose),
    infoCell('ic-doc', '사용방법', e?.usage), infoCell('ic-box', '보관방법', officialStorageText(item)));
  dialog.append(info);
  if (e?.precautions || e?.warning) dialog.append(flowNode('p', `주의사항: ${e.precautions || e.warning}`, 'tip'));
  const close = flowNode('button', '닫기'); close.type = 'button'; close.onclick = () => typeof dialog.close === 'function' ? dialog.close() : dialog.removeAttribute('open'); dialog.append(close);
}
function openMedicine(item, button, fetchedAt) {
  if (!item || typeof item !== 'object') { showToast('제품 정보를 확인할 수 없습니다. 다시 검색해주세요.', 'error'); return; }
  const destination = MedicineFlow.getMedicineDestination(item);
  if (destination.screen === 'pill') { showScreen('pill'); selectMedicine(item, button, fetchedAt); return; }
  if (destination.screen === 'liquid') { showScreen('liquid'); $('#liquidWaySearch').click(); selectLiquid(item); return; }
  // 산제/과립/포/스틱(요청 5)은 액체약과 같은 포/스틱 분할 가이드(사진 기반 fraction 기능)를 그대로
  // 재사용한다 - 내용물이 액체인지 가루인지는 이 기능(사진에서 분할 위치 확인) 자체에 상관없다.
  if (MedicineFlow.classifyDisplayForm(item) === 'powder-sachet') { showScreen('liquid'); $('#liquidWaySearch').click(); selectLiquid(item); return; }
  let dialog = $('#medicineInfoDialog');
  if (!dialog) { dialog = document.createElement('dialog'); dialog.id = 'medicineInfoDialog'; document.body.append(dialog); }
  renderMedicineDialogBody(dialog, item, destination);
  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal(); else dialog.setAttribute('open', '');
  if (item.easy?.status === 'not_requested') {
    ensureMedicineDetail(item).then(() => { if (dialog.open || dialog.hasAttribute('open')) renderMedicineDialogBody(dialog, item, destination); });
  }
}
function rxDisplayRow(group) {
  return group.chosen && group.row ? { ...group.row, doseUnit: MedicineFlow.officialDoseUnit(group.chosen.item, group.row.doseUnit) } : group.row;
}
function savedMedicineSnapshot(entry) {
  return { id: entry.itemSeq, name: entry.itemName, company: entry.entpName, form: entry.dosageForm,
    long: entry.length, short: entry.width, thick: entry.thickness, shape: entry.shape,
    packaging: entry.metadata?.packaging || '', insuranceCode: entry.metadata?.productCode || '' };
}
function selectMedicine(item, button, fetchedAt) {
  if (MedicineFlow.classifyMedicineForm(item) !== 'solid-oral') return openMedicine(item, button, fetchedAt);
  $('#pillTool').classList.remove('search-idle');
  selected = item;
  [longEl, shortEl, thickEl].forEach((el, i) => { el.value = [item.long, item.short, item.thick][i] ?? ''; el.readOnly = true; });
  shape = item.shape === '원형' ? 'round' : item.shape === '장방형' ? 'capsule' : 'oval';
  document.querySelectorAll('.shape').forEach(el => { el.disabled = true; el.classList.toggle('active', el.dataset.shape === shape); });
  document.querySelectorAll('.result').forEach(el => el.setAttribute('aria-pressed', String(el === button)));
  $('#resultName').textContent = item.name;
  $('#resultCompany').textContent = `${item.company || '제조사 미제공'} · 식약처 조회 ${new Date(fetchedAt).toLocaleDateString('ko-KR')}`;
  $('#detailsAccordion').hidden = false;
  $('#manualEntryDetails').open = !(item.long && item.short && item.thick);
  showIdentity(item);
  pushRecent(item);
  $('#pillSaveBtn').hidden = false; $('#pillSaveBtn').dataset.saveId = String(item.id);
  $('#pillSaveBtn').onclick = () => toggleSaveMedicine(item, 'pill');
  syncSaveButtons();
  pillEngaged = true;
  setPillStep('result');
  render();
  // 치수/모양(3D)은 검색 목록 데이터만으로 이미 위에서 그렸다 - 여기서는 핵심정보 카드(복용방법/
  // 보관방법)와 상세정보 아코디언에 필요한 허가정보/e약은요만 선택 시점에 지연 로딩한다. 이미지가
  // 검색을 막지 않듯, 이 조회도 이미 그린 3D·치수 화면을 막지 않는다.
  if (item.permit?.status === 'not_requested' || item.easy?.status === 'not_requested') {
    ensureMedicineDetail(item).then(() => { if (selected === item) showIdentity(item); });
  }
}
function safeImage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port && (parsed.hostname === 'mfds.go.kr' || parsed.hostname.endsWith('.mfds.go.kr'));
  } catch { return false; }
}
function productImage(url, alt, className = '', fallback = '이미지 정보가 없습니다.') {
  const message = document.createElement('span'); message.className = 'image-fallback'; message.textContent = fallback;
  if (!safeImage(url)) return message;
  const image = document.createElement('img'); image.alt = alt; image.className = className;
  image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
  image.onerror = () => { message.textContent = '이미지를 불러올 수 없습니다.'; image.replaceWith(message); };
  image.src = url;
  return image;
}
function facts(target, rows) {
  target.replaceChildren();
  for (const [label, value] of rows) {
    const row = document.createElement('div'), term = document.createElement('dt'), detail = document.createElement('dd');
    term.textContent = label;
    if (value instanceof Node) detail.append(value); else detail.textContent = value || '미제공';
    row.append(term, detail); target.append(row);
  }
}
// Only literal, explicit taste/scent words found in official text are shown; nothing is ever
// inferred from color, capsule/coating appearance, ingredients, or excipients. Confirmed against
// real data: e.g. 센트룸키즈츄어블정's CHART is "레몬향이나는 밝은 회색의 원형 츄어블정제" - genuine
// flavor wording does occur in this field. Scanned in priority order: CHART(성상), 제품허가정보 성상,
// then 제품허가정보 첨가제 (additive/flavoring agent names occasionally spell out a flavor, e.g. a
// listed "오렌지향" additive) - e약은요 is dosage/warning/side-effect text and has not been observed
// to carry taste wording, so it isn't scanned.
const FLAVOR_EXCLUDE = new Set(['방향', '방향족', '방향성', '방향제', '경향', '영향', '동향', '상향', '하향', '일방향', '양방향', '무향', '무취']);
// Intensity is only ever attached when the official text itself literally says so - never guessed.
// Two literal phrasings are recognized: an intensifier word directly before the taste/scent word
// ("강한 쓴맛"), or a "...이 강함/강하다/심하다" clause directly after it ("쓴맛이 강함").
const TASTE_INTENSIFIERS = ['강한', '매우', '약간', '은은한', '진한', '심한', '옅은', '연한'];
const STRONG_SUFFIX = /^\s*(이|가)?\s*(강함|강한\s*편|강하다|심함|심하다|뚜렷함|뚜렷하다)/;
function findFlavorWords(text) {
  const found = new Map(); // base word -> display label (base word, or with a literal intensity prefix)
  for (const match of text.matchAll(/[가-힣]{1,6}(?:맛|향)/g)) {
    const word = match[0];
    if (FLAVOR_EXCLUDE.has(word)) continue;
    let label = word;
    const before = text.slice(0, match.index).trimEnd();
    const prevWord = before.split(/\s+/).pop();
    if (prevWord && TASTE_INTENSIFIERS.includes(prevWord)) label = `${prevWord} ${word}`;
    else if (STRONG_SUFFIX.test(text.slice(match.index + word.length))) label = `강한 ${word}`;
    if (!found.has(word) || label.length > found.get(word).length) found.set(word, label);
  }
  return found;
}
// A structured, reusable per-product flavor summary (see the app.js flavor-info comment block below
// for the shape) - built purely from literal official text, never persisted or sent anywhere new.
function buildFlavorInfo(item) {
  const sources = [
    ['CHART(성상)', item.description],
    ['제품허가정보 성상', item.permit?.data?.description],
    ['제품허가정보 첨가제', item.permit?.data?.additives]
  ];
  const taste = new Map(), scent = new Map();
  let sourceType = null, sourceText = null;
  for (const [type, raw] of sources) {
    const text = String(raw ?? '');
    if (!text) continue;
    const found = findFlavorWords(text);
    if (found.size && !sourceType) { sourceType = type; sourceText = text.length > 80 ? text.slice(0, 80) + '…' : text; }
    for (const [word, label] of found) (word.endsWith('맛') ? taste : scent).set(word, label);
  }
  const labels = [...taste.values(), ...scent.values()];
  if (!labels.length) return null;
  return { taste: [...taste.values()], scent: [...scent.values()], labels, sourceType, sourceText };
}
// 맛/향은 검색 결과 핵심 요약에서 바로 보여야 한다(요청 7) - 정보가 없다고 배지를 숨기지 않고
// "등록된 맛 정보 없음"이라고 명시한다. 절대 색상·코팅·성분 등에서 맛을 추정해 채우지 않는다 - 여기
// 보여주는 값은 buildFlavorInfo가 공식 원문에서 문자 그대로 찾은 단어뿐이다.
function showFlavorBadge(flavorInfo) {
  const badge = $('#flavorBadge'), chips = $('#flavorChips');
  if (!badge || !chips) return;
  chips.replaceChildren();
  if (!flavorInfo) { chips.append(document.createTextNode('등록된 맛 정보 없음')); badge.hidden = false; return; }
  for (const label of flavorInfo.labels) {
    const chip = document.createElement('span'); chip.className = 'flavor-chip'; chip.textContent = label;
    if (flavorInfo.sourceText) chip.title = `${flavorInfo.sourceType}: ${flavorInfo.sourceText}`;
    chips.append(chip);
  }
  badge.hidden = false;
}
// 제품 자체의 공식 용법(e약은요) 요약 - 특정 처방의 실제 복용량이 아니라 "이 제품을 보통 이렇게 복용
// 한다"는 라벨 정보다. 이미 만들어져 테스트된 doseCalc.parseOfficialDosage(순수 함수)를 그대로 재사용
// 하고, 다시 구현하지 않는다. 신뢰 있게 읽히는 패턴이 없으면 억지로 숫자를 만들지 않고 null로 둔다.
function officialDoseSummary(item) {
  const usage = item.easy?.data?.usage || '';
  if (!doseCalc || !usage) return { text: null, usage };
  const o = doseCalc.parseOfficialDosage(usage);
  const range = r => r ? `${r.min}${r.min !== r.max ? `~${r.max}` : ''}` : null;
  let amount = null;
  if (o.singleDoseTablets) amount = `1회 ${range(o.singleDoseTablets)}정`;
  else if (o.singleDoseMl) amount = `1회 ${range(o.singleDoseMl)}mL`;
  else if (o.singleDoseMg) amount = `1회 ${range(o.singleDoseMg)}mg`;
  const freq = o.frequency ? `하루 ${range(o.frequency)}회` : null;
  const text = [amount, freq].filter(Boolean).join(' · ') || null;
  return { text, usage };
}
function officialStorageText(item) {
  return item.permit?.data?.storage || item.easy?.data?.storage || null;
}
// 핵심정보 카드(요청 3/9) - 복용방법/보관방법을 3D보다 먼저 보여준다. "자세히 보기"는 기존
// #detailsAccordion(의약품 상세정보 보기)을 그대로 펼친다 - 새 상세 화면을 따로 만들지 않는다.
function renderCoreInfoCard(item) {
  const card = $('#coreInfoCard'); if (!card) return;
  const dose = officialDoseSummary(item);
  $('#coreInfoDose').textContent = dose.text || (dose.usage ? dose.usage.split(/\n/)[0].slice(0, 60) : '정보 없음');
  $('#coreInfoStorage').textContent = officialStorageText(item) || '정보 없음';
  const more = $('#coreInfoMore');
  more.hidden = false;
  more.onclick = () => { $('#detailsAccordion').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  card.hidden = false;
}
function showIdentity(item) {
  $('#medicineDetails').hidden = false;
  // The click-to-enlarge photo thumbnail lives in the compact summary row at the top of the result
  // screen - #medicineImage is the same element either way, just relocated/resized in the HTML. The
  // 3D view no longer repeats it in a second "compare" thumbnail (the photo is already right above).
  $('#medicineImage').replaceChildren(productImage(item.imageUrl, `${item.name} 제품 사진`));
  const hasPhoto = safeImage(item.imageUrl);
  $('#quickPhotoBtn').hidden = !hasPhoto;
  const mm = key => item[key] ? `${item[key]} mm` : item.dimensionsRaw?.[key] ? `${item.dimensionsRaw[key]} (원문 · 정확한 크기로 표시 불가)` : '미제공';
  const rows = [
    ['모양', item.shape], ['색상 (앞 / 뒤)', `${item.colorFront || '미제공'} / ${item.colorBack || '미제공'}`],
    ['앞면 식별표시', item.printFront], ['뒷면 식별표시', item.printBack],
    ['분할선 (앞 / 뒤)', `${item.lineFront || '미제공'} / ${item.lineBack || '미제공'}`],
    ['장축 / 단축', `${mm('long')} / ${mm('short')}`], ['두께', mm('thick')],
    ['제형', item.form], ['성상', item.description]
  ];
  const flavorInfo = buildFlavorInfo(item);
  if (flavorInfo?.taste.length && flavorInfo.scent.length) rows.push(['맛', flavorInfo.taste.join(', ')], ['향', flavorInfo.scent.join(', ')]);
  else if (flavorInfo?.taste.length || flavorInfo?.scent.length) rows.push(['맛/향', flavorInfo.labels.join(', ')]);
  showFlavorBadge(flavorInfo);
  renderCoreInfoCard(item);
  // A compact one-line summary next to the name, so shape/color/identifying marks are visible
  // without expanding anything. Flavor gets its own dedicated badge (showFlavorBadge above) instead
  // of being folded into this line, since it's the one fact people scan for specifically. 제형도
  // 여기 포함한다(요청 3: 제품명 다음 줄에 제형/색상/모양).
  const quickFacts = $('#quickFacts');
  if (quickFacts) {
    const color = [item.colorFront, item.colorBack].filter(Boolean).join('/');
    const marks = [item.printFront && `앞 ${item.printFront}`, item.printBack && `뒤 ${item.printBack}`].filter(Boolean).join('/');
    const bits = [MedicineFlow.dosageFormLabel(item), item.shape, color, marks].filter(Boolean);
    quickFacts.hidden = bits.length === 0;
    quickFacts.textContent = bits.join(' · ');
  }
  facts($('#identityFacts'), rows);
  showSupplement(item);
  facts($('#extraFacts'), [
    ['품목일련번호', item.id], ['업체명', item.company], ['업체일련번호', item.companyId],
    ['영문 제품명', item.englishName], ['전문 / 일반', item.medicineType],
    ['분류명', item.className], ['분류번호', item.classCode], ['품목허가일', item.permitDate],
    ['정보 변경일', item.changed], ['이미지 등록일', item.imageDate],
    ['앞면 마크', item.markFront], ['뒷면 마크', item.markBack],
    ['앞면 마크 코드', item.markCodeFront], ['뒷면 마크 코드', item.markCodeBack],
    ['앞면 마크 이미지', productImage(item.markImageFront, '앞면 마크', 'mark-image')],
    ['뒷면 마크 이미지', productImage(item.markImageBack, '뒷면 마크', 'mark-image')],
    ['보험코드', item.insuranceCode], ['표준코드', item.standardCode], ['사업자등록번호', item.businessNumber]
  ]);
}
function showSupplement(item) {
  const status = value => ({ ok: '품목일련번호가 일치하는 정보입니다.', not_found: '이 제품에 대해 제공되는 정보가 없습니다.', error: '정보를 불러오지 못했습니다. 잠시 후 다시 검색해주세요.', unmatched: '품목일련번호를 확실히 확인할 수 없어 병합하지 않았습니다.' }[value] || '아직 조회되지 않은 정보입니다.');
  $('#permitStatus').textContent = status(item.permit?.status);
  $('#easyStatus').textContent = status(item.easy?.status) + ' 정보가 없다고 주의사항이나 부작용이 없는 것은 아닙니다.';
  const p = item.permit?.data, e = item.easy?.data;
  facts($('#permitFacts'), p ? [
    ['유효성분', p.ingredients], ['원료성분', p.materials], ['첨가제', p.additives],
    ['허가 제품명', p.name], ['허가 업체명', p.company], ['품목허가일', p.permitDate], ['허가/신고', p.permitKind],
    ['업체허가번호', p.companyPermitNumber], ['전문/일반', p.medicineType], ['성상', p.description],
    ['위탁제조업체', p.manufacturer], ['허가 상태', p.status], ['취소일자', p.cancellationDate],
    ['포장단위', p.packaging], ['저장방법', p.storage], ['유효기간', p.validity], ['ATC코드', p.atcCode], ['변경일', p.changed]
  ] : []);
  // Keep original content as text; never execute upstream HTML or omit safety sections.
  facts($('#easyFacts'), e ? [
    ['효능효과', e.efficacy], ['사용법', e.usage], ['주의사항 경고', e.warning], ['주의사항', e.precautions],
    ['상호작용', e.interactions], ['부작용', e.sideEffects], ['보관방법', e.storage], ['공개일', e.published], ['수정일', e.updated]
  ] : []);
}
// "최근 확인한 약" on the Home screen: purely a client-side convenience list (device-local
// localStorage), not a new backend/API concept - re-selecting one just re-runs the existing
// item_seq search path, so it reuses 100% of the current search/cache/select pipeline.
function readRecents() { try { const rows = JSON.parse(localStorage.getItem('recentMedicines')); return Array.isArray(rows) ? rows.filter(row => row && row.id) : []; } catch { return []; } }
function writeRecents(list) { try { localStorage.setItem('recentMedicines', JSON.stringify(list.slice(0, 8))); } catch { /* Recents are a convenience; failing to persist is not fatal. */ } }
function pushRecent(item) {
  writeRecents([{ id: item.id, name: item.name, company: item.company }, ...readRecents().filter(r => r.id !== item.id)]);
  renderRecents();
}
const RECENT_PREVIEW = 3;
let recentShowAll = false;
// Compact vertical list, newest first, capped to 3 rows by default - a horizontal scroll carousel
// hid most of the list off-screen and could cause layout overflow, and buried entries nobody would
// scroll to find. "전체 보기" reveals the rest (up to the 8 kept in storage) in place.
function renderRecents() {
  const row = $('#recentRow'), section = $('#recentSection'), showAllBtn = $('#recentShowAll');
  if (!row || !section) return;
  const list = readRecents();
  section.hidden = list.length === 0;
  row.replaceChildren();
  const shown = recentShowAll ? list : list.slice(0, RECENT_PREVIEW);
  for (const r of shown) {
    const item = document.createElement('button'); item.type = 'button'; item.className = 'recent-item';
    const copy = document.createElement('span'); copy.className = 'recent-copy';
    copy.append(flowNode('b', r.name), flowNode('small', r.company || '제조사 미제공'));
    item.append(copy, flowNode('span', '›', 'arrow'));
    item.onclick = () => openRecent(r.id);
    row.append(item);
  }
  if (showAllBtn) showAllBtn.hidden = recentShowAll || list.length <= RECENT_PREVIEW;
}
$('#recentShowAll')?.addEventListener('click', () => { recentShowAll = true; renderRecents(); });
async function openRecent(id) {
  searchFormFilter = null; showScreen('pill'); setPillStep('search');
  query = { item_seq: String(id) }; page = 1;
  await search();
  const first = $('#results button.result');
  if (first) first.click();
  else {
    try {
      const response = await fetch(API_BASE + '/api/liquids?' + new URLSearchParams({ item_seq: String(id) }));
      const data = await response.json();
      if (response.ok && data.items?.[0]) openMedicine(data.items[0], null, data.fetchedAt);
    } catch { /* Search status retains the failed lookup; no visualizer is opened. */ }
  }
}
// "내 약 보관함": deliberate, user-initiated saves (♡ toggle) - independent of "최근 확인한 약" above,
// which is an automatic view-history list. Do not merge the two. Schema mirrors a future
// `saved_medicines` table (itemSeq as the primary identifier, not the whole API response) so this
// can move to a real account/Supabase backend later without a data migration; see savedEntryFor().
const SAVED_KEY = 'savedMedicinesV1';
function readSaved() { try { const list = JSON.parse(localStorage.getItem(SAVED_KEY)); return Array.isArray(list) ? list.filter(entry => entry && entry.itemSeq) : []; } catch { return []; } }
function writeSaved(list) { try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch { /* Saves are device-local; a full disk/private-mode failure just means nothing persists. */ } }
function isSavedMedicine(itemSeq) { return readSaved().some(entry => entry.itemSeq === String(itemSeq)); }
function savedEntryFor(item, kind, prescription) {
  return {
    itemSeq: String(item.id), itemName: item.name, entpName: item.company || '',
    dosageForm: MedicineFlow.formOf(item) || item.permit?.data?.description || item.description || '',
    shape: item.shape || '', color: [item.colorFront, item.colorBack].filter(Boolean).join('/'),
    length: item.long ?? null, width: item.short ?? null, thickness: item.thick ?? null,
    imageUrl: safeImage(item.imageUrl) ? item.imageUrl : '', kind,
    metadata: { productCode: item.insuranceCode || null, recognizedProductCode: prescription?.productCode || null, officialProductName: item.name, manufacturer: item.company || '', dosageForm: MedicineFlow.formOf(item),
      ...MedicineFlow.getMedicineDestination(item), packaging: MedicineFlow.packageOf(item),
      dosePerAdministration: prescription?.dosePerAdministration ?? null, doseUnit: MedicineFlow.officialDoseUnit(item, prescription?.doseUnit), frequencyPerDay: prescription?.frequencyPerDay ?? null, durationDays: prescription?.durationDays ?? null }
  };
}
function saveMedicine(item, kind, prescription) {
  const list = readSaved();
  if (list.some(entry => entry.itemSeq === String(item.id))) return;
  list.unshift({ ...savedEntryFor(item, kind, prescription), savedAt: new Date().toISOString() });
  writeSaved(list); renderStorageList(); syncSaveButtons();
}
function unsaveMedicine(itemSeq) {
  writeSaved(readSaved().filter(entry => entry.itemSeq !== String(itemSeq)));
  renderStorageList(); syncSaveButtons();
}
function toggleSaveMedicine(item, kind, prescription) { if (isSavedMedicine(item.id)) unsaveMedicine(item.id); else saveMedicine(item, kind, prescription); }
// One shared button factory for every card (pill results, pill detail, rx candidates/selected,
// liquid results) so ♡/♥ state and behavior stay identical everywhere - see item 7/13 of the request.
function makeSaveButton(item, kind, prescription) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'save-heart'; button.dataset.saveId = String(item.id);
  button.onclick = event => { event.preventDefault(); event.stopPropagation(); toggleSaveMedicine(item, kind, prescription); };
  return button;
}
function syncSaveButtons() {
  document.querySelectorAll('.save-heart[data-save-id]').forEach(button => {
    const saved = isSavedMedicine(button.dataset.saveId);
    button.textContent = saved ? '♥ 저장됨' : '♡ 저장';
    button.setAttribute('aria-pressed', String(saved));
    button.setAttribute('aria-label', saved ? '내 약 보관함에서 삭제' : '내 약 보관함에 저장');
  });
}
let storageCompareIds = new Set();
function renderStorageList() {
  const list = readSaved();
  $('#storageCount').textContent = `저장한 약 ${list.length}개`;
  $('#storageEmpty').hidden = list.length > 0;
  $('#storageList').hidden = list.length === 0;
  storageCompareIds = new Set([...storageCompareIds].filter(id => list.some(entry => entry.itemSeq === id)));
  const container = $('#storageList'); container.replaceChildren();
  for (const entry of list) {
    const card = flowNode('article', '', 'storage-card');
    const canCompare = MedicineFlow.classifyMedicineForm(savedMedicineSnapshot(entry)) === 'solid-oral' && Number.isFinite(entry.length) && Number.isFinite(entry.width);
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'storage-check';
    checkbox.checked = storageCompareIds.has(entry.itemSeq); checkbox.disabled = !canCompare;
    checkbox.setAttribute('aria-label', `${entry.itemName} 비교에 포함`);
    checkbox.onchange = () => { if (checkbox.checked) storageCompareIds.add(entry.itemSeq); else storageCompareIds.delete(entry.itemSeq); syncStorageCompareButton(); };
    const info = flowNode('div', '', 'storage-card-info');
    info.append(flowNode('b', entry.itemName), flowNode('small', entry.entpName || '제조사 미제공'));
    if (MedicineFlow.classifyMedicineForm(savedMedicineSnapshot(entry)) === 'solid-oral') {
      info.append(flowNode('small', Number.isFinite(entry.length) && Number.isFinite(entry.width) ? `${entry.length} × ${entry.width}${Number.isFinite(entry.thickness) ? ' × ' + entry.thickness : ''} mm` : '치수 정보 부족'));
      info.append(flowNode('small', `${entry.shape || '모양 미제공'}${entry.dosageForm ? ' · ' + entry.dosageForm : ''}`));
    } else {
      info.append(flowNode('small', entry.dosageForm || '액체약'));
    }
    const actions = flowNode('div', '', 'flow-actions');
    const view = flowNode('button', MedicineFlow.getMedicineDestination(savedMedicineSnapshot(entry)).cta); view.type = 'button';
    view.onclick = () => openSavedMedicine(entry);
    const remove = flowNode('button', '삭제', 'btn-danger'); remove.type = 'button'; remove.setAttribute('aria-label', `${entry.itemName || '의약품'} 삭제`); remove.onclick = () => unsaveMedicine(entry.itemSeq);
    actions.append(view, remove);
    card.append(checkbox, info, actions); container.append(card);
  }
  syncStorageCompareButton();
}
function syncStorageCompareButton() { $('#storageCompareBtn').disabled = storageCompareIds.size < 2; }
// Saved entries intentionally carry only a trimmed snapshot (see savedEntryFor's comment) - refetch
// the current official data by item_seq rather than rendering from possibly-stale saved fields.
async function openSavedMedicine(entry) {
  const snapshot = savedMedicineSnapshot(entry);
  if (['other', 'unknown'].includes(MedicineFlow.classifyMedicineForm(snapshot))) return openMedicine(snapshot);
  if (MedicineFlow.classifyMedicineForm(savedMedicineSnapshot(entry)) === 'liquid') {
    showScreen('liquid'); $('#liquidWaySearch').click();
    try {
      const response = await fetch(API_BASE + '/api/liquids?' + new URLSearchParams({ item_seq: entry.itemSeq }));
      const data = await response.json();
      if (response.ok && data.items?.[0]) openMedicine(data.items[0], null, data.fetchedAt);
      else $('#liquidStatus').textContent = '저장된 제품 정보를 다시 불러오지 못했습니다.';
    } catch { $('#liquidStatus').textContent = '저장된 제품 정보를 다시 불러오지 못했습니다.'; }
    return;
  }
  searchFormFilter = null; showScreen('pill'); setPillStep('search');
  query = { item_seq: entry.itemSeq }; page = 1;
  await search();
  $('#results button.result')?.click();
}
$('#storageCompareBtn').onclick = () => {
  const entries = readSaved().filter(entry => storageCompareIds.has(entry.itemSeq) && MedicineFlow.classifyMedicineForm(savedMedicineSnapshot(entry)) === 'solid-oral');
  const list = $('#storageCompareList'); list.replaceChildren();
  const scale = Math.min(5, 220 / Math.max(1, ...entries.map(entry => entry.length || 0)));
  for (const entry of entries) {
    const button = flowNode('button', entry.itemName); button.type = 'button';
    button.append(flowNode('small', `${entry.entpName || '제조사 미제공'} · ${entry.length} × ${entry.width}${Number.isFinite(entry.thickness) ? ' × ' + entry.thickness : ''} mm`));
    button.append(flowNode('small', `${entry.shape || '모양 미제공'}${entry.dosageForm ? ' · ' + entry.dosageForm : ''}`));
    const silhouette = flowNode('span', '', 'rx-silhouette');
    silhouette.style.width = entry.length * scale + 'px'; silhouette.style.height = entry.width * scale + 'px';
    if (entry.shape === '장방형') silhouette.style.borderRadius = '999px';
    button.append(silhouette, flowNode('small', '개별 3D 실물크기 확인 →'));
    button.onclick = () => openSavedMedicine(entry);
    list.append(button);
  }
  $('#storageComparison').hidden = false; $('#storageComparison').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
// Results render in batches of REVEAL_STEP instead of all at once inside a scrolling box - a
// scrollbar nested inside the page's own scroll was awkward to operate with a thumb on a phone.
// This only changes how many of the already-fetched (up to numOfRows=20) results are visible;
// the server-side pageNo/numOfRows paging (#prevPage/#nextPage) is unchanged.
const REVEAL_STEP = 5;
let revealedCount = 0, allResultItems = [];
// 홈의 "빠른 확인" 칩은 별도의 검색 시스템이 아니라 같은 통합검색 결과의 필터일 뿐이다(요청 8) - null이면
// 전체, 배열이면 MedicineFlow.classifyDisplayForm(item) 결과가 그 배열에 포함된 항목만 보여준다.
let searchFormFilter = null;
// 제형 배지(요청 1) - 정제/캡슐뿐 아니라 시럽·현탁액·산제·연고 등 통합검색 결과 전부에 붙는다.
// dosageFormLabel(공식 원문 제형명)이 있으면 그대로 쓰고, 없을 때만 5그룹 분류의 일반 명칭으로
// 대체한다 - 추정이 아니라 이미 공식 데이터에서 읽은 값을 우선한다.
const DISPLAY_FORM_BADGE = { 'tablet-capsule': '정제', 'syrup-liquid': '시럽', 'powder-sachet': '산제', topical: '외용제', other: '기타' };
function formBadgeLabel(item, displayForm) { return MedicineFlow.dosageFormLabel(item) || DISPLAY_FORM_BADGE[displayForm] || '기타'; }
function renderRevealedResults() {
  const results = $('#results');
  for (let i = results.children.length; i < Math.min(revealedCount, allResultItems.length); i++) {
    const { item, fetchedAt } = allResultItems[i];
    const displayForm = MedicineFlow.classifyDisplayForm(item);
    const button = document.createElement('button'); button.className = 'result'; button.type = 'button'; button.setAttribute('aria-pressed', String(selected?.id === item.id));
    const titleRow = document.createElement('span'); titleRow.className = 'result-title-row';
    titleRow.append(flowNode('b', item.name), flowNode('span', formBadgeLabel(item, displayForm), 'badge'));
    const company = document.createElement('small'); company.className = 'r-meta'; company.textContent = item.company || '제조사 미제공';
    // Item_seq (품목일련번호) is intentionally left off this compact card - it's still available
    // once selected, in the "추가 품목 정보 보기" accordion.
    const copy = document.createElement('span'); copy.className = 'result-copy'; copy.append(titleRow, company);
    if (displayForm === 'tablet-capsule') {
      // 정제/캡슐만 모양·색상·치수를 보여준다 - 3D 실물크기 확인에 실제로 필요한 정보라서 그대로 둔다.
      const identity = document.createElement('small'); identity.className = 'r-meta';
      identity.textContent = `${item.shape || '모양 미제공'} · ${item.colorFront || '색상 미제공'}${item.colorBack ? ' / ' + item.colorBack : ''}`;
      const dims = document.createElement('small'); dims.className = 'r-meta';
      dims.textContent = item.long && item.short ? `장축 × 단축 · ${item.long} × ${item.short} mm` : '치수 정보 부족';
      copy.append(identity, dims);
    } else {
      // 시럽/산제/외용제 등은 치수가 없다 - 대신 포장단위만 한 줄로 보여준다(요청 2: 제형에 맞지 않는
      // 정보를 보여주지 않는다).
      const packaging = document.createElement('small'); packaging.className = 'r-meta';
      packaging.textContent = MedicineFlow.packageOf(item) ? `포장단위 · ${MedicineFlow.packageOf(item)}` : '포장단위 정보 없음';
      copy.append(packaging);
    }
    if (safeImage(item.imageUrl)) button.append(productImage(item.imageUrl, '', 'result-photo'));
    // The heart is an in-card overlay (not a sibling wrapper) so #results keeps exactly one direct
    // child per result - existing code/tests index #results.children[N] and click it directly.
    // makeSaveButton() stops the click from bubbling to this button's own onclick below.
    // Same classification every entry point uses (isOralLiquidCandidate, see item 1/2 of the
    // request) - /api/medicines is the 낱알식별(pill) dataset so almost everything here is a real
    // pill, but a name search can still surface a liquid product by name match, and it must route
    // to the liquid screen instead of the pill 3D view just like the prescription flow already does.
    const liquid = isOralLiquidCandidate(item);
    button.append(copy, makeSaveButton(item, liquid ? 'liquid' : 'pill'));
    button.onclick = () => {
      if (rxSearchTarget) { acceptRxSearch(item, fetchedAt); return; }
      openMedicine(item, button, fetchedAt);
    };
    results.append(button);
  }
  $('#showMoreResults').hidden = revealedCount >= allResultItems.length;
  syncSaveButtons();
}
$('#showMoreResults').onclick = () => { revealedCount += REVEAL_STEP; renderRevealedResults(); };

function applySearchResult(data, otherData, nextPage) {
  page = data.page;
  const merged = new Map();
  // 허가정보(otherData)를 먼저 넣고 낱알식별(data)로 덮어써서, 같은 품목이 두 소스에 모두 있으면
  // 치수·모양이 있는 낱알식별 데이터가 우선한다.
  if (otherData && Array.isArray(otherData.items)) for (const item of otherData.items) if (item && typeof item === 'object') merged.set(String(item.id), { item, fetchedAt: otherData.fetchedAt });
  for (const item of (Array.isArray(data.items) ? data.items : [])) if (item && typeof item === 'object') merged.set(String(item.id), { item, fetchedAt: data.fetchedAt });
  let combined = [...merged.values()];
  // "빠른 확인" 칩에서 들어온 경우에만 결과를 좁힌다 - 별도 검색이 아니라 같은 결과의 필터일 뿐이다.
  if (searchFormFilter) combined = combined.filter(({ item }) => searchFormFilter.includes(MedicineFlow.classifyDisplayForm(item)));
  $('#searchStatus').textContent = combined.length ? `총 ${data.total}개 제품 · 제조사와 함량을 확인해주세요.` : '검색 결과가 없습니다. 제품명을 확인하거나 치수를 직접 입력해주세요.';
  allResultItems = combined;
  $('#results').replaceChildren();
  revealedCount = REVEAL_STEP;
  renderRevealedResults();
  if (!allResultItems.length) renderEmpty($('#results'), '검색된 약이 없습니다. 포장에 적힌 제품명을 확인해주세요.', '검색어 다시 입력', () => $('#query').focus());
  $('#pagination').hidden = data.total <= data.pageSize;
  $('#prevPage').disabled = page <= 1; $('#nextPage').disabled = page * data.pageSize >= data.total || page >= 100;
  $('#pageLabel').textContent = `${page} / ${Math.ceil(data.total / data.pageSize)}`;
}
async function search(nextPage = 1) {
  const cacheKey = searchCacheKey(query, nextPage);
  // 섹션 9: 같은 조건 검색이 이미 진행 중이면(버튼 연타 등) 새 request를 만들지 않는다.
  if (cacheKey === searchInFlightKey) return;
  controller?.abort(); controller = new AbortController(); const current = controller;
  searchInFlightKey = cacheKey;
  $('#searchStatus').textContent = '의약품 정보를 찾고 있습니다…';
  renderLoading($('#results')); $('#pagination').hidden = true; $('#showMoreResults').hidden = true;
  allResultItems = []; revealedCount = 0;
  try {
    const params = new URLSearchParams({ ...query, pageNo: nextPage, numOfRows: 20 });
    // 통합검색(요청 1/8) - 정제·캡슐뿐 아니라 시럽·현탁액·산제·연고 등 모든 제형이 한 검색에서 나오도록
    // "약 직접 추가"(searchAddMedicine)가 이미 쓰는 두 공식 데이터소스를 함께 조회한다 - 검색 로직을
    // 중복 구현하지 않는다. 페이지네이션/오류 상태는 계속 /api/medicines(낱알식별) 기준이고,
    // /api/liquids(제품허가정보)는 실패해도 조용히 건너뛴다 - 있으면 보강되는 추가 데이터일 뿐이다.
    const otherPromise = fetch(API_BASE + '/api/liquids?' + params, { signal: current.signal })
      .then(r => r.ok ? r.json() : null).catch(() => null);
    // 목록은 가벼운 데이터만 받는다(light=1) - 허가정보/e약은요는 항목을 실제로 선택했을 때만
    // item_seq 단일 조회로 가져온다(ensureMedicineDetail). 항목마다 미리 다 받아오던 방식이 검색을
    // 느리게 하고(최대 40회 추가 API 호출), 식약처 API 호출 한도를 소진시켜 검색 실패로 이어졌다.
    const response = await fetch(API_BASE + '/api/medicines?' + new URLSearchParams({ ...query, pageNo: nextPage, numOfRows: 20, light: '1' }), { signal: current.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || '검색에 실패했습니다.');
    if (!data || typeof data !== 'object') throw new Error('검색 정보를 불러오지 못했습니다. 다시 시도해주세요.');
    const otherData = await otherPromise;
    if (current !== controller) return;
    applySearchResult(data, otherData, nextPage);
  } catch (error) {
    if (current === controller && error.name !== 'AbortError') {
      $('#searchStatus').textContent = error instanceof TypeError ? '네트워크 연결을 확인해주세요.'
        : error instanceof SyntaxError ? '검색 서버에 연결되지 않았습니다. 앱 서버를 실행해주세요.'
        : error.message;
      renderEmpty($('#results'), '약 정보를 가져오지 못했습니다.', '다시 시도', () => search(nextPage));
    }
  } finally {
    if (current === controller) $('#results').removeAttribute('aria-busy');
    if (searchInFlightKey === cacheKey) searchInFlightKey = null;
  }
}
$('#searchForm').onsubmit = event => {
  event.preventDefault();
  // trim + 연속 공백 정리만 한다 - 한글 제품명을 임의로 바꾸거나 fuzzy matching을 넣지 않는다.
  const clean = value => value.trim().replace(/\s+/g, ' ');
  query = { item_name: clean($('#query').value), entp_name: clean($('#companyQuery').value), item_seq: $('#itemSeqQuery').value.trim() };
  if (!Object.values(query).some(Boolean)) { $('#searchStatus').textContent = '의약품 이름 또는 추가 검색 조건을 입력해주세요.'; $('#query').focus(); return; }
  search();
};
$('#prevPage').onclick = () => search(page - 1); $('#nextPage').onclick = () => search(page + 1);
const panel = $('#calPanel'), range = $('#calRange'), toggle = $('#toggleCal');
toggle.onclick = () => { panel.classList.toggle('open'); toggle.setAttribute('aria-expanded', panel.classList.contains('open')); };
range.value = (calibration?.scale || 1) * 100;
function previewCal() { $('#card').style.width = (53.98 * 3.7795275591 * Number(range.value) / 100) + 'px'; $('#calValue').textContent = range.value + '%'; }
range.oninput = previewCal;
$('#saveCal').onclick = () => {
  if (Math.abs((window.visualViewport?.scale || 1) - 1) > .01) { $('#calValue').textContent = '화면 확대를 해제하고 보정해주세요.'; return; }
  calibration = { scale: Number(range.value) / 100, dpr: window.devicePixelRatio };
  try { localStorage.setItem('pillCalV2', JSON.stringify(calibration)); } catch { /* Session calibration still works. */ }
  applyCal(calibration.scale); panel.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = '다시 보정'; render();
};
window.visualViewport?.addEventListener('resize', () => applyCal(calibration?.scale || 1));
window.addEventListener('resize', () => applyCal(calibration?.scale || 1));
previewCal(); applyCal(calibration?.scale || 1); render();
  // Top-level screen switch. Kept attribute-driven ([data-mode]) exactly like the old pill/liquid
  // toggle it replaces, so the same handler covers the new Home cards, the bottom nav, and the
  // liquid/settings back buttons - and #pillTool/#liquidTool keep the exact class-based show/hide
  // ('hidden' class on pillTool, 'active' class on liquidTool) other code and tests rely on.
  function showScreen(mode) {
    // Login-first gate (요청 2): while open, only login and onboarding screens are reachable, so a
    // bottom-nav/top-nav tap or a back-btn can never route around it. openGate()/closeGate() are the
    // only things that flip authGateOpen - see initAuth() near the end of this file.
    if (authGateOpen && !['login', 'consent', 'profile'].includes(mode)) return;
    const home = document.querySelector('#screenHome'), settings = document.querySelector('#screenSettings');
    const login = document.querySelector('#screenLogin'), profile = document.querySelector('#screenProfile');
    const pillTool = document.querySelector('#pillTool'), liquidTool = document.querySelector('#liquidTool');
    if (home) home.hidden = mode !== 'home';
    document.querySelector('#prescriptionTool').hidden = mode !== 'prescription';
    document.querySelector('#storageTool').hidden = mode !== 'storage';
    window.dispatchEvent(new CustomEvent('screenchange', { detail: mode }));
    if (settings) settings.hidden = mode !== 'settings';
    $('#screenConsent').hidden = mode !== 'consent';
    if (login) login.hidden = mode !== 'login';
    if (profile) profile.hidden = mode !== 'profile';
    pillTool.classList.toggle('hidden', mode !== 'pill');
    liquidTool.classList.toggle('active', mode === 'liquid');
    // Lazy-load heavy, screen-specific modules only once the screen that actually needs them is
    // first shown (Phase 3 성능) - Home/설정/로그인/프로필 stay light. Each ensure*() is idempotent.
    if (mode === 'pill') { ensureThree3D(); ensureDoseCalc(); }
    if (mode === 'liquid') { ensureDoseCalc(); ensurePouchCrop(); }
    if (mode === 'prescription') ensureDoseCalc();
    document.querySelectorAll('[data-mode]').forEach(x => {
      // "약 검색" 하단 nav는 pill/liquid/storage 화면 어디에 있든(제형에 따라 자동으로 갈리므로) 계속
      // 활성으로 보인다 - 예전 "빠르게 보기" 중간 허브 화면은 제거했다.
      const navMode = ['pill', 'liquid', 'storage'].includes(mode) ? 'pill' : mode === 'profile' ? 'settings' : mode;
      const active = x.dataset.mode === (x.closest('nav') ? navMode : mode);
      x.classList.toggle('active', active);
      if (x.closest('nav') && active) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current');
    });
    if (mode === 'pill') syncPillStep();
    syncThreeVisibility();
    window.scrollTo(0, 0);
  }
  // The 3D scene is the app's sole tablet viewer now (no 2D/3D tab to drive show()/hide() any more),
  // so its render loop follows whether the pill screen is on screen AND whether the result step
  // (where the 3D tool card actually lives in the DOM) is the one showing - the search step never
  // renders the tool card at all, at any width.
  function syncThreeVisibility() {
    if (!three3d) return;
    const onPillScreen = !document.querySelector('#pillTool').classList.contains('hidden');
    const onResultStep = document.querySelector('#pillTool').dataset.step === 'result';
    if (onPillScreen && onResultStep) three3d.show(); else three3d.hide();
  }
  // 홈/nav의 일반 "약 검색" 진입점은 항상 필터 없는 통합검색으로 리셋한다 - 두 "빠른 확인" 칩
  // (크기 확인/맛·복용감)만 아래 별도 핸들러에서 searchFormFilter를 설정한 뒤 직접 showScreen을 부른다.
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { if (b.dataset.mode === 'pill') searchFormFilter = null; showScreen(b.dataset.mode); });
  // 필터 칩은 항상 새 검색 단계에서 시작한다 - showScreen만 부르면 이전에 보고 있던 결과 화면으로
  // 그대로 돌아가(syncPillStep의 "마지막 상태 복원") 방금 누른 필터가 적용된 새 검색인지 알기 어렵다.
  $('#quickChipSize')?.addEventListener('click', () => { searchFormFilter = ['tablet-capsule']; showScreen('pill'); setPillStep('search'); });
  $('#quickChipTaste')?.addEventListener('click', () => { searchFormFilter = ['tablet-capsule', 'syrup-liquid', 'powder-sachet']; showScreen('pill'); setPillStep('search'); });

  // The pill tool always steps through search -> result (compact search bar + full-width result),
  // at every screen width - see the `#pillTool[data-step]` CSS rules. `smooth` requires a real layout
  // engine (no-op/instant in the happy-dom test harness, which has no scrolling concept anyway) - so
  // selecting a product visibly glides to the result area instead of an abrupt jump.
  function setPillStep(step) {
    document.querySelector('#pillTool').dataset.step = step;
    const result = step === 'result';
    $('#searchBarFull').hidden = result; $('#searchPanel').hidden = result;
    $('#searchBarCompact').hidden = !result; $('#resultView').hidden = !result;
    syncThreeVisibility();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  // Re-entering pill mode (Home card / bottom-nav tap) resumes the result screen only if the user
  // actually did something this session - NOT just because the manual-entry fields still hold their
  // non-empty placeholder example values (17.2/7.1), which would otherwise always look "engaged".
  function syncPillStep() { setPillStep(pillEngaged ? 'result' : 'search'); }
  document.querySelector('#backToHomeFromSearch').onclick = () => rxSearchTarget ? $('#rxSearchCancel').click() : showScreen('home');
  document.querySelector('#backToSearchFromResult').onclick = () => setPillStep('search');
  document.querySelector('#settingsCalRow').onclick = () => { showScreen('pill'); setPillStep('result'); if (!panel.classList.contains('open')) toggle.click(); };

  showScreen('login'); // safe synchronous default - no flash of home content before auth resolves
  initAuth();
  const level=document.querySelector('#levelRange'),maxMl=document.querySelector('#maxMl'),cupShape=document.querySelector('#cupShape');
  function liquidRender(){const p=Number(level.value)/100,m=Math.max(0,Number(maxMl.value)||0);const ratio=cupShape.value==='taper'?(.45*p+.55*p*p):p;const ml=Math.round(m*ratio*10)/10;document.querySelector('#currentMl').value=ml;document.querySelector('#volumeText').textContent=ml+' mL';document.querySelector('#levelPercent').textContent=level.value+'%';document.querySelector('#levelLine').style.bottom=level.value+'%'}
  [level,maxMl,cupShape].forEach(x=>x.addEventListener('input',liquidRender));liquidRender();

// ---- Login/profile gate (요청 1-12) --------------------------------------------------------------
// openGate()/closeGate() are the only things that flip authGateOpen (see showScreen()'s guard above).
function openGate(mode) { authGateOpen = true; document.body.classList.add('gate-active'); showScreen(mode); }
function closeGate() { authGateOpen = false; document.body.classList.remove('gate-active'); showScreen('home'); }

function renderProfileSummaries() {
  const parts = [];
  if (patientAgeYears != null) parts.push(`만 ${patientAgeYears}세`);
  const sexLabel = { male: '남성', female: '여성' }[currentProfile?.sex];
  if (sexLabel) parts.push(sexLabel);
  if (patientWeightKg != null) parts.push(`${patientWeightKg}kg`);
  const summaryText = parts.length ? parts.join(' · ') : '프로필에 나이·체중 정보가 없습니다.';
  const rxSummary = $('#rxProfileSummaryText'); if (rxSummary) rxSummary.textContent = summaryText;
  const settingsStatus = $('#settingsProfileStatus');
  if (settingsStatus) settingsStatus.textContent = authSession ? (parts.length ? parts.join(' · ') : '정보 없음') : '로그인 필요';
}
// (처방 1회량 + 프로필의 birth_date/weight_kg) -> dose analysis가 바로 쓰는 patientAgeYears/patientWeightKg
// (요청 9). auth.dosePatientFromProfile이 실제 계산이고, 여기는 그 결과를 기존 dose analysis 변수에
// 연결하고 화면을 갱신하는 접착 코드일 뿐이다.
function applyProfileToPatientFields(profile) {
  currentProfile = profile || null;
  const derived = authApi ? authApi.dosePatientFromProfile(profile) : { weightKg: null, ageYears: null };
  patientWeightKg = derived.weightKg; patientAgeYears = derived.ageYears;
  renderProfileSummaries();
  rxGroups.forEach(group => { if (group.chosen) renderRxDoseDetail(group); });
}

let providerAvailability = {}, currentConsent = null;
function renderLoginProviders() {
  const container = $('#loginProviders'); if (!container || !authApi) return;
  container.replaceChildren();
  for (const provider of authApi.OAUTH_PROVIDERS) {
    const row = document.createElement('div');
    const button = document.createElement('button');
    button.type = 'button'; button.className = `social-login social-${provider.id}`;
    button.disabled = !provider.enabled || providerAvailability[provider.id] !== true;
    const symbol = document.createElement('span'); symbol.className = 'social-symbol'; symbol.setAttribute('aria-hidden', 'true');
    const img = document.createElement('img'); img.alt = '';
    img.src = `/brand/${{ google: 'google-g.png', kakao: 'kakao-login.png', naver: 'naver-icon.png' }[provider.id]}`;
    symbol.append(img);
    const label = document.createElement('span'); label.textContent = provider.label;
    button.append(symbol, label);
    if (!button.disabled) button.onclick = () => startOAuthLogin(provider.id);
    row.append(button);
    if (button.disabled) {
      const status = document.createElement('p'); status.className = 'provider-status'; status.id = `provider-status-${provider.id}`;
      status.textContent = !provider.enabled ? '준비 중' : providerAvailability[provider.id] === false ? '로그인 연결 준비 중' : '로그인 연결 확인 중';
      button.setAttribute('aria-describedby', status.id); row.append(status);
    }
    container.append(row);
  }
}
function startOAuthLogin(providerId) {
  if (!authApi || !authConfigData || providerAvailability[providerId] !== true) { $('#loginStatus').textContent = '로그인을 사용할 수 없습니다. 잠시 후 다시 시도해주세요.'; return; }
  location.href = authApi.buildAuthorizeUrl(authConfigData, providerId, location.origin + location.pathname);
}
function syncConsentChoices() {
  const boxes = [$('#consentTerms'), $('#consentPrivacy'), $('#consentMarketing')];
  $('#consentAll').checked = boxes.filter(box => !box.disabled).every(box => box.checked);
  $('#consentAll').indeterminate = boxes.some(box => box.checked) && !$('#consentAll').checked;
  $('#consentNext').disabled = !boxes[0].checked || !boxes[1].checked || !authApi?.consentDocumentsReady(boxes[2].checked);
}
function openConsentOnboarding() {
  currentConsent = null; $('#consentForm').reset();
  $('#consentMarketing').disabled = !authApi.consentDocumentsReady(true);
  $('#consentStatus').textContent = authApi.consentDocumentsReady() ? '' : '약관 문서를 준비 중입니다. 문서가 등록되면 가입을 계속할 수 있어요.';
  syncConsentChoices(); openGate('consent');
}
for (const id of ['consentTerms', 'consentPrivacy', 'consentMarketing']) $('#' + id).onchange = syncConsentChoices;
$('#consentAll').onchange = () => {
  for (const id of ['consentTerms', 'consentPrivacy', 'consentMarketing']) if (!$('#' + id).disabled) $('#' + id).checked = $('#consentAll').checked;
  syncConsentChoices();
};
document.querySelectorAll('[data-consent-document]').forEach(button => button.onclick = () => {
  const doc = authApi?.CONSENT_DOCUMENTS[button.dataset.consentDocument];
  if (doc?.url && doc?.version) window.open(doc.url, '_blank', 'noopener,noreferrer');
  else alert('약관 문서를 준비 중입니다. 아직 동의를 받지 않습니다.');
});
$('#loginPrivacyLink').onclick = () => $('#privacyLink').click();
$('#consentForm').onsubmit = async event => {
  event.preventDefault();
  if ($('#consentNext').disabled || !authSession) return;
  $('#consentNext').disabled = true;
  const savingSession = authSession;
  try {
    const savedConsent = await authApi.saveConsent(authConfigData, authSession, {
      terms: $('#consentTerms').checked, privacy: $('#consentPrivacy').checked, marketing: $('#consentMarketing').checked
    }, fetch);
    if (authSession !== savingSession) return;
    currentConsent = savedConsent;
    openProfileOnboarding();
  } catch { $('#consentStatus').textContent = '동의 내역을 저장하지 못했습니다. 다시 시도해주세요.'; }
  finally { syncConsentChoices(); }
};
$('#consentLogout').onclick = () => $('#settingsLogoutRow').click();
$('#loginRetry').onclick = () => initAuth();

const SEX_LABEL = { male: '남성', female: '여성', prefer_not_to_say: '선택하지 않음' };
function fillProfileForm(profile) {
  $('#profileBirthDate').value = profile?.birth_date || '';
  const sex = profile?.sex || 'prefer_not_to_say';
  document.querySelectorAll('#profileSexGroup [data-sex]').forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.sex === sex)));
  $('#profileWeight').value = profile?.weight_kg != null ? profile.weight_kg : '';
  $('#profileStatus').textContent = '';
  // Read-mode summary (요청 13) - shown instead of the form when editing an existing profile, so the
  // form's inputs are never on screen unless the person actually asked to change something.
  $('#profileReadBirth').textContent = profile?.birth_date || '입력 필요';
  $('#profileReadSex').textContent = SEX_LABEL[sex] || '선택하지 않음';
  $('#profileReadWeight').textContent = profile?.weight_kg != null ? `${profile.weight_kg} kg` : '입력 필요';
}
function showProfileReadMode(show) { $('#profileReadView').hidden = !show; $('#profileForm').hidden = show; }
function openProfileOnboarding() {
  profileMode = 'onboarding';
  $('#profileBackBtn').hidden = true;
  $('#profileStep').hidden = false;
  $('#profileTitle').textContent = '복용 정보를 더 정확하게 보여드리기 위해 필요해요.';
  $('#profileIntro').textContent = '생년월일·성별·체중은 선택 입력이에요. 내 정보에서 언제든 수정할 수 있어요.';
  $('#profileSave').textContent = '시작하기';
  fillProfileForm(null);
  showProfileReadMode(false);
  openGate('profile');
}
function openProfileEditor(returnMode) {
  $('#profileStep').hidden = true;
  profileMode = 'edit'; profileReturnMode = returnMode;
  $('#profileBackBtn').hidden = false;
  $('#profileTitle').textContent = '내 정보';
  $('#profileIntro').textContent = '복용량 비교와 의약품 안내에 사용하는 기본 정보입니다.';
  $('#profileSave').textContent = '변경사항 저장';
  fillProfileForm(currentProfile);
  showProfileReadMode(true);
  showScreen('profile');
}
$('#profileEditToggle').onclick = () => showProfileReadMode(false);
$('#profileBackBtn').onclick = () => showScreen(profileReturnMode);
$('#settingsProfileRow').onclick = () => openProfileEditor('settings');
$('#rxProfileEditBtn').onclick = () => openProfileEditor('prescription');
document.querySelectorAll('#profileSexGroup [data-sex]').forEach(btn => btn.onclick = () => {
  document.querySelectorAll('#profileSexGroup [data-sex]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
});
$('#profileBirthDate').max = new Date().toISOString().slice(0, 10); // 미래 생년월일 선택 차단 (요청 5)
$('#profileForm').onsubmit = async event => {
  event.preventDefault();
  if (profileMode === 'onboarding' && !authApi?.hasRequiredConsent(currentConsent)) { openConsentOnboarding(); return; }
  const weightRaw = $('#profileWeight').value;
  let weightKg = null;
  if (weightRaw !== '') {
    const n = Number(weightRaw);
    if (!Number.isFinite(n) || n <= 0 || n > 300) { $('#profileStatus').textContent = '체중은 0보다 크고 300kg 이하의 숫자로 입력해주세요.'; return; }
    weightKg = n;
  }
  const birthDate = $('#profileBirthDate').value || null;
  if (birthDate && (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || birthDate > new Date().toISOString().slice(0, 10))) { $('#profileStatus').textContent = '생년월일을 다시 확인해주세요.'; $('#profileBirthDate').setAttribute('aria-invalid', 'true'); return; }
  $('#profileBirthDate').removeAttribute('aria-invalid');
  const sex = document.querySelector('#profileSexGroup [aria-pressed="true"]')?.dataset.sex || 'prefer_not_to_say';
  if (!authApi || !authConfigData || !authSession) { $('#profileStatus').textContent = '로그인 정보를 확인할 수 없습니다. 다시 로그인해주세요.'; return; }
  if ($('#profileSave').disabled) return;
  $('#profileSave').disabled = true;
  $('#profileStatus').dataset.tone = '';
  $('#profileStatus').textContent = '저장하는 중…';
  const savingSession = authSession;
  try {
    const saved = await authApi.saveProfile(authConfigData, authSession, { birthDate, sex, weightKg }, fetch);
    if (authSession !== savingSession) return;
    applyProfileToPatientFields(saved);
    if (profileMode === 'onboarding') closeGate(); else showScreen(profileReturnMode);
    showToast('✓ 저장되었습니다');
  } catch { $('#profileStatus').dataset.tone = 'error'; $('#profileStatus').textContent = '프로필을 저장하지 못했습니다. 입력한 정보는 유지됩니다. 다시 저장해주세요.'; }
  finally { $('#profileSave').disabled = false; }
};
$('#settingsLogoutRow').onclick = async () => {
  const endingSession = authSession;
  const logout = authApi?.signOut(authConfigData, endingSession, fetch, localStorage);
  currentConsent = null; $('#consentForm').reset(); fillProfileForm(null);
  authSession = null; currentProfile = null; patientWeightKg = null; patientAgeYears = null;
  renderProfileSummaries(); openGate('login');
  const result = await logout;
  if (result?.remoteRevoked === false && !authSession) {
    $('#loginStatus').textContent = '이 기기에서는 로그아웃했습니다. 네트워크 오류로 서버 세션 종료는 확인하지 못했습니다.';
  }
};
// Ties auth.decideGateScreen's decision to the actual screen/gate state (요청 17's scenarios map
// 1:1 onto this). Shared by initAuth() and by the test harness (__rxTest.applyAuthResolution), so the
// real decision logic is what's under test, not a re-implementation of it.
function applyAuthResolution(resolvedAuthApi, session, profile, config = null, consent = null) {
  currentConsent = consent;
  authApi = resolvedAuthApi; authSession = session; authConfigData = config ?? authConfigData;
  const next = authApi.decideGateScreen(session, profile, consent);
  if (next === 'home') { applyProfileToPatientFields(profile); closeGate(); }
  else if (next === 'consent-onboarding') openConsentOnboarding();
  else if (next === 'profile-onboarding') openProfileOnboarding();
  else openGate('login');
  return next;
}
async function initAuth() {
  // Test harness note: happy-dom's disableJavaScriptFileLoading blocks dynamic import() (see
  // dose-calc.js's own comment above), so real auth resolution never completes there - tests exercise
  // the gate/decision logic directly via applyAuthResolution() with a real, Node-imported auth.js
  // instead (see test/ui.test.js). Existing non-auth tests set window.__TEST_SKIP_AUTH_GATE__ so the
  // ~200 tests that predate login can keep clicking straight into the app exactly as before.
  if (window.__TEST_SKIP_AUTH_GATE__) { closeGate(); renderRecents(); renderStorageList(); syncSaveButtons(); return; }
  openGate('login');
  $('#loginStatus').textContent = ''; $('#loginRetry').hidden = true;
  renderRecents(); renderStorageList(); syncSaveButtons(); // localStorage-only; safe to render while gated
  // Auth-gate tests drive applyAuthResolution() themselves (see test/ui.test.js) and must not race a
  // second, real resolution attempt below - the real import() would reject asynchronously in the test
  // harness regardless and its catch{} would silently flip whatever gate state the test just set up.
  if (window.__TEST_MANUAL_AUTH__) return;
  try {
    authApi = await import('./auth.js');
    renderLoginProviders();
    const config = await authApi.loadConfig(fetch);
    authConfigData = config;
    // session 없음은 무조건 로그인 화면 - 브라우저 로그인 키가 아직 Supabase Dashboard/.dev.vars에
    // 설정되지 않은 환경도 예외가 아니다. 이전에는 여기서 closeGate()로 홈을 열어버렸는데, 그게 바로
    // "로그인 화면 없이 곧장 홈으로 진입"하던 원인이었다 - 로그인 버튼은 눌러도 동작하지 않겠지만,
    // 게이트 자체를 우회시켜서는 안 된다. 로그인 화면은 openGate('login')으로 이미 열려 있으므로
    // 여기서는 상태 메시지만 남기고 그대로 둔다.
    if (!config) { $('#loginStatus').textContent = '로그인을 사용할 수 없습니다. 잠시 후 다시 시도해주세요.'; $('#loginRetry').hidden = false; return; }
    try { providerAvailability = await authApi.fetchProviderAvailability(config, fetch); }
    catch { providerAvailability = {}; $('#loginStatus').textContent = '로그인 연결 상태를 확인하지 못했습니다.'; $('#loginRetry').hidden = false; }
    renderLoginProviders();
    const session = await authApi.resolveSession(config, { fetchImpl: fetch, storage: localStorage });
    let profile = null;
    if (session) profile = await authApi.fetchProfile(config, session, fetch);
    const consent = session && !profile ? await authApi.fetchConsent(config, session, fetch) : null;
    applyAuthResolution(authApi, session, profile, config, consent);
  } catch {
    // auth 모듈/네트워크 오류가 나도 마찬가지로 로그인 화면에 그대로 둔다 - session이 없는 상태를
    // 홈으로 여는 예외는 없다.
    $('#loginStatus').textContent = '로그인 또는 계정 정보를 확인하지 못했습니다. 다시 시도해주세요.';
    $('#loginRetry').hidden = false;
  }
}

// Click-to-enlarge photo modal. Reuses the same validated URL/productImage() helper as the compact
// display - never a second, unvalidated path to render an image. <dialog>.showModal()/close() are
// guarded since the happy-dom test harness doesn't implement them; a plain `open` attribute toggle
// is a reasonable fallback there (and is what a very old WebView would need anyway).
const photoModal = $('#photoModal');
function openPhotoModal() {
  if (!selected || !safeImage(selected.imageUrl)) return;
  $('#photoModalImage').replaceChildren(productImage(selected.imageUrl, `${selected.name} 제품 사진`));
  if (typeof photoModal.showModal === 'function') photoModal.showModal(); else photoModal.setAttribute('open', '');
}
function closePhotoModal() {
  if (typeof photoModal.close === 'function') photoModal.close(); else photoModal.removeAttribute('open');
}
$('#quickPhotoBtn').onclick = openPhotoModal;
$('#closePhotoModal').onclick = closePhotoModal;
photoModal.addEventListener('click', event => { if (event.target === photoModal) closePhotoModal(); });

const APP_VERSION = 'v1.0.0';
document.querySelectorAll('#appVersion, #appVersionFooter').forEach(el => el.textContent = APP_VERSION);
// Placeholder pages - replace with real, published policy/terms URLs before release.
for (const [id, label] of [['privacyLink', '개인정보처리방침'], ['termsLink', '이용약관']]) {
  const link = $('#' + id);
  if (link) link.onclick = event => { event.preventDefault(); alert(`${label} 페이지를 준비 중입니다.`); };
}

// Prescription and liquid flows reuse the official search and existing product viewer.
function flowNode(tag, text, className = '') {
  const el = document.createElement(tag); el.textContent = text; el.className = className; return el;
}
function medicineSize(item) {
  return [item.long, item.short, item.thick].every(v => Number.isFinite(v) && v > 0)
    ? `${item.long} × ${item.short} × ${item.thick} mm` : '공식 치수 정보 부족';
}
let medSchema;
const loadMedSchema = () => medSchema ? Promise.resolve(medSchema) : import('./prescription-schema.js').then(m => (medSchema = m));
function rxNormalize(text) {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}
function rxTerm(text) {
  // Never forward dosage columns, names, patient numbers or a whole OCR line.
  const clean = text.normalize('NFKC').replace(/([가-힣]) (?=[가-힣])/g, '$1');
  const match = clean.match(/[가-힣a-zA-Z][가-힣a-zA-Z-]{1,40}(?:\s*\d+(?:\.\d+)?(?:\s*\/\s*[\dOo]+(?:\.\d+)?)?\s*(?:mg|mcg|밀리그램|마이크로그램|g)?)?/i);
  return match ? match[0].trim() : '';
}
function extractRxNames(raw) {
  const names = [];
  for (const line of raw.split(/\r?\n/)) {
    // Conservative: recognize drug-form suffixes; uncertain/missing rows can be typed manually.
    const re = /[가-힣A-Za-z][가-힣A-Za-z-]{1,35}(?:정|캡슐|시럽|현탁액|내복액|산|과립)(?:\s*\d+(?:\.\d+)?(?:\s*\/\s*[\dOo]+(?:\.\d+)?)?\s*(?:mg|mcg|밀리그램|g)?)?/g;
    for (const match of line.replace(/([가-힣]) (?=[가-힣])/g, '$1').matchAll(re)) {
      if (!/처방|환자|성명|병원|의원|보험|조제|주민|주소|전화/.test(match[0])) names.push(match[0].trim());
    }
  }
  return [...new Set(names)].slice(0, 20);
}
function rxScore(name, term) {
  const a = rxNormalize(name), b = rxNormalize(term);
  // Compare a possible OCR zero only inside the numeric strength; never rewrite the name.
  const strength = b.match(/\d+(?:\.\d+)?(?:\/[\do]+(?:\.\d+)?)?/g)?.join('/').replace(/o/g, '0') || '';
  const candidateStrength = a.match(/\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?/g)?.join('/') || '';
  const root = b.match(/^[가-힣a-z-]+/)?.[0] || b;
  return (a === b ? 100 : 0) + (a.startsWith(root) ? 30 : 0) + (strength && strength === candidateStrength ? 50 : 0);
}
// item 14 fix: this fetch previously had no timeout of its own - only `signal`, which is the whole
// group's shared AbortController and is aborted just by starting a NEW search for that same group
// (see findRxCandidates). A single hung/very slow upstream request (MFDS itself, not this app) could
// therefore leave a prescription card reading "공식 제품 후보를 찾고 있습니다…" forever, since nothing
// ever settled the promise. AbortSignal.any([signal, AbortSignal.timeout(...)]) aborts a COPY used only
// for this one fetch on a timeout, leaving the caller's own `signal` (and its abort semantics used by
// findRxCandidates' own "was this superseded?" check) completely untouched.
let FLOW_SEARCH_TIMEOUT_MS = 15000; // test-only seam - see __rxTest.setFlowSearchTimeoutMs in ui.test.js
async function flowSearch(path, term, signal, page = 1) {
  const response = await fetch(API_BASE + path + '?' + new URLSearchParams({ item_name: term, pageNo: page, numOfRows: 20 }), { signal: AbortSignal.any([signal, AbortSignal.timeout(FLOW_SEARCH_TIMEOUT_MS)]) });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || '검색에 실패했습니다.');
    if (!data || typeof data !== 'object') throw new Error('검색 정보를 불러오지 못했습니다. 다시 시도해주세요.');
  return { ...data, items: Array.isArray(data.items) ? data.items.filter(item => item && typeof item === 'object') : [] };
}
let rxAbort = null, rxWorker = null, rxJob = 0, rxRequest = null, rxSelected = new Map();
let rxGroups = [], rxGroupSerial = 0;
// Dev-only: ?debugPrescription=1 shows exactly which pixels each numeric cell crop used and what each
// preprocessing variant read (item 11) - never rendered otherwise, and never part of the normal flow.
const DEBUG_PRESCRIPTION = new URLSearchParams(location.search).get('debugPrescription') === '1';
function renderPrescriptionDebug(debug, providerLabel) {
  document.querySelector('#rxDebugPanel')?.remove();
  if (!debug) return;
  const panel = document.createElement('details'); panel.id = 'rxDebugPanel'; panel.open = true;
  panel.style.cssText = 'margin:16px 0;padding:12px;border:2px dashed #c00;font-size:12px;background:#fff8f8';
  const summary = document.createElement('summary'); summary.textContent = `디버그: OCR Provider: ${providerLabel} · 열 경계 + ${debug.cells?.length || 0}개 셀 크롭 결과`;
  panel.append(summary);
  // item 7: OCR Provider - google-vision / google-vision-failed / local-tesseract.
  const providerLine = document.createElement('div'); providerLine.style.fontWeight = 'bold'; providerLine.textContent = `OCR Provider: ${providerLabel}`;
  panel.append(providerLine);
  if (debug.columns) {
    const cols = document.createElement('pre'); cols.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere';
    cols.textContent = `header: ${debug.columns.header ? JSON.stringify(debug.columns.header.columns) : '없음'}\nvertical lines(x): ${JSON.stringify(debug.columns.lines)}\ncolumn boundaries: ${JSON.stringify(debug.columns.columns)}`;
    panel.append(cols);
  }
  for (const cell of debug.cells || []) {
    const box = document.createElement('div'); box.style.cssText = 'margin:8px 0;padding:8px;border:1px solid #ddd';
    const title = document.createElement('b'); title.textContent = `${cell.drugName} · ${cell.field} (source: ${cell.source || 'n/a'})`;
    box.append(title);
    for (const attempt of cell.attempts || []) {
      const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:4px';
      if (attempt.dataUrl) { const img = document.createElement('img'); img.src = attempt.dataUrl; img.style.cssText = 'max-height:40px;border:1px solid #999'; row.append(img); }
      const label = document.createElement('span'); label.textContent = `${attempt.label}: "${attempt.text}" → ${attempt.value} (conf ${Math.round(attempt.confidence)})`;
      row.append(label); box.append(row);
    }
    if (cell.tokens) { const t = document.createElement('div'); t.textContent = `whole-strip text: "${cell.text}" → tokens ${JSON.stringify(cell.tokens)}`; box.append(t); }
    if (cell.chosen) { const c = document.createElement('div'); c.style.fontWeight = 'bold'; c.textContent = `선택된 값: ${cell.chosen.value} (${cell.chosen.label}, conf ${Math.round(cell.chosen.confidence)})`; box.append(c); }
    panel.append(box);
  }
  document.querySelector('#prescriptionTool')?.prepend(panel);
}
// One prescription document, one row per recognized drug. Detail is rendered only on demand.
let rxDetailState = null, rxDetailRequest = 0, rxPrescriptionDate = null;
let rxDailyCalc = null;
async function ensureRxDailyCalc() { return rxDailyCalc ||= await import('./prescription-dose.js'); }
function rxIngredient(item) {
  // 원본 MFDS ingredients 필드는 종종 내부 성분코드가 "[M105518]성분명"처럼 이름 앞에 그대로 붙어
  // 있다 - 사용자에게는 의미 없는 코드이므로 표시 전에 제거한다.
  const raw = (item?.permit?.data?.ingredients || '').replace(/^\[[^\]]*\]\s*/, '');
  return raw || item?.name?.match(/\(([^)]+)\)/)?.[1] || '성분 확인 필요';
}
function rxShortDose(group) {
  const row = group?.row ? rxDisplayRow(group) : null;
  if (!row) return '처방량 확인 필요';
  return `${row.dosePerAdministration ?? '?'}${row.doseUnit || '단위 확인'} · 하루 ${row.frequencyPerDay ?? '?'}회 · ${row.durationDays ?? '?'}일`;
}
function updateRxSelection() {
  rxSelected.clear();
  for (const group of rxGroups) if (group.chosen?.item) rxSelected.set(group.chosen.item.id, group.chosen);
  const section = $('#rxSelectedSection'); section.hidden = !rxGroups.length;
  $('#rxSelectedTitle').textContent = '처방약 확인';
  const date = rxPrescriptionDate ? new Date(rxPrescriptionDate) : null;
  $('#rxListMeta').textContent = `${rxGroups.length}개 의약품${date && Number.isFinite(date.getTime()) ? ' · ' + date.toLocaleDateString('ko-KR') : ''}`;
  const list = $('#rxSelectedList'); list.replaceChildren();
  rxGroups.forEach((group, index) => {
    const item = group.chosen?.item;
    const li = flowNode('li', '', 'rx-document-row');
    const button = flowNode('button', '', 'rx-row-button'); button.type = 'button'; button.dataset.groupId = group.id;
    button.id = `rxRow-${group.id}`;
    button.append(flowNode('span', String(index + 1).padStart(2, '0'), 'rx-row-number'));
    const copy = flowNode('span', '', 'rx-row-copy');
    copy.append(flowNode('strong', item?.name || group.term || '이름 확인 필요', 'rx-row-name'));
    copy.append(flowNode('span', `${rxIngredient(item)} · ${MedicineFlow.dosageFormLabel(item) || '제형 확인 필요'}`, 'rx-row-meta'));
    copy.append(flowNode('span', rxShortDose(group), 'rx-row-dose'));
    const confirmed = !!item && group.row && !group.row.needsReview && !!rxDisplayRow(group).doseUnit && [group.row.dosePerAdministration, group.row.frequencyPerDay, group.row.durationDays].every(n => Number.isFinite(n) && n > 0);
    const status = confirmed ? '✓ 확인됨' : group.failed ? '조회 재시도' : '확인 필요';
    copy.append(flowNode('span', status, 'rx-row-status'));
    button.append(copy, flowNode('span', '›', 'rx-row-chevron')); button.onclick = () => openRxDetail(group);
    li.append(button); list.append(li); group.el = li;
  });
}
function rxButton(label, className, action) {
  const button = flowNode('button', label, className); button.type = 'button'; button.onclick = action; return button;
}
function rxDialog() {
  let dialog = $('#rxDetailDialog');
  if (!dialog) {
    dialog = document.createElement('dialog'); dialog.id = 'rxDetailDialog'; dialog.setAttribute('aria-labelledby', 'rxDetailTitle');
    document.body.append(dialog);
    dialog.addEventListener('close', () => { const id = rxDetailState?.group.id; rxDetailRequest++; rxDetailState = null; $(`#rxRow-${id}`)?.focus(); });
  }
  return dialog;
}
function closeRxDetail() {
  const dialog = $('#rxDetailDialog'); rxDetailRequest++;
  if (dialog?.open) { if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open'); }
}
function openRxDetail(group, view = 'summary') {
  if (!group || !rxGroups.includes(group)) return;
  rxDetailState = { group, view }; rxDetailRequest++;
  const dialog = rxDialog(); dialog.replaceChildren();
  const head = flowNode('header', '', 'rx-detail-head');
  const back = rxButton(view === 'summary' ? '← 처방약 목록' : '← 처방약 상세', 'rx-detail-back', () => view === 'summary' ? closeRxDetail() : openRxDetail(group));
  const title = flowNode('h2', { summary: '처방약 상세', edit: '처방내용 수정', product: '제품 변경', dose: '용량 확인' }[view], 'rx-detail-title'); title.id = 'rxDetailTitle';
  head.append(back, title, rxButton('닫기', 'rx-detail-close', closeRxDetail));
  const body = flowNode('div', '', 'rx-detail-body'); dialog.append(head, body);
  if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); } else dialog.setAttribute('open', '');
  if (view === 'summary') renderRxSummary(body, group);
  if (view === 'edit') editRxRecognition(group, body);
  if (view === 'product') renderRxProducts(body, group);
  if (view === 'dose') renderRxDaily(body, group, rxDetailRequest);
  body.scrollTop = 0; back.focus();
}
function renderRxSummary(body, group) {
  const item = group.chosen?.item;
  const name = rxButton(item?.name || group.term, 'rx-detail-name', () => {
    if (!item) return openRxDetail(group, 'product');
    closeRxDetail(); openMedicine(item, null, group.chosen.fetchedAt);
  });
  name.append(flowNode('span', ' ›')); body.append(name, flowNode('p', rxIngredient(item), 'rx-detail-muted'), flowNode('p', rxShortDose(group), 'rx-detail-prescription'));
  const actions = flowNode('div', '', 'rx-detail-actions');
  // 요청: 공식 제품이 아직 확정되지 않은 상태(OCR 후보 확인 전)가 처방전 스캔 직후의 가장 흔한 기본
  // 상태다 - 이때도 처방전에서 읽은 1회량·하루 횟수(group.row)만 있으면 하루 총량(단위 기준)까지는
  // 보여줄 수 있으므로 버튼을 막지 않는다. 공식 비교(mg 환산) 실패와 버튼 비활성화는 서로 다른 문제다.
  const hasRowAmount = Number.isFinite(group.row?.dosePerAdministration) && Number.isFinite(group.row?.frequencyPerDay);
  const dose = rxButton('용량 확인', 'btn-primary rx-action-analyze', () => openRxDetail(group, 'dose')); dose.disabled = !item && !hasRowAmount;
  actions.append(dose, rxButton('처방내용 수정', 'rx-action-edit', () => openRxDetail(group, 'edit'))); body.append(actions);
  if (!item) body.append(flowNode('p', group.status || '공식 제품을 선택하면 용량과 제품 정보를 확인할 수 있어요.', 'rx-detail-muted'));
  const product = flowNode('section', '', 'rx-detail-product'); product.append(flowNode('h3', '제품 정보'));
  if (item) {
    product.append(flowNode('p', `${MedicineFlow.dosageFormLabel(item) || '제형 확인 필요'} · ${item.company || '제조사 미제공'}`));
    const details = document.createElement('details'); details.className = 'rx-official-text'; details.append(flowNode('summary', '공식 허가사항'));
    details.append(flowNode('p', item.permit?.data?.materials || '성분 함량 정보가 없습니다.'));
    details.append(flowNode('p', item.easy?.data?.usage || '공식 용법·용량은 용량 확인에서 조회할 수 있어요.'));
    appendRxOfficialLinks(details, item); product.append(details);
    const form = MedicineFlow.classifyDisplayForm(item);
    const label = form === 'tablet-capsule' ? '실물 크기' : ['syrup-liquid', 'powder-sachet'].includes(form) ? '액제 가이드' : null;
    if (label) product.append(rxButton(label, 'rx-action-size', () => { closeRxDetail(); openMedicine(item, null, group.chosen.fetchedAt); }));
  }
  product.append(rxButton('제품 변경', 'rx-action-product', () => openRxDetail(group, 'product'))); body.append(product);
  const extra = document.createElement('details'); extra.className = 'rx-detail-more'; extra.append(flowNode('summary', '더 보기'));
  extra.append(flowNode('p', group.source === 'manual' ? '직접 추가한 처방입니다.' : '처방전에서 확인한 내용입니다.'));
  if (item) extra.append(makeSaveButton(item, group.chosen.kind, rxDisplayRow(group)));
  extra.append(rxButton('이 처방에서 삭제', 'btn-danger rx-action-remove', () => {
    group.request?.abort(); rxGroups = rxGroups.filter(g => g !== group); closeRxDetail(); updateRxSelection();
  })); body.append(extra); syncSaveButtons();
}
function appendRxOfficialLinks(container, item) {
  for (const [label, raw] of [['공식 허가문서 열기', item?.permit?.data?.officialDocUrl], ['공식 문서 열기', item?.permit?.data?.efficacyDocUrl]]) {
    try { const url = new URL(raw); if (url.protocol !== 'https:' || url.hostname !== 'nedrug.mfds.go.kr') continue;
      const a = flowNode('a', label); a.href = url.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; container.append(a);
    } catch { /* Missing official link is not synthesized. */ }
  }
}
function renderRxProducts(body, group) {
  body.append(flowNode('h3', group.term), flowNode('p', group.status || '제품명·함량·제조사를 확인해주세요.', 'rx-detail-muted'));
  let pending = null;
  const candidates = flowNode('div', '', 'rx-product-options');
  for (const entry of group.candidates || []) {
    if (!entry?.item) continue;
    const label = flowNode('label', '', 'rx-product-option'), radio = document.createElement('input');
    radio.type = 'radio'; radio.name = `rx-product-${group.id}`; radio.value = entry.item.id; radio.checked = entry.item.id === group.chosen?.item.id;
    const copy = flowNode('span', entry.item.name); copy.append(flowNode('small', entry.item.company || '제조사 미제공'));
    radio.onchange = () => { pending = entry; confirm.disabled = false; }; label.append(radio, copy); candidates.append(label);
  }
  body.append(candidates);
  const confirm = rxButton('이 제품 선택', 'btn-primary rx-product-confirm', () => {
    if (!pending) return; group.chosen = pending; group.status = '✓ 공식 제품 확인됨'; updateRxSelection(); openRxDetail(group);
  }); confirm.disabled = true; body.append(confirm);
  body.append(rxButton('이름으로 다시 검색', 'rx-product-search', () => { closeRxDetail(); openRxSearch(group); }));
  if (group.failed || !group.candidates?.length) body.append(rxButton('후보 다시 찾기', 'rx-product-retry', () => findRxCandidates(group)));
}
function editRxRecognition(group, body) {
  group.request?.abort();
  const row = group.row || { drugName: group.term };
  const form = document.createElement('form'); form.className = 'rx-prescription-editor'; const controls = {};
  for (const [key, title] of [['drugName', '약 이름'], ['dosePerAdministration', '1회량'], ['doseUnit', '단위'], ['frequencyPerDay', '하루 횟수'], ['durationDays', '처방일수']]) {
    const label = flowNode('label', title, 'field'), input = document.createElement('input'); input.name = key; input.value = row[key] ?? '';
    input.type = /drugName|doseUnit/.test(key) ? 'text' : 'number'; input.required = true;
    if (input.type === 'number') { input.min = key === 'dosePerAdministration' ? '0.001' : '1'; input.step = key === 'dosePerAdministration' ? 'any' : '1'; input.inputMode = 'decimal'; }
    controls[key] = input; label.append(input); form.append(label);
  }
  const status = flowNode('p'); status.setAttribute('role', 'status'); form.append(status);
  const actions = flowNode('div', '', 'rx-detail-actions');
  const save = flowNode('button', '저장', 'btn-primary'); save.type = 'submit';
  actions.append(rxButton('취소', '', () => openRxDetail(group)), save); form.append(actions);
  form.onsubmit = async event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    const draft = Object.fromEntries(Object.entries(controls).map(([key, input]) => [key, input.type === 'number' ? Number(input.value) : input.value.trim()]));
    if (!draft.drugName || !draft.doseUnit || ![draft.dosePerAdministration, draft.frequencyPerDay, draft.durationDays].every(n => Number.isFinite(n) && n > 0) || !Number.isInteger(draft.frequencyPerDay) || !Number.isInteger(draft.durationDays)) { status.textContent = '처방 내용을 다시 확인해주세요.'; return; }
    const nameChanged = draft.drugName !== (row.drugName || group.term);
    group.row = { ...row, ...draft, userConfirmed: true, needsReview: false, strengthOrPackage: `${draft.dosePerAdministration}${draft.doseUnit}` }; group.term = draft.drugName;
    if (nameChanged) { group.ignoreOcrCode = true; group.chosen = null; group.candidates = []; }
    updateRxSelection(); openRxDetail(group); showToast('처방내용을 수정했습니다. 목록에서 처방전을 저장해주세요.');
    if (nameChanged) await findRxCandidates(group);
  };
  body.append(form);
}
function renderRxGroup(group) {
  updateRxSelection();
  if (rxDetailState?.group === group && ['summary', 'product'].includes(rxDetailState.view)) openRxDetail(group, rxDetailState.view);
}
function renderRxGroups() { updateRxSelection(); }
const RX_DAILY_LABELS = { below: '공식 하루 용량 범위보다 적어요', within: '공식 하루 용량 범위예요', above: '공식 하루 용량 범위보다 많아요' };
function rxNumber(value) { return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(value); }
// 90/100%처럼 끝 쪽 위치에서 translateX(-50%) 중앙정렬을 그대로 쓰면 라벨의 절반이 컨테이너 밖으로
// 밀려나고, overflow-wrap:anywhere가 그 좁아진 공간에서 숫자를 한 글자씩 세로로 쪼갠다(390px에서
// 실측 확인된 회귀) - 끝 쪽에서는 중앙정렬 대신 안쪽으로만 펼쳐지는 정렬을 쓴다.
function rxEdgeAlign(percent) { return percent <= 8 ? 'align-start' : percent >= 92 ? 'align-end' : 'align-center'; }
function renderDailyBar(reference, current, position) {
  const box = flowNode('div', '', 'rx-daily-bar'); box.setAttribute('role', 'img');
  box.setAttribute('aria-label', `공식 ${rxNumber(reference.min)}~${rxNumber(reference.max)} mg/일, 현재 ${rxNumber(current)} mg/일`);
  const ends = flowNode('div', '', 'rx-daily-endpoints');
  ends.append(flowNode('span', rxNumber(reference.min), rxEdgeAlign(position.rangeStartPercent)), flowNode('span', rxNumber(reference.max), rxEdgeAlign(position.rangeEndPercent)));
  // Extend the axis for out-of-range values. Within the range this is exactly (current-min)/(max-min).
  const track = flowNode('div', '', 'rx-daily-track'); const band = flowNode('span', '', 'rx-daily-band');
  band.style.left = `${position.rangeStartPercent}%`; band.style.width = `${position.rangeEndPercent - position.rangeStartPercent}%`;
  const marker = flowNode('span', '', 'rx-daily-marker'); marker.style.left = `${position.markerPercent}%`;
  track.append(band, marker); ends.firstChild.style.left = `${position.rangeStartPercent}%`; ends.lastChild.style.left = `${position.rangeEndPercent}%`;
  box.append(ends, track, flowNode('p', `현재 ${rxNumber(current)} mg/일`, 'rx-daily-current-label')); return box;
}
async function computeDoseAnalysis(group) {
  const calc = await ensureRxDailyCalc(); const item = group.chosen?.item;
  if (!item) return null;
  // Retry the existing item lookup only when official enrichment is missing/failed. No new API.
  if (!item.easy || ['not_requested', 'error'].includes(item.easy.status) || item.permit?.status === 'error') {
    const path = group.chosen.kind === 'liquid' ? '/api/liquids' : '/api/medicines';
    try {
      const response = await fetch(API_BASE + path + '?' + new URLSearchParams({ item_seq: item.id }), { signal: AbortSignal.timeout(12000) });
      const data = await response.json(); const fresh = data?.items?.find(i => String(i?.id) === String(item.id));
      // "이 제품엔 e약은요 데이터가 없다(not_found)"는 "재조회 자체가 실패했다"와 다른 결론이다 -
      // 전자는 실제로 조회에 성공해서 얻은 확정적 답이므로 그대로 받아들여야 한다. status==='ok'일
      // 때만 받아들이면 not_found가 계속 이전의 not_requested로 남아, 정보가 없는 제품을 "불러오지
      // 못했어요"(재시도 유도)로 잘못 표시하게 된다 - 실제로는 이미 답을 알고 있는데도.
      if (response.ok && fresh) {
        if (['ok', 'not_found'].includes(fresh.easy?.status)) item.easy = fresh.easy;
        if (['ok', 'not_found'].includes(fresh.permit?.status)) item.permit = fresh.permit;
      }
    } catch { /* Current totals remain available; distinguish unavailable official data below. */ }
  }
  const analysis = calc.analyzePrescriptionDaily({ item, row: group.row ? rxDisplayRow(group) : null, kind: group.chosen.kind, ageYears: patientAgeYears, weightKg: patientWeightKg });
  analysis.fetchFailed = !item.easy || ['not_requested', 'error'].includes(item.easy.status);
  return analysis;
}
// OCR 인식 직후(공식 제품 후보 확인 전)가 기본 상태이므로 item이 없어도 화면을 비워두지 않는다 -
// group.row(처방전에서 읽은 1회량·하루 횟수)만으로 구할 수 있는 단위 기준 하루 총량까지는 보여주고,
// mg 환산·공식 비교는 제품을 선택해야만 가능하다는 것을 명확히 안내한다(공식 비교 실패 ≠ 버튼 막힘).
function renderRxDailyWithoutProduct(body, group) {
  const row = group.row;
  const hasAmount = Number.isFinite(row?.dosePerAdministration) && Number.isFinite(row?.frequencyPerDay);
  if (hasAmount) {
    const unitLabel = row.doseUnit || '';
    body.append(flowNode('p', '하루 처방량', 'rx-detail-muted'));
    body.append(flowNode('strong', `${rxNumber(row.dosePerAdministration * row.frequencyPerDay)}${unitLabel}/일`, 'rx-daily-total'));
    body.append(flowNode('p', `${rxNumber(row.dosePerAdministration)}${unitLabel} × 하루 ${row.frequencyPerDay}회`, 'rx-detail-muted'));
  } else {
    body.append(flowNode('p', '처방량 정보가 부족해 하루 총량을 계산할 수 없어요.', 'rx-detail-muted'));
  }
  body.append(flowNode('p', '공식 성분 함량과 비교하려면 제품을 먼저 선택해주세요.', 'rx-daily-verdict unknown'));
  body.append(rxButton('제품 선택하기', 'btn-primary rx-action-product', () => openRxDetail(group, 'product')));
}
async function renderRxDaily(body, group, request) {
  const item = group.chosen?.item;
  body.append(flowNode('h3', item?.name || group.term || '처방약'));
  if (item) body.append(flowNode('p', rxIngredient(item), 'rx-detail-muted'));
  if (!item) return renderRxDailyWithoutProduct(body, group);
  const content = flowNode('div'); body.append(content); renderLoading(content);
  try {
    const analysis = await computeDoseAnalysis(group);
    if (request !== rxDetailRequest || !analysis) return;
    content.replaceChildren(); content.removeAttribute('aria-busy');
    for (const c of analysis.comparisons) {
      const section = flowNode('section', '', 'rx-daily-comparison');
      if (analysis.comparisons.length > 1) section.append(flowNode('h4', c.name));
      section.append(flowNode('p', '하루 처방량', 'rx-detail-muted'), flowNode('strong', c.current == null ? '계산에 필요한 정보를 확인해주세요' : `${rxNumber(c.current)} mg/일`, 'rx-daily-total'));
      section.append(flowNode('h4', '공식 하루 용량'));
      if (c.reference) {
        if (c.reference.min === c.reference.max) section.append(flowNode('p', `${rxNumber(c.reference.min)} mg/일`, 'rx-daily-fixed'));
        else section.append(renderDailyBar(c.reference, c.current, c.position));
        section.append(flowNode('p', RX_DAILY_LABELS[c.position.status], `rx-daily-verdict ${c.position.status}`));
        if (c.position.status === 'within' && c.position.fraction != null) section.append(flowNode('p', `하루 공식 범위의 ${c.position.fraction <= .2 ? '하단' : c.position.fraction >= .8 ? '상단' : '중간'}에 해당해요.`, 'rx-detail-muted'));
      } else section.append(flowNode('p', analysis.fetchFailed ? '공식 정보를 불러오지 못했어요' : analysis.official.status === 'missing' ? '공식 용법·용량 정보가 없어요' : '자동 비교가 어려워요', 'rx-daily-verdict'));
      content.append(section);
    }
    if (analysis.reason) content.append(flowNode('p', analysis.reason, 'rx-detail-muted'));
    const evidence = document.createElement('details'); evidence.className = 'rx-daily-evidence'; evidence.append(flowNode('summary', '계산 근거 보기'));
    for (const c of analysis.comparisons) if (c.current != null) {
      evidence.append(flowNode('p', `${analysis.row.dosePerAdministration}${analysis.row.doseUnit}/회${analysis.packagingEvidence ? ' (' + analysis.packagingEvidence + ')' : ''} × ${rxNumber(c.mgPerUnit)}mg/${analysis.prescribedUnit} × 하루 ${analysis.row.frequencyPerDay}회 = ${rxNumber(c.current)}mg/일`));
      evidence.append(flowNode('p', `함량 출처: ${c.source}`));
      if (c.reference) evidence.append(flowNode('p', `공식: ${analysis.official.perDose.min}~${analysis.official.perDose.max}${analysis.official.unit}/회 × 하루 ${analysis.official.frequency.min}~${analysis.official.frequency.max}회 = ${rxNumber(c.reference.min)}~${rxNumber(c.reference.max)}mg/일 (${analysis.official.population})`));
    }
    content.append(evidence);
    const official = document.createElement('details'); official.className = 'rx-official-text'; official.append(flowNode('summary', '공식 용법·용량 보기'), flowNode('p', analysis.original || '공식 용법·용량 정보가 없습니다.'));
    appendRxOfficialLinks(official, item); official.append(flowNode('p', analysis.sourceLabel, 'rx-detail-muted')); content.append(official);
    if (analysis.fetchFailed) content.append(rxButton('다시 시도', 'rx-dose-retry', () => openRxDetail(group, 'dose')));
    content.append(flowNode('p', '허가사항과의 단순 비교입니다. 처방 목적과 환자 상태에 따라 달라질 수 있어요.', 'rx-comparison-note'));
  } catch {
    if (request !== rxDetailRequest) return;
    content.removeAttribute('aria-busy'); renderEmpty(content, '용량 정보를 불러오지 못했습니다.', '다시 시도', () => openRxDetail(group, 'dose'));
  }
}

function openRxSearch(group = null) {
  const target = group || { id: ++rxGroupSerial, term: '', candidates: [], chosen: null, manual: true };
  target.request?.abort(); rxSearchTarget = target;
  searchFormFilter = null; showScreen('pill'); setPillStep('search');
  $('#rxSearchContext').hidden = false; $('#rxSearchTitle').textContent = group ? `인식된 약 이름 수정: ${group.term}` : '처방약 직접 추가';
  $('#query').value = group?.term || ''; $('#companyQuery').value = ''; $('#itemSeqQuery').value = '';
  $('#results').replaceChildren(); $('#pagination').hidden = true; $('#showMoreResults').hidden = true;
  controller?.abort(); $('#searchStatus').textContent = '약 이름을 검색한 뒤 공식 제품을 선택해주세요.'; $('#query').focus();
}
function acceptRxSearch(item, fetchedAt) {
  const target = rxSearchTarget; if (!target) return;
  if (!rxGroups.includes(target)) rxGroups.push(target);
  target.term = target.term || item.name; target.chosen = { item, fetchedAt, kind: isOralLiquidCandidate(item) ? 'liquid' : 'pill' }; target.candidates = [target.chosen]; target.status = '✓ 공식 제품 확인됨'; target.matchingStatus = 'needs-confirmation';
  rxSearchTarget = null; $('#rxSearchContext').hidden = true;
  renderRxGroups(); updateRxSelection(); showScreen('prescription');
  $('#rxSelectedSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
// OCR can misread one trailing syllable of an otherwise-correct name (e.g. "캡슐" -> "캡슬"), and the
// official search API does not do fuzzy matching - a single wrong character anywhere returns zero
// results. Broadening the query only ever DROPS characters (never invents or substitutes any), tried
// in order, stopping at the first attempt that finds anything: the root as read; the part before a
// hyphen, since "brand-변형/제형" is a common Korean naming pattern (e.g. "듀파락-이지시럽" -> "듀파락"
// still finds the real product even when the exact compound name is not itself a registered item);
// then progressively shorter prefixes, same as before, just no longer limited to a single attempt.
function searchRootAttempts(root) {
  const attempts = [root];
  const hyphenAt = root.indexOf('-');
  if (hyphenAt >= 3) attempts.push(root.slice(0, hyphenAt));
  let shrink = root;
  while (shrink.length > 4 && attempts.length < 5) { shrink = shrink.slice(0, -1); attempts.push(shrink); }
  return [...new Set(attempts)];
}
async function searchNameWithFallback(path, root, signal) {
  let data = { items: [], total: 0 }, error;
  for (const term of searchRootAttempts(root)) {
    try { data = await flowSearch(path, term, signal); if (data.items.length) return { ...data, queryTerm: term }; }
    catch (e) { if (signal.aborted) throw e; error = e; }
  }
  if (error && !data.items.length) throw error;
  return data;
}
async function findRxCandidates(group) {
  group.request?.abort(); const request = group.request = new AbortController();
  group.status = '공식 제품 후보를 찾고 있습니다…'; group.failed = false; renderRxGroup(group);
  try {
    const normalized = MedicineFlow.normalizeMedicineName(group.term);
    const root = group.term.normalize('NFKC').replace(/\s+/g, '').replace(/\((?:내복|경구용?|내용|내복용)\)/g, '').replace(/\d.*$/, '') || normalized;
    const searches = await Promise.allSettled(['/api/medicines', '/api/liquids'].map(async path => {
      const data = await searchNameWithFallback(path, root, request.signal);
      let items = [...data.items], complete = !data.partial && Number.isInteger(data.total);
      // Bounded paging keeps existing API/cache contracts. Incomplete results never auto-select by name.
      for (let page = 2; page <= 3 && items.length < data.total; page++) {
        const next = await flowSearch(path, data.queryTerm || root, request.signal, page);
        items.push(...next.items); complete = complete && !next.partial;
      }
      return { items, fetchedAt: data.fetchedAt, complete: complete && items.length >= data.total };
    }));
    if (request.signal.aborted || !rxGroups.includes(group)) return;
    const entries = new Map();
    for (const result of searches) if (result.status === 'fulfilled') for (const item of result.value.items) {
      const old = entries.get(String(item.id));
      const merged = old ? { ...old.item, ...item, form: old.item.form || item.form, insuranceCode: old.item.insuranceCode || item.insuranceCode,
        permit: item.permit?.status === 'ok' ? item.permit : old.item.permit } : item;
      entries.set(String(item.id), { item: merged, fetchedAt: result.value.fetchedAt,
        kind: MedicineFlow.classifyMedicineForm(merged) === 'liquid' ? 'liquid' : 'pill' });
    }
    const complete = searches.every(r => r.status === 'fulfilled' && r.value.complete);
    const row = { drugName: group.term, productCode: group.ignoreOcrCode ? null : group.row?.productCode };
    const match = MedicineFlow.matchOfficialMedicine(row, [...entries.values()].map(e => e.item), { complete });
    group.matchingStatus = match.status;
    group.candidates = [...entries.values()].map(entry => ({ ...entry, strongMatch: MedicineFlow.matchOfficialMedicine(row, [entry.item]).status === 'exact-code' }))
      .sort((a, b) => Number(b.strongMatch) - Number(a.strongMatch) || rxScore(b.item.name, group.term) - rxScore(a.item.name, group.term));
    group.chosen = match.selected ? entries.get(String(match.selected.id)) : null;
    group.failed = searches.some(r => r.status === 'rejected');
    group.status = group.chosen ? '✓ 공식 제품 확인됨' : group.failed ? '⚠ 공식 제품 확인이 필요합니다. 검색 연결을 확인하고 다시 시도해주세요.' :
      match.status === 'not-found' ? '공식 제품을 찾지 못했습니다.' : '공식 제품 후보 확인 필요 · 이름·함량·제조사를 확인해주세요.';
    if (!complete && !group.chosen && group.candidates.length) group.status += ' 일부 검색 결과만 표시하고 있습니다.';
    if (window.MEDICINE_DEBUG === true) console.debug('medicine-match', { strategy: match.status, classification: group.chosen ? MedicineFlow.classifyMedicineForm(group.chosen.item) : null });
    updateRxSelection();
  } catch {
    if (request.signal.aborted) return;
    group.failed = true; group.matchingStatus = 'needs-confirmation'; group.status = '⚠ 공식 제품 확인이 필요합니다. 제품을 직접 선택해주세요.';
  }
  renderRxGroup(group);
}
// 액상 제형은 낱알식별 데이터셋에 없어 서버가 목록 조회에서는 복약정보(e약은요)를 가져오지 않는다(성능
// 때문 - src/worker.js 참고). 실제로 용량 분석 화면을 열 때만 해당 제품 1건에 대해 조회한다.
async function ensureEasyData(item, kind) {
  if (kind !== 'liquid' || (item.easy && item.easy.status !== 'not_requested')) return item.easy;
  try {
    const response = await fetch(API_BASE + '/api/liquids?' + new URLSearchParams({ item_seq: item.id }));
    const data = await response.json();
    if (response.ok && data.items?.[0]?.easy) item.easy = data.items[0].easy;
  } catch { /* Falls through to whatever item.easy already was (not_requested). */ }
  return item.easy;
}
// OCR/vision 처방 행(group.row - unified schema, doseUnit은 "포"/"캡슐"/"정"/"mL" 등 한글)을
// item 14: a pouch count converts to a real dispensed VOLUME whenever the official packaging text
// names exactly one unambiguous mL-per-pouch figure - this is packaging arithmetic (1포 = 15mL), never
// a concentration/mg guess, and stays entirely separate from analyzeDose's ingredient math above.
function mlPerPouchFromPackaging(text) {
  const volumes = packageVolumes(text);
  return volumes.length === 1 && /포/.test(String(text || '')) ? volumes[0] : null;
}
async function processRxNames(names) {
  const added = names.map(value => {
    const row = typeof value === 'string' ? null : value;
    return { id: ++rxGroupSerial, term: row ? row.drugName : value, row,
      candidates: [], chosen: null, ocrDose: null, source: 'ocr' };
  });
  rxGroups.push(...added); renderRxGroups();
  $('#rxStatus').textContent = added.length ? '처방전에서 찾은 약입니다. 각 항목의 공식 후보를 하나씩 선택해주세요.' : '약 이름을 읽지 못했습니다. 다시 촬영하거나 + 약 직접 추가에서 검색해주세요.';
  // Sequential requests keep OCR lookup load bounded. Every row can be corrected independently.
  for (const group of added) { if (!rxGroups.includes(group)) break; await findRxCandidates(group); }
}
$('#rxSearchCancel').onclick = () => { rxSearchTarget = null; $('#rxSearchContext').hidden = true; controller?.abort(); showScreen('prescription'); };

function cancelRxOCR() {
  rxJob++; rxAbort?.abort(); rxAbort = null;
  if (rxWorker) { rxWorker.terminate(); rxWorker = null; }
  $('#rxCamera').value = ''; $('#rxPhoto').value = '';
  $('#rxCamera').disabled = $('#rxPhoto').disabled = false;
  $('#rxCancel').hidden = true;
}
// Provider abstraction (item 3/4): tries vision extraction first (Worker calls the provider - see
// src/prescription-vision.js, API key never reaches this file), falls back to the existing on-device
// Tesseract pipeline (public/prescription-*.js, unmodified) whenever vision is not configured or
// fails for any reason. scanPrescription() itself no longer knows or cares which one actually ran.
async function scanPrescription(input) {
  let file = input.files?.[0]; if (!file) return;
  cancelRxOCR(); const job = rxJob;
  rxGroups.forEach(group => group.request?.abort());
  if (!file.type.startsWith('image/') || file.size > 20 * 1024 * 1024) {
    $('#rxStatus').textContent = '20MB 이하의 이미지 파일을 선택해주세요.'; return;
  }
  $('#rxCamera').disabled = $('#rxPhoto').disabled = true; $('#rxCancel').hidden = false;
  $('#rxStatus').textContent = '처방전을 분석하고 있습니다…';
  const abort = rxAbort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 120000);
  let result, completed = false, visionFailure = null;
  const debug = DEBUG_PRESCRIPTION ? {} : undefined;
  try {
    const { extractPrescription, VisionUnavailableError } = await import('./prescription-extractor.js');
    result = await extractPrescription(file, {
      document, signal: abort.signal, apiBase: API_BASE, debug,
      // TEMPORARY while tracing the Google Vision connection (?debugPrescription=1 only - see item 6):
      // a real failure (not "vision_not_configured") is surfaced directly instead of being silently
      // masked by the normal fallback, so its actual status/message is visible. Flip DEBUG_PRESCRIPTION
      // off (the default, no query param) to restore normal production fallback behavior - nothing
      // else needs to change back.
      disableFallbackOnFailure: DEBUG_PRESCRIPTION,
      onStatus: text => { if (job === rxJob) $('#rxStatus').textContent = text; },
      onWorker: instance => { if (job === rxJob) rxWorker = instance; },
      onVisionUnavailable: error => {
        if (job !== rxJob) return;
        if (DEBUG_PRESCRIPTION && error instanceof VisionUnavailableError && error.message !== 'vision_not_configured') {
          visionFailure = error;
        }
        $('#rxStatus').textContent = '기기에서 OCR을 준비하고 있습니다. 처음에는 시간이 걸릴 수 있어요.';
      }
    });
    if (job !== rxJob || abort.signal.aborted) return;
    completed = true;
    $('#rxStatus').textContent = '이미지 분석이 끝났습니다.';
  } catch (error) {
    if (job !== rxJob) return;
    if (visionFailure) {
      // item 6/7 - dev-only, exact status/message, never the key/base64/full OCR text.
      $('#rxStatus').textContent = `Google Vision 호출 실패: ${visionFailure.status ?? '?'} ${visionFailure.providerMessage || visionFailure.message}`;
    } else {
      $('#rxStatus').textContent = '이미지를 분석하지 못했습니다. JPG/PNG로 다시 선택하거나 + 약 직접 추가에서 검색해주세요.';
    }
  } finally {
    clearTimeout(deadline); file = null;
    if (job === rxJob) { rxWorker = null; cancelRxOCR(); }
  }
  if (DEBUG_PRESCRIPTION) {
    // item 7: OCR Provider label - google-vision / google-vision-failed / local-tesseract.
    const label = result?.provider === 'google' ? 'google-vision'
      : visionFailure ? 'google-vision-failed'
      : result?.source === 'legacy-ocr' ? 'local-tesseract'
      : result?.provider ? `vision:${result.provider}` : 'unknown';
    renderPrescriptionDebug(debug, label);
  }
  if (completed && job + 1 === rxJob) {
    rxGroups = []; rxSelected.clear(); updateRxSelection();
    await loadMedSchema();
    await processRxNames(result.medications);
  }
}
$('#rxCamera').onchange = event => scanPrescription(event.target);
$('#rxPhoto').onchange = event => scanPrescription(event.target);
$('#rxCancel').onclick = () => { cancelRxOCR(); $('#rxStatus').textContent = '분석을 취소했습니다. 이미지를 저장하지 않았습니다.'; };
$('#rxPrivacyMore').onclick = () => { $('#rxPrivacyDetail').hidden = !$('#rxPrivacyDetail').hidden; };

// ---- 약 직접 추가: 페이지 이동 없이 처방전 화면 안에서 검색→선택→복용정보 입력까지 처리한다 (요청 6/7/8) -
// 예전 [+ 약 직접 추가]는 openRxSearch()를 호출해 알약 실물크기 검색 화면(pill screen)으로 이동시켰다 -
// 이 함수는 그 문제를 고친다. openRxSearch/rxSearchTarget(그룹의 "제품 직접 선택" - 이미 인식된 OCR
// 행의 후보를 바꾸는 별개 기능)은 그대로 둔다 - 여기서 건드리는 건 완전히 새 항목을 추가하는 흐름뿐이다.
let rxAddController = null, rxAddSelected = null;
function openAddMedicineModal() {
  $('#rxAddPanel').hidden = false;
  $('#rxAddQuery').value = ''; $('#rxAddStatus').textContent = '';
  $('#rxAddResults').replaceChildren(); $('#rxAddResults').hidden = false;
  $('#rxAddSearchForm').hidden = false; $('#rxAddDoseForm').hidden = true;
  rxAddSelected = null;
  $('#rxAddQuery').focus();
  $('#rxAddPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function closeAddMedicineModal() { $('#rxAddPanel').hidden = true; rxAddController?.abort(); }
$('#rxAdd').onclick = openAddMedicineModal;
$('#rxAddClose').onclick = closeAddMedicineModal;

// 알약(정제/캡슐 등)만 검색하지 않는다 - /api/medicines(낱알식별)와 /api/liquids(제품허가정보 기반, 시럽·
// 현탁액 등)를 함께 조회해 모든 제형을 결과에 그대로 보여준다(요청 7) - findRxCandidates가 OCR 인식 이름을
// 매칭할 때 쓰는 것과 같은 두 엔드포인트다. medicineForm으로 결과를 거르지 않는다 - 선택 후 분류만 한다.
async function searchAddMedicine(term) {
  rxAddController?.abort(); const controller = rxAddController = new AbortController();
  $('#rxAddStatus').textContent = '검색하는 중…'; $('#rxAddResults').replaceChildren();
  try {
    const params = new URLSearchParams({ item_name: term, numOfRows: 20 });
    const [pillRes, liquidRes] = await Promise.all([
      fetch(API_BASE + '/api/medicines?' + params, { signal: controller.signal }),
      fetch(API_BASE + '/api/liquids?' + params, { signal: controller.signal })
    ]);
    const [pillData, liquidData] = await Promise.all([pillRes.json(), liquidRes.json()]);
    if (controller !== rxAddController) return;
    // 실제 재현된 버그: 같은 품목이 두 소스에 모두 걸리면(예: 캡슐 제품도 일반 허가정보 검색에 잡힘)
    // liquidData를 나중에 넣어 덮어쓰던 순서 때문에 항상 easy:'not_requested'인 허가정보 쪽이 이겨서,
    // 이미 enrichMedicines로 성분/사용법까지 채워진 낱알식별 쪽 데이터가 사라지고 있었다 - 그 결과
    // "약 직접 추가"로 넣은 약은 공식 용법·용량이 있어도 용량 분석에서 "정보가 없어요"로 보였다.
    // pillData를 나중에 넣어, 더 풍부한 낱알식별 데이터가 항상 이기게 한다.
    const entries = new Map();
    for (const data of [liquidData, pillData]) for (const item of data.items || []) entries.set(String(item.id), item);
    const items = [...entries.values()];
    $('#rxAddStatus').textContent = items.length ? `${items.length}개 제품` : '검색 결과가 없습니다.';
    renderAddMedicineResults(items);
  } catch (error) {
    if (controller === rxAddController && error.name !== 'AbortError') $('#rxAddStatus').textContent = '검색에 실패했습니다. 잠시 후 다시 시도해주세요.';
  }
}
function renderAddMedicineResults(items) {
  const list = $('#rxAddResults'); list.replaceChildren();
  for (const item of items) {
    const button = flowNode('button', '', 'rx-add-result'); button.type = 'button';
    const copy = document.createElement('span'); // sizing handled by .rx-add-result>span in ui.css
    copy.append(flowNode('b', item.name), flowNode('small', item.company || '제조사 미제공'), flowNode('small', MedicineFlow.dosageFormLabel(item) || item.form || '제형 미제공'));
    button.append(copy); button.onclick = () => selectAddMedicine(item);
    list.append(button);
  }
}
$('#rxAddSearchForm').onsubmit = event => { event.preventDefault(); const term = $('#rxAddQuery').value.trim(); if (term.length >= 2) searchAddMedicine(term); };

// 제형(medicineForm)에 따라 1회 복용량 단위 선택지·추천값을 정해준다(요청 9) - 사용자가 직접 바꿀 수
// 있다. 정제/캡슐은 성상·제품명에 "캡슐/캅셀"이 있는지로 구분하고(기존 3D 모형 분류와 같은 신호),
// 액상은 공식 포장정보에 "포"가 있으면 포를, 아니면 mL을 기본값으로 추천한다.
function doseUnitOptionsFor(item, kind) {
  return kind === 'liquid' ? ['mL', '포'] : ['정', '캡슐'];
}
function suggestedDoseUnit(item, kind) {
  if (kind === 'liquid') return /포/.test(item.permit?.data?.packaging || '') ? '포' : 'mL';
  return /캡슐|캅셀/.test(`${item.form || ''} ${item.description || ''} ${item.name || ''}`) ? '캡슐' : '정';
}
function selectAddMedicine(item) {
  const kind = MedicineFlow.classifyMedicineForm(item) === 'liquid' ? 'liquid' : 'pill';
  rxAddSelected = { item, kind };
  $('#rxAddResults').hidden = true; $('#rxAddSearchForm').hidden = true; $('#rxAddDoseForm').hidden = false;
  $('#rxAddSelectedName').textContent = item.name;
  const unitSelect = $('#rxAddDoseUnit'); unitSelect.replaceChildren();
  for (const opt of doseUnitOptionsFor(item, kind)) { const o = document.createElement('option'); o.value = opt; o.textContent = opt; unitSelect.append(o); }
  unitSelect.value = suggestedDoseUnit(item, kind);
  $('#rxAddDoseAmount').value = ''; $('#rxAddFrequency').value = ''; $('#rxAddDuration').value = '';
  const packaging = item.permit?.data?.packaging || '';
  const mlPerPouch = mlPerPouchFromPackaging(packaging);
  // "1포 = 15mL" 같은 공식 포장정보 기준 환산을 참고로만 보여준다(요청 9) - 임의 추정이 아니라 packaging
  // 원문에서 유일하게 확인되는 mL 값일 때만(mlPerPouchFromPackaging) 표시한다.
  const syncPouchHint = () => { $('#rxAddPouchHint').hidden = !(unitSelect.value === '포' && mlPerPouch); if (mlPerPouch) $('#rxAddPouchHint').textContent = `1포 = ${mlPerPouch}mL (공식 포장정보 기준)`; };
  unitSelect.onchange = syncPouchHint; syncPouchHint();
}
$('#rxAddCancelDose').onclick = () => { rxAddSelected = null; $('#rxAddDoseForm').hidden = true; $('#rxAddResults').hidden = false; $('#rxAddSearchForm').hidden = false; };
$('#rxAddConfirm').onclick = async () => {
  if (!rxAddSelected) return;
  const { item, kind } = rxAddSelected;
  const amount = Number($('#rxAddDoseAmount').value), freq = Number($('#rxAddFrequency').value), dur = Number($('#rxAddDuration').value);
  await loadMedSchema();
  const row = medSchema.clampMedication({
    drugName: item.name, rawName: item.name, productCode: item.insuranceCode || null,
    doseUnit: $('#rxAddDoseUnit').value,
    dosePerAdministration: amount, frequencyPerDay: freq, durationDays: dur,
    confidence: { productCode: 1, drugName: 1, dose: 1, frequency: 1, duration: 1 }
  });
  // 약 직접 추가는 이미 사용자가 공식 제품을 확정한 것이므로 기존 OCR 매칭(findRxCandidates)을 다시
  // 거치지 않는다 - group.chosen을 곧바로 채운다. 출처만 'manual'로 남겨 OCR 인식 항목과 구분한다(요청 10).
  const group = { id: ++rxGroupSerial, term: item.name, row, candidates: [{ item, fetchedAt: new Date().toISOString(), kind }],
    chosen: { item, fetchedAt: new Date().toISOString(), kind }, source: 'manual' };
  rxGroups.push(group); renderRxGroups(); updateRxSelection();
  closeAddMedicineModal();
  $('#rxStatus').textContent = '직접 추가한 약을 처방 목록에 넣었습니다.';
  $('#rxSelectedSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
};
$('#rxClear').onclick = () => {
  rxPrescriptionDate = null; closeRxDetail();
  cancelRxOCR(); rxGroups.forEach(group => group.request?.abort()); rxGroups = []; rxSelected.clear(); renderRxGroups(); updateRxSelection();
  $('#rxStatus').textContent = '처방전 내용을 지웠습니다.';
};

// ---- 로그인 사용자별 처방전 저장/다시 보기 (요청 1) -------------------------------------------------
// public/prescriptions.js는 auth.js와 같은 지연 로딩 패턴 - 저장/조회를 실제로 쓸 때만 불러온다.
let prescriptionsApi = null;
const loadPrescriptionsApi = () => prescriptionsApi ? Promise.resolve(prescriptionsApi) : import('./prescriptions.js').then(m => (prescriptionsApi = m));

// group.row(원본 OCR 인식 결과) + group.chosen(사용자가 확인한 공식 품목)만 저장한다 - 원본 이미지도
// 전체 OCR 문장도 여기 없다. item_seq만 있으면 다시 열 때 기존 /api/medicines·/api/liquids로 공식 정보를
// 새로 가져올 수 있으므로 permit/easy 스냅샷 자체는 저장하지 않는다.
function prescriptionItemsFromGroups() {
  return rxGroups.filter(g => g.row || g.term).map(g => ({
    rawName: g.row?.rawName || g.term || null, drugName: g.row?.drugName || g.term,
    itemSeq: g.chosen ? g.chosen.item.id : null, kind: g.chosen ? g.chosen.kind : null,
    doseAmount: g.row?.dosePerAdministration ?? null, doseUnit: g.row?.doseUnit ?? null,
    frequencyPerDay: g.row?.frequencyPerDay ?? null, durationDays: g.row?.durationDays ?? null,
    needsReview: !!g.row?.needsReview
  }));
}
function prescriptionLabelFromGroups() {
  const names = rxGroups.map(g => g.chosen?.item?.name || g.row?.drugName || g.term).filter(Boolean);
  if (!names.length) return null;
  return names.length > 1 ? `${names[0]} 외 ${names.length - 1}건` : names[0];
}
async function saveCurrentPrescription() {
  if (!authSession || !authConfigData) { $('#rxSaveStatus').textContent = '로그인 후 저장할 수 있습니다.'; return; }
  const items = prescriptionItemsFromGroups();
  if (!items.length) { $('#rxSaveStatus').textContent = '저장할 처방 내용이 없습니다.'; return; }
  if ($('#rxSavePrescription').disabled) return;
  $('#rxSavePrescription').disabled = true;
  $('#rxSaveStatus').textContent = '저장하는 중…';
  try {
    const api = await loadPrescriptionsApi();
    await api.savePrescription(authConfigData, authSession, { label: prescriptionLabelFromGroups(), items }, fetch);
    $('#rxSaveStatus').textContent = '처방전을 저장했습니다.'; showToast('✓ 처방전이 저장되었습니다');
    await renderRecentPrescriptions();
  } catch {
    $('#rxSaveStatus').textContent = '처방전을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.';
  } finally { $('#rxSavePrescription').disabled = false; }
}
$('#rxSavePrescription').onclick = saveCurrentPrescription;

// 라벨 "약이름 외 N건"에서 총 개수를 되짚는다 - prescriptionLabelFromGroups()가 저장 시 만든 것과 같은
// 형식이라 별도 items count 조회 없이 카드에 "N개 의약품"을 보여줄 수 있다(요청 21).
function itemCountFromLabel(label) {
  const m = String(label || '').match(/외\s*(\d+)건$/);
  return m ? Number(m[1]) + 1 : 1;
}
const RX_RECENT_PREVIEW = 3;
let rxRecentRows = [], rxRecentShowAll = false;
// 요청 21: 접힌 한 줄이 아니라 최근 2~3개를 바로 카드로 보여주고, 그 이상은 "전체 보기"를 눌러야 나온다.
function renderRecentCards() {
  const list = $('#rxRecentList'); list.replaceChildren();
  const rows = rxRecentShowAll ? rxRecentRows : rxRecentRows.slice(0, RX_RECENT_PREVIEW);
  for (const row of rows) {
    const card = flowNode('article', '', 'rx-recent-item');
    const created = new Date(row.created_at);
    card.append(flowNode('p', Number.isNaN(created.getTime()) ? '날짜 정보 없음' : created.toLocaleDateString('ko-KR')));
    card.append(flowNode('p', `${row.label || '처방전'} · ${itemCountFromLabel(row.label)}개 의약품`));
    card.append(flowNode('span', '저장됨', 'badge'));
    const actions = flowNode('div', '', 'flow-actions');
    const open = flowNode('button', '다시 보기'); open.type = 'button'; open.onclick = () => reopenPrescription(row.id);
    const remove = flowNode('button', '삭제', 'btn-danger'); remove.type = 'button'; remove.setAttribute('aria-label', `${row.label || '처방전'} 삭제`);
    remove.onclick = async () => {
      remove.disabled = true; open.disabled = true;
      try { const api = await loadPrescriptionsApi(); await api.deletePrescription(authConfigData, authSession, row.id, fetch); showToast('처방전이 삭제되었습니다'); await renderRecentPrescriptions(); }
      catch { showToast('삭제하지 못했습니다. 다시 시도해주세요.', 'error'); remove.disabled = false; open.disabled = false; }
    };
    actions.append(open, remove); card.append(actions); list.append(card);
  }
  $('#rxRecentShowAll').hidden = rxRecentShowAll || rxRecentRows.length <= RX_RECENT_PREVIEW;
}
async function renderRecentPrescriptions() {
  const section = $('#rxRecent'); if (!section) return;
  if (!authSession || !authConfigData) { section.hidden = true; return; }
  section.hidden = false;
  if (!$('#rxRecentStatus')) return; // 화면/테스트가 await 도중 정리된 경우
  $('#rxRecentStatus').textContent = ''; renderLoading($('#rxRecentList'));
  try {
    const api = await loadPrescriptionsApi();
    const rows = await api.listPrescriptions(authConfigData, authSession, fetch);
    if (!$('#rxRecentStatus')) return; // screenchange가 자동으로 트리거하므로 await 도중 화면이 사라질 수 있다
    rxRecentRows = Array.isArray(rows) ? rows.filter(row => row && row.id) : []; rxRecentShowAll = false;
    $('#rxRecentStatus').textContent = rxRecentRows.length ? '' : '저장된 처방전이 없습니다.';
    renderRecentCards();
    if (!rxRecentRows.length) renderEmpty($('#rxRecentList'), '첫 처방전을 등록하면 언제든 다시 확인할 수 있어요.', '처방전 등록하기', () => $('#rxPhoto').click());
  } catch {
    if ($('#rxRecentStatus')) { $('#rxRecentStatus').textContent = ''; renderEmpty($('#rxRecentList'), '저장된 처방전을 불러오지 못했습니다.', '다시 시도', renderRecentPrescriptions); }
  } finally { $('#rxRecentList')?.removeAttribute('aria-busy'); }
}
$('#rxRecentShowAll').onclick = () => { rxRecentShowAll = true; renderRecentCards(); };
// 처방전 화면에 들어올 때마다 최신 목록을 보여준다(요전엔 펼쳐야만 불러왔다 - 이제 화면에 항상 보인다).
window.addEventListener('screenchange', event => { if (event.detail === 'prescription') renderRecentPrescriptions(); });

// 저장된 항목(row)을 다시 rxGroups로 복원한다 - item_seq가 있으면 기존 검색 엔드포인트(캐시 포함)로 공식
// 정보를 새로 가져오고, Google Vision OCR/처방전 이미지 분석은 어디에서도 다시 호출하지 않는다.
async function reopenPrescription(id) {
  if (!authSession || !authConfigData) return;
  $('#rxRecentStatus').textContent = '불러오는 중…';
  try {
    const api = await loadPrescriptionsApi();
    const rows = await api.fetchPrescriptionItems(authConfigData, authSession, id, fetch);
    await loadMedSchema();
    cancelRxOCR(); rxGroups.forEach(group => group.request?.abort()); rxGroups = []; rxSelected.clear();
    for (const stored of (Array.isArray(rows) ? rows : []).filter(Boolean)) {
      const group = {
        id: ++rxGroupSerial, term: stored.drug_name, candidates: [], chosen: null, status: '',
        row: medSchema.clampMedication({
          drugName: stored.drug_name, rawName: stored.raw_name, dosePerAdministration: stored.dose_amount,
          doseUnit: stored.dose_unit, frequencyPerDay: stored.frequency_per_day, durationDays: stored.duration_days
        })
      };
      if (typeof stored.needs_review === 'boolean') group.row.needsReview = stored.needs_review;
      rxGroups.push(group);
      if (stored.item_seq) {
        try {
          const path = stored.kind === 'liquid' ? '/api/liquids' : '/api/medicines';
          const response = await fetch(API_BASE + path + '?' + new URLSearchParams({ item_seq: stored.item_seq }));
          const data = await response.json();
          const item = data.items?.[0];
          if (response.ok && item) group.chosen = { item, fetchedAt: data.fetchedAt, kind: stored.kind || (MedicineFlow.classifyMedicineForm(item) === 'liquid' ? 'liquid' : 'pill') };
        } catch { /* 실패해도 group은 남아 사용자가 직접 다시 선택할 수 있다. */ }
      }
      group.status = group.chosen ? '✓ 공식 제품 확인됨' : stored.item_seq ? '⚠ 공식 제품 정보를 다시 불러오지 못했습니다. 제품을 직접 선택해주세요.' : '공식 제품이 선택되지 않은 상태로 저장되었습니다.';
    }
    rxPrescriptionDate = rxRecentRows.find(row => row.id === id)?.created_at || null;
    renderRxGroups(); updateRxSelection(); showScreen('prescription');
    $('#rxSelectedSection').scrollIntoView({ block: 'start' });
    $('#rxStatus').textContent = '저장된 처방전을 불러왔습니다 (다시 촬영하지 않았습니다).';
  } catch {
    $('#rxRecentStatus').textContent = '처방전을 불러오지 못했습니다.';
  }
}

// PACK_UNIT only: never infer package volume from strength, ingredients, or product name.
function packageVolumes(text) {
  return [...new Set([...String(text || '').matchAll(/(\d+(?:\.\d+)?)\s*(?:mL|밀리리터)(?!\s*\/\s*(?:mg|g))/gi)]
    .map(m => Number(m[1])).filter(n => n > 0 && n <= 10000))];
}
function parseFraction(raw) {
  const value = raw.trim();
  if (!/^(?:0?(?:\.\d+)|\d+(?:\.\d+)?)\s*%?$/.test(value)) return null;
  const n = Number(value.replace('%', '').trim()) / (value.endsWith('%') ? 100 : 1);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : null;
}
// Shared classification also protects permit-only products and legacy entry points.
function isOralLiquidCandidate(item) { return MedicineFlow.classifyMedicineForm(item) === 'liquid'; }
let liquidRequest, liquidTerm = '', liquidPage = 1, fraction = .5, fractionLabel = '1/2';
async function searchLiquids(page = 1) {
  liquidRequest?.abort(); const request = liquidRequest = new AbortController();
  $('#liquidStatus').textContent = '공식 허가정보에서 검색 중…'; renderLoading($('#liquidResults')); $('#liquidMore').hidden = true;
  $('#liquidGuide').hidden = true; $('#containerTypeChoice').hidden = true; $('#bottleNotice').hidden = true; $('#bottleCalculator').hidden = true;
  resetLiquidPhoto();
  try {
    const data = await flowSearch('/api/liquids', liquidTerm, request.signal, page); if (request.signal.aborted) return;
    liquidPage = page;
    // Permit search also includes non-oral products; only explicit oral-liquid forms are offered.
    const items = (Array.isArray(data?.items) ? data.items : []).filter(item => item && isOralLiquidCandidate(item));
    $('#liquidResults').replaceChildren();
    $('#liquidStatus').textContent = items.length ? '제품명·제조사·포장단위를 확인하고 선택하세요.' : '이 페이지에 확인 가능한 액체약이 없습니다. 시럽·내복액 등 정확한 제품명으로 검색해주세요.';
    for (const item of items) {
      const button = flowNode('button', item.name); button.type = 'button';
      button.append(flowNode('small', item.company || '제조사 미제공'), flowNode('small', `공식 포장단위: ${item.permit?.data?.packaging || '미제공'}`));
      const flavor = buildFlavorInfo(item); if (flavor) button.append(flowNode('small', `맛/향: ${flavor.labels.join(', ')}`));
      button.onclick = () => openMedicine(item);
      const row = document.createElement('div'); row.className = 'save-row';
      row.append(button, makeSaveButton(item, 'liquid')); $('#liquidResults').append(row);
    }
    syncSaveButtons();
    $('#liquidMore').hidden = page * data.pageSize >= data.total || page >= 100;
    if (!items.length) renderEmpty($('#liquidResults'), '다른 제품명으로 다시 검색해보세요.', '검색어 다시 입력', () => $('#liquidQuery').focus());
  } catch (error) { if (!request.signal.aborted) { $('#liquidStatus').textContent = error instanceof TypeError ? '네트워크 연결을 확인해주세요.' : error.message; renderEmpty($('#liquidResults'), '액체약 정보를 가져오지 못했습니다.', '다시 시도', () => searchLiquids(page)); } }
  finally { if (liquidRequest === request) $('#liquidResults').removeAttribute('aria-busy'); }
}
$('#liquidSearch').onsubmit = event => { event.preventDefault(); liquidTerm = $('#liquidQuery').value.trim(); if (liquidTerm.length >= 2) searchLiquids(); };
$('#liquidMore').onclick = () => searchLiquids(liquidPage + 1);
// A pouch/stick's cross-section is roughly uniform top to bottom, so a height fraction is a
// reasonable stand-in for a volume fraction. A bottle's is not (shoulders, tapered necks, non-
// cylindrical bodies) - height 1/2 can be nowhere near volume 1/2 - so bottles must never get a
// fraction *line*, only a computed-volume number (see showBottleNotice/renderBottleCalculator).
// Packaging text is the most reliable signal available (e.g. "20mL × 30포" vs "500mL/병"); when it
// names both or neither, the type is genuinely ambiguous from data alone and the user decides.
function classifyContainerType(packaging) {
  const text = String(packaging || '');
  const hasPouch = /포|스틱/.test(text);
  const hasBottle = /병|보틀/.test(text);
  if (hasPouch && !hasBottle) return 'pouch';
  if (hasBottle && !hasPouch) return 'bottle';
  return 'unknown';
}
// Per-product override for items a viewer has confirmed by hand (packaging text and/or photo),
// used when the automatic checks below can't reach a confident answer on their own - see
// resolveContainerType(). Keyed by item_seq. Add more entries here as they're found; this is the
// last-resort layer, not the primary mechanism (packaging text alone already resolves most items).
const CONTAINER_TYPE_OVERRIDES = {
  '196900058': 'pouch' // 코푸시럽에스: 20mL/포 x 6, 12포 - confirmed pouch, no bottle variant on file
};
// Priority: (1) an unambiguous packaging-text match, (2) foil/stick-pack language elsewhere in the
// official permit text when packaging alone didn't resolve it, (3) a saved per-product override.
// Only when none of these reach a confident answer does the caller fall back to asking the user -
// "잘 모르겠어요" must stay a rare fallback, not something a normal official search result hits.
function resolveContainerType(item) {
  const packaging = item.permit?.data?.packaging || '';
  const byPackaging = MedicineFlow.classifyLiquidPackaging(item);
  if (byPackaging !== 'unknown') return byPackaging;
  const hasBottle = /병|보틀/.test(packaging);
  const extra = `${item.permit?.data?.description || ''} ${item.permit?.data?.materials || ''} ${item.description || ''}`;
  if (!hasBottle && /알루미늄\s*호일|호일\s*포장|스틱\s*포장|파우치/.test(extra)) return 'pouch';
  if (hasBottle) return 'unknown';
  const override = CONTAINER_TYPE_OVERRIDES[String(item.id)];
  if (override) return override;
  return 'unknown';
}
let liquidSelectedItem = null;
// Single source of truth for whether the fraction-line UI is even allowed to exist right now.
// renderPhotoOverlay() (and loadLiquidPhoto()) refuse to draw anything unless this is exactly
// 'pouch' - a bottle's photo/crop state must never leak a line onto the screen, independent of
// whatever section happens to be hidden/visible at the DOM level.
let currentContainerType = null;
function selectLiquid(item) {
  // 산제/과립/포/스틱(요청 5)도 이 화면의 포/스틱 분할 가이드를 그대로 쓴다 - classifyMedicineForm은
  // 이 제품들을 'liquid'로 보지 않으므로(의도적으로 건드리지 않음), classifyDisplayForm의 별도 판정도
  // 함께 허용한다. 그 외 제형은 기존대로 openMedicine()으로 되돌아간다(무한 재귀 방지).
  if (MedicineFlow.classifyMedicineForm(item) !== 'liquid' && MedicineFlow.classifyDisplayForm(item) !== 'powder-sachet') return openMedicine(item);
  liquidSelectedItem = item; bottlePhotoRequest?.abort();
  $('#liquidName').textContent = item.name; $('#liquidCompany').textContent = item.company || '제조사 미제공';
  const flavor = buildFlavorInfo(item);
  $('#liquidFlavor').hidden = false;
  // 요청 9의 핵심정보 카드(맛/향 한 칸)에 그대로 들어가므로, 원문 출처 인용은 시각적으로 넘치지 않게
  // title 툴팁으로만 남기고 눈에 보이는 텍스트에는 넣지 않는다(chip 방식과 동일한 원칙).
  $('#liquidFlavor').textContent = flavor ? `맛/향: ${flavor.labels.join(', ')}` : '맛/향: 등록된 맛 정보 없음';
  $('#liquidFlavor').title = flavor?.sourceText ? `${flavor.sourceType}: ${flavor.sourceText}` : '';
  // 핵심정보 카드(요청 4) - pouch/bottle 어느 쪽으로 갈리든 selectLiquid() 한 곳에서 채운다. mL 단위
  // 공식 용법은 doseCalc.parseOfficialDosage(순수 함수, 이미 테스트됨)를 그대로 재사용한다.
  const dose = officialDoseSummary(item), storage = officialStorageText(item) || '정보 없음';
  for (const prefix of ['liquid', 'bottle']) {
    const doseEl = $(`#${prefix}CoreInfoDose`), tipEl = $(`#${prefix}CoreInfoTip`), storageEl = $(`#${prefix}CoreInfoStorage`), card = $(`#${prefix}CoreInfoCard`);
    if (!card) continue;
    doseEl.textContent = dose.text || (dose.usage ? dose.usage.split(/\n/)[0].slice(0, 60) : '정보 없음');
    if (tipEl) tipEl.textContent = dose.usage ? dose.usage.split(/\n/)[0].slice(0, 80) : '정보 없음';
    storageEl.textContent = storage;
    card.hidden = false;
  }
  const packaging = item.permit?.data?.packaging || '';
  $('#liquidPackaging').textContent = `공식 포장단위: ${packaging || '미제공'} · 출처: 식약처 제품 허가정보`;
  $('#liquidPackagingSummary').hidden = !packaging;
  $('#liquidPackagingSummary').textContent = packaging ? `포장 단위: ${packaging}` : '';
  const volumes = packageVolumes(packaging), select = $('#liquidPackage'); select.replaceChildren();
  const placeholder = flowNode('option', volumes.length ? '포장에 적힌 용량을 선택해주세요' : '공식 용량 미제공 — 분율만 표시'); placeholder.value = ''; select.append(placeholder);
  for (const ml of volumes) { const option = flowNode('option', `${ml} mL`); option.value = ml; select.append(option); }
  // Multiple variants and counts (e.g. 20 mL × 30포) require deliberate user selection.
  $('#liquidManualMl').value = ''; $('#customFraction').value = ''; $('#fractionError').textContent = '';
  $('#liquidGuide').hidden = true; $('#bottleNotice').hidden = true; $('#bottleCalculator').hidden = true; $('#containerTypeChoice').hidden = true;
  applyContainerType(resolveContainerType(item), item);
}
function applyContainerType(type, item) {
  if (type === 'pouch' && MedicineFlow.classifyLiquidPackaging(item) === 'bottle') type = 'bottle';
  if (type === 'other') type = 'unknown';
  currentContainerType = type;
  if (type === 'unknown') {
    resetLiquidPhoto();
    // "포장 형태를 확인하지 못함" is never the same screen as "검색 결과 없음" - the product was found,
    // so its name/company/제형/포장단위 show here even though the fraction-line-vs-계량도구 decision
    // couldn't be made automatically.
    $('#containerTypeProductName').textContent = item.name; $('#containerTypeProductCompany').textContent = item.company || '제조사 미제공';
    const form = item.permit?.data?.description || item.description || '';
    $('#containerTypeProductForm').hidden = !form; $('#containerTypeProductForm').textContent = form ? `성상: ${form}` : '';
    const packaging = item.permit?.data?.packaging || '';
    $('#containerTypeProductPackaging').hidden = !packaging; $('#containerTypeProductPackaging').textContent = packaging ? `포장 단위: ${packaging}` : '';
    $('#containerTypeChoice').hidden = false; $('#containerTypeChoice').scrollIntoView({ behavior: 'smooth', block: 'start' }); return;
  }
  $('#containerTypeChoice').hidden = true;
  if (type === 'bottle') { resetLiquidPhoto(); showBottleNotice(item); return; }
  $('#bottleNotice').hidden = true; $('#bottleCalculator').hidden = true;
  loadLiquidPhoto(item);
  fraction = .5; fractionLabel = '1/2'; $('#liquidGuide').hidden = false; renderFraction();
  $('#liquidGuide').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
document.querySelectorAll('#containerTypeChoice [data-container-type]').forEach(button => {
  button.onclick = () => applyContainerType(button.dataset.containerType, liquidSelectedItem);
});
// "잘 모르겠어요": the safe default is the same caution screen a bottle gets (a wrong guess of
// "pouch" would draw a misleading line; a wrong guess of "bottle" only costs an extra tap through
// to the same fraction guide via the notice's own override, see showBottleNotice()).
$('#containerTypeUnsure').onclick = () => applyContainerType('bottle', liquidSelectedItem);
function showBottleNotice(item) {
  $('#bottleIsActuallyPouch').hidden = MedicineFlow.classifyLiquidPackaging(item) === 'bottle';
  $('#bottleIsActuallyPouch').closest('p').hidden = $('#bottleIsActuallyPouch').hidden;
  $('#bottleNotice').hidden = false; $('#bottleCalculator').hidden = true;
  $('#bottleNotice').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#bottleProductName').textContent = item.name; $('#bottleProductCompany').textContent = item.company || '제조사 미제공';
  const flavor = buildFlavorInfo(item);
  $('#bottleProductFlavor').hidden = !flavor;
  $('#bottleProductFlavor').textContent = flavor ? `맛/향: ${flavor.labels.join(', ')}` : '';
  const packaging = item.permit?.data?.packaging || '';
  $('#bottleProductPackaging').hidden = !packaging;
  $('#bottleProductPackaging').textContent = packaging ? `포장 단위: ${packaging}` : '';
  const volumes = packageVolumes(packaging), select = $('#bottleVolumeSelect'); select.replaceChildren();
  const placeholder = flowNode('option', volumes.length ? '포장에 적힌 용량을 선택해주세요' : '공식 용량 미제공'); placeholder.value = ''; select.append(placeholder);
  for (const ml of volumes) { const option = flowNode('option', `${ml} mL`); option.value = ml; select.append(option); }
  $('#bottleManualMl').value = ''; $('#bottleDoseMl').value = '';
  loadBottlePhoto(item);
}
let bottlePhotoRequest;
// Deliberately no crop/auto-detect/fraction-line machinery here - a bottle just shows the plain
// official photo (or nothing), never a line, per the hard rule enforced in renderPhotoOverlay().
async function loadBottlePhoto(item) {
  bottlePhotoRequest?.abort(); const request = bottlePhotoRequest = new AbortController();
  const img = $('#bottleProductPhoto'); img.hidden = true; img.removeAttribute('src');
  $('#bottlePhotoStatus').textContent = '';
  try {
    let data;
    if (safeImage(item.imageUrl)) data = { status: 'ok', id: item.id, imageUrl: item.imageUrl };
    else {
      const response = await fetch(API_BASE + '/api/liquid-image?' + new URLSearchParams({ item_seq: item.id }), { signal: request.signal });
      data = await response.json(); if (!response.ok) return;
    }
    if (request.signal.aborted || String(data.id) !== String(item.id) || data.status !== 'ok') return;
    const inlinePhoto = typeof data.imageData === 'string' && data.imageData.length <= 3000000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data.imageData);
    if (!safeImage(data.imageUrl) && !inlinePhoto) return;
    img.onload = () => { if (!request.signal.aborted) img.hidden = false; };
    img.onerror = () => {};
    img.alt = `${item.name} · ${item.company || ''} 공식 제품 사진`;
    img.src = inlinePhoto ? data.imageData : data.imageUrl;
  } catch { /* No photo is a fine, quiet outcome here - the caution card is what matters. */ }
}
$('#bottleCalcBtn').onclick = () => { $('#bottleNotice').hidden = true; $('#bottleCalculator').hidden = false; renderBottleCalculator(); $('#bottleCalculator').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
$('#bottleSearchAgainBtn').onclick = () => { $('#bottleNotice').hidden = true; $('#liquidQuery').focus(); $('#liquidQuery').closest('section').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
// A product classified 'unknown' can still turn out to be a pouch once the user looks at it -
// this is the one deliberate escape hatch back into the fraction-line guide from the bottle screen.
$('#bottleIsActuallyPouch').onclick = () => applyContainerType('pouch', liquidSelectedItem);
// 1회 복용량을 직접 입력해 "전체 용량의 몇 %"만 참고로 보여준다(병 제품은 절반을 먹으라는 뜻이 아니므로
// 분율 선택보다 이 계산을 먼저 보여준다) - 분율 버튼(아래 접힌 "분율로 확인하기")은 그대로 유지한다.
function renderBottleDoseResult() {
  const manual = $('#bottleManualMl').value.trim(), supplied = Number(manual || $('#bottleVolumeSelect').value);
  const total = Number.isFinite(supplied) && supplied > 0 && supplied <= 10000 ? supplied : null;
  const dose = Number($('#bottleDoseMl').value);
  const result = $('#bottleDoseResult');
  if (!total) { result.textContent = '총 용량을 확인하면 1회 복용량이 전체의 몇 %인지 계산할 수 있어요'; return; }
  if (!Number.isFinite(dose) || dose <= 0) { result.textContent = `총 용량 ${total} mL · 1회 복용량을 입력해주세요`; return; }
  const percent = Math.round((dose / total) * 1000) / 10;
  result.textContent = `총 용량 ${total} mL 중 1회 복용량 ${dose} mL → 전체의 ${percent}%`;
}
$('#bottleDoseMl')?.addEventListener('input', renderBottleDoseResult);
let bottleFraction = .5, bottleFractionLabel = '1/2';
function renderBottleCalculator() {
  renderBottleDoseResult();
  const manual = $('#bottleManualMl').value.trim(), supplied = Number(manual || $('#bottleVolumeSelect').value);
  const ml = Number.isFinite(supplied) && supplied > 0 && supplied <= 10000 ? supplied : null;
  if (ml) {
    // [총 용량] × [분율] = [계산된 용량] reads left-to-right the way the user actually thinks about
    // it ("500 mL의 2/3는 얼마?"); the previous "약 333.3 mL · 500 mL × 2/3" buried the answer first.
    const exact = ml * bottleFraction, rounded = Math.round(exact * 10) / 10;
    const approx = Math.abs(exact - rounded) > 1e-9; // only whole-number results skip the "약" qualifier
    $('#bottleVolumeResult').textContent = `${ml} mL × ${bottleFractionLabel} = ${approx ? '약 ' : ''}${rounded} mL${manual ? ' (직접 입력 기준)' : ''}`;
  } else {
    $('#bottleVolumeResult').textContent = `${bottleFractionLabel} 위치 · 총 용량을 확인하면 계산값을 볼 수 있어요`;
  }
  document.querySelectorAll('[data-bottle-fraction]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.bottleFraction) === bottleFraction)));
}
document.querySelectorAll('[data-bottle-fraction]').forEach(button => button.onclick = () => {
  bottleFraction = Number(button.dataset.bottleFraction); bottleFractionLabel = button.textContent; renderBottleCalculator();
});
['bottleVolumeSelect', 'bottleManualMl'].forEach(id => $('#' + id).addEventListener('input', renderBottleCalculator));
function renderFraction() {
  const manual = $('#liquidManualMl').value.trim(), supplied = Number(manual || $('#liquidPackage').value);
  const ml = Number.isFinite(supplied) && supplied > 0 && supplied <= 10000 ? supplied : null;
  renderPhotoOverlay();
  $('#fractionVolume').textContent = ml ? `약 ${Math.round(ml * fraction * 10) / 10} mL · ${ml} mL × ${fractionLabel}${manual ? ' (직접 입력 기준)' : ''}` : `${fractionLabel} 위치 · 총 용량을 확인하면 계산값을 볼 수 있어요`;
  document.querySelectorAll('[data-fraction]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.fraction) === fraction)));
}
document.querySelectorAll('[data-fraction]').forEach(button => button.onclick = () => {
  fraction = Number(button.dataset.fraction); fractionLabel = button.textContent; $('#customFraction').value = ''; $('#fractionError').textContent = ''; renderFraction();
});
$('#customFraction').oninput = () => {
  const value = parseFraction($('#customFraction').value);
  $('#fractionError').textContent = value === null ? '0 초과 1 이하의 소수 또는 0% 초과 100% 이하를 입력해주세요. 아래에는 마지막 유효한 분율을 표시합니다.' : '';
  if (value !== null) { fraction = value; fractionLabel = `${Math.round(value * 1000) / 10}%`; renderFraction(); }
};
['liquidPackage', 'liquidManualMl'].forEach(id => $('#' + id).addEventListener('input', renderFraction));
function stopLiquidCamera() {
  liquidCameraJob++;
  const video = $('#camera'); video.srcObject?.getTracks().forEach(track => track.stop()); video.srcObject = null; $('#cameraWrap').classList.remove('live');
}
$('#cameraAdvanced').addEventListener('toggle', () => { if (!$('#cameraAdvanced').open) stopLiquidCamera(); });
window.addEventListener('pagehide', () => { cancelRxOCR(); rxRequest?.abort(); stopLiquidCamera(); if (uploadObjectUrl) URL.revokeObjectURL(uploadObjectUrl); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelRxOCR(); stopLiquidCamera(); } });

window.addEventListener('screenchange', event => { if (event.detail !== 'prescription') { cancelRxOCR(); } if (event.detail !== 'pill') { rxSearchTarget = null; $('#rxSearchContext').hidden = true; } if (event.detail !== 'liquid') stopLiquidCamera(); });


let liquidCameraJob = 0;
$('#startCamera').onclick = async () => {
  stopLiquidCamera(); const job = liquidCameraJob; $('#cameraError').textContent = '';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (job !== liquidCameraJob || !$('#liquidTool').classList.contains('active')) { stream.getTracks().forEach(track => track.stop()); return; }
    $('#camera').srcObject = stream; await $('#camera').play();
    if (job === liquidCameraJob) $('#cameraWrap').classList.add('live');
  } catch { stream?.getTracks().forEach(track => track.stop()); $('#cameraError').textContent = '카메라 권한을 확인해주세요. HTTPS 환경에서만 사용할 수 있습니다.'; }
};

let liquidImageRequest, liquidImageItem = null, liquidPhotoReady = false;
const DEFAULT_USABLE = { top: 6, bottom: 94 };
let usableRegion = { ...DEFAULT_USABLE };
// The pixel-analysis module is dynamically imported (same pattern as the 3D model, see above) so a
// browser/test environment without it just skips auto-detection instead of failing to load.
// Only needed once a pouch/stick photo actually needs auto-cropping - lazy, triggered on entry to
// the liquid screen (see showScreen()), not on every page load.
let pouchCropModule = null, pouchCropPromise = null;
function ensurePouchCrop() { return pouchCropPromise ??= import('./pouch-crop.js').then(m => { pouchCropModule = m; }).catch(() => {}); }
// Manually curated per-product overrides for photos where automatic background segmentation is
// unreliable (a colored backdrop card, or a box touching the container with no background gap to
// separate them - see findPouchRegion() in pouch-crop.js). Both rects are fractions (0..1):
// cropRect is the area of the ORIGINAL photo shown to the user (the container only, box excluded);
// usableLiquidRect is {top,bottom} *within that crop* used for the fraction math, excluding the
// pouch's own top/bottom seals. Add more item_seq entries here as unstable cases are found.
const POUCH_CROP_OVERRIDES = {
  '201206715': { // 챔프시럽: teal backdrop card confuses background segmentation
    cropRect: { x: 0.14, y: 0.235, width: 0.315, height: 0.52 }
  },
  '200502778': { // 백초시럽플러스: bottle and box touch with no background gap between them
    cropRect: { x: 0.02, y: 0.015, width: 0.42, height: 0.915 }
  }
};
function resetLiquidPhoto() {
  liquidImageRequest?.abort(); liquidPhotoReady = false;
  const photo = $('#liquidProductPhoto'); photo.onload = photo.onerror = null; photo.removeAttribute('src'); photo.hidden = true;
  $('#liquidPhotoStage').hidden = true; $('#photoFractionLine').hidden = true;
  $('#usableTopGuide').hidden = true; $('#usableBottomGuide').hidden = true; $('#liquidPhotoZoom').hidden = true;
  $('#usableAdjustment').hidden = true; $('#liquidImageRetry').hidden = true; $('#liquidImageSource').textContent = '';
  $('#liquidUploadOwnPrompt').hidden = true; $('#liquidOwnCamera').value = ''; $('#liquidOwnFile').value = '';
  usableRegion = { ...DEFAULT_USABLE };
}
// 공식 사진이 전혀 없는 경우(data.status === 'not_found') - 실물 사진도, 참고용 도형도 없이 분할선/
// label을 절대 그리지 않는다(요청: "제품 사진이 없는데 1/2 label이 허공에 뜨는" 문제의 근본 원인이
// 바로 여기서 참고용 도형 위에 분할선을 그려온 것이었다). 사진이 없을 때 보여줄 것은 "제품 사진이
// 없어요" 안내와 촬영/선택 버튼뿐이다 - liquidPhotoReady를 true로 만드는 어떤 경로도 거치지 않는다.
function showNoOfficialPhoto(message) {
  liquidPhotoReady = false;
  $('#liquidPhotoStage').hidden = true; $('#liquidProductPhoto').hidden = true;
  $('#liquidImageStatus').textContent = message; $('#usableAdjustment').hidden = true; $('#liquidPhotoZoom').hidden = true;
  $('#liquidUploadOwnPrompt').hidden = false;
  renderFraction();
}
async function loadLiquidPhoto(item) {
  // Defense in depth: this must be unreachable for anything but a pouch/stick, but never draw a
  // fraction line even if some future caller gets that wrong.
  if (currentContainerType !== 'pouch') return;
  resetLiquidPhoto(); liquidImageItem = item;
  const request = liquidImageRequest = new AbortController(); $('#liquidImageStatus').textContent = '선택한 제품의 공식 사진을 확인하고 있습니다…';
  try {
    let data;
    if (safeImage(item.imageUrl)) data = { status: 'ok', id: item.id, imageUrl: item.imageUrl, source: '식약처 제품 정보' };
    else {
      const response = await fetch(API_BASE + '/api/liquid-image?' + new URLSearchParams({ item_seq: item.id }), { signal: request.signal });
      data = await response.json(); if (!response.ok) throw new Error(data.error || '공식 이미지 조회 실패');
    }
    if (request.signal.aborted) return;
    if (String(data.id) !== String(item.id)) throw new Error('선택 제품과 이미지 품목기준코드가 일치하지 않습니다.');
    // "공식 이미지 자체가 없음"(not_found)과 "이미지는 있지만 포 crop만 실패"는 서로 다른 상태다 - 후자는
    // 이 분기를 타지 않고 아래에서 원본 사진을 그대로 보여준다(showFullPhoto).
    if (data.status === 'not_found') { showNoOfficialPhoto('공식 포장 사진이 없어요.'); return; }
    const inlinePhoto = typeof data.imageData === 'string' && data.imageData.length <= 3000000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(data.imageData);
    if (data.status !== 'ok' || (!safeImage(data.imageUrl) && !inlinePhoto)) throw new Error('공식 이미지 주소를 확인하지 못했습니다.');
    const rawSrc = inlinePhoto ? data.imageData : data.imageUrl;
    // Decoded off-DOM first so a failed/short crop attempt never leaves a half-set #liquidProductPhoto.
    const source = new Image();
    source.onload = () => { if (!request.signal.aborted) applyPouchCrop(source, item, data, rawSrc); };
    source.onerror = () => {
      if (request.signal.aborted) return;
      $('#liquidImageStatus').textContent = '공식 사진을 불러오지 못했습니다. 이미지 미제공과는 다른 상태입니다.'; $('#liquidImageRetry').hidden = false;
    };
    source.src = rawSrc;
  } catch (error) {
    if (request.signal.aborted) return;
    $('#liquidImageStatus').textContent = error instanceof TypeError ? '공식 이미지 연결을 확인하고 다시 시도해주세요.' : error.message;
    $('#liquidImageRetry').hidden = false;
  }
}
// Priority chain (never jumps straight to the generic schematic just because auto-crop failed):
// 1) automatic pouch/bottle detection  2) a saved per-product override rect
// 3) the full official photo, uncropped (still real, still better than a generic shape)
// 4) the generic schematic - reserved for when there is truly no official photo (data.status === 'not_found').
function applyPouchCrop(source, item, data, rawSrc) {
  $('#liquidPhotoStage').hidden = false;
  const override = POUCH_CROP_OVERRIDES[String(item.id)];
  let rect = null, auto = false;
  try {
    if (pouchCropModule) {
      const scale = Math.min(1, 450 / Math.max(source.naturalWidth, source.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(source.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(source.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        const found = pouchCropModule.findPouchRegion(ctx.getImageData(0, 0, canvas.width, canvas.height));
        if (found) { rect = found; auto = true; }
      }
    }
  } catch { /* Canvas pixel access can fail (unsupported/tainted); fall back below. */ }
  if (!rect && override?.cropRect) rect = override.cropRect;
  if (!rect) { showFullPhoto(item, data, rawSrc); return; }
  try {
    const sx = Math.round(rect.x * source.naturalWidth), sy = Math.round(rect.y * source.naturalHeight);
    const sw = Math.max(1, Math.round(rect.width * source.naturalWidth)), sh = Math.max(1, Math.round(rect.height * source.naturalHeight));
    // Never upscale past the source's own resolution - a small, sharp crop beats a large, blurry one.
    const outScale = Math.min(1, 1100 / Math.max(sw, sh));
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = Math.max(1, Math.round(sw * outScale)); cropCanvas.height = Math.max(1, Math.round(sh * outScale));
    const cctx = cropCanvas.getContext('2d');
    if (!cctx) throw new Error('canvas-unavailable');
    // Source rect only - the crop never includes pixels outside the detected/override region, so
    // any box in the original photo cannot appear, and the crop's own aspect ratio is preserved.
    cctx.drawImage(source, sx, sy, sw, sh, 0, 0, cropCanvas.width, cropCanvas.height);
    const photo = $('#liquidProductPhoto');
    photo.alt = `${item.name} · ${item.company || ''} 공식 포장 사진 (포장 용기 영역만)`;
    photo.src = cropCanvas.toDataURL('image/jpeg', 0.95); photo.hidden = false;
    liquidPhotoReady = true;
    $('#liquidImageStatus').textContent = '제품 사진의 분할 위치를 참고하세요. 정확한 용량은 계량도구로 확인해주세요.';
    $('#liquidImageSource').textContent = `${data.source || '식약처 공식 데이터'} · 품목기준코드 ${item.id}`;
    usableRegion = override?.usableLiquidRect ? { ...override.usableLiquidRect } : { ...DEFAULT_USABLE };
    $('#usableAdjustment').hidden = false; $('#liquidPhotoZoom').hidden = false; syncUsableInputs(); renderFraction();
  } catch {
    showFullPhoto(item, data, rawSrc);
  }
}
// No confident auto/override crop: show the real official photo as-is rather than a generic shape.
// No canvas step is needed here, so this also works when canvas itself is unavailable.
function showFullPhoto(item, data, rawSrc) {
  const photo = $('#liquidProductPhoto');
  photo.alt = `${item.name} · ${item.company || ''} 공식 제품 사진 (포장 용기 부분 자동 구분 실패 - 원본 그대로 표시)`;
  photo.src = rawSrc; photo.hidden = false;
  liquidPhotoReady = true;
  $('#liquidImageStatus').textContent = '포장 용기 부분을 자동으로 구분하지 못해 공식 사진 전체를 표시합니다. 분할 위치는 대략적인 참고용입니다.';
  $('#liquidImageSource').textContent = `${data.source || '식약처 공식 데이터'} · 품목기준코드 ${item.id}`;
  usableRegion = { ...DEFAULT_USABLE };
  $('#usableAdjustment').hidden = false; $('#liquidPhotoZoom').hidden = false; syncUsableInputs(); renderFraction();
}
function syncUsableInputs() {
  $('#usableTop').value = usableRegion.top; $('#usableTopValue').textContent = usableRegion.top + '%';
  $('#usableBottom').value = usableRegion.bottom; $('#usableBottomValue').textContent = usableRegion.bottom + '%';
}
function renderPhotoOverlay() {
  // Bottles (and anything not yet classified) must never get a line, no matter what liquidPhotoReady
  // happens to be - see currentContainerType's definition above. Nor does a product with no real
  // photo at all (liquidPhotoReady stays false in that case - see showNoOfficialPhoto()): there is no
  // surface to draw a line on, so no line, ever.
  if (currentContainerType !== 'pouch') {
    $('#photoFractionLine').hidden = true; $('#usableTopGuide').hidden = true; $('#usableBottomGuide').hidden = true; return;
  }
  const region = usableRegion;
  const line = $('#photoFractionLine');
  line.hidden = !liquidPhotoReady || $('#liquidPhotoStage').hidden;
  if (!line.hidden) {
    // Top-based: a pouch is torn open at the top and drunk from the top down, so "1/4" means "drink
    // down to the line 25% of the way from the top of the usable area" - not 25% up from the bottom.
    line.style.top = (region.top + (region.bottom - region.top) * fraction) + '%';
    $('#photoFractionLabel').textContent = fractionLabel + ' 복용선';
  }
  const showGuides = liquidPhotoReady && $('#usableAdjustment').open;
  $('#usableTopGuide').hidden = !showGuides; $('#usableBottomGuide').hidden = !showGuides;
  if (showGuides) { $('#usableTopGuide').style.top = region.top + '%'; $('#usableBottomGuide').style.top = region.bottom + '%'; }
}
$('#usableTop').oninput = () => {
  usableRegion.top = Math.min(Number($('#usableTop').value), usableRegion.bottom - 10);
  $('#usableTop').value = usableRegion.top; $('#usableTopValue').textContent = usableRegion.top + '%'; renderPhotoOverlay();
};
$('#usableBottom').oninput = () => {
  usableRegion.bottom = Math.max(Number($('#usableBottom').value), usableRegion.top + 10);
  $('#usableBottom').value = usableRegion.bottom; $('#usableBottomValue').textContent = usableRegion.bottom + '%'; renderPhotoOverlay();
};
$('#usableAdjustment').addEventListener('toggle', renderPhotoOverlay);
$('#liquidImageRetry').onclick = () => { if (liquidImageItem) loadLiquidPhoto(liquidImageItem); };
// The compact view deliberately caps display height (never upscales a low-res crop) - this reuses
// the existing photo modal so a user who wants a bigger look can still get one on demand.
$('#liquidPhotoZoom').onclick = () => {
  if (!liquidPhotoReady) return;
  const photo = $('#liquidProductPhoto');
  $('#photoModalImage').replaceChildren(Object.assign(document.createElement('img'), { src: photo.src, alt: photo.alt }));
  if (typeof photoModal.showModal === 'function') photoModal.showModal(); else photoModal.setAttribute('open', '');
};

// --- "포/스틱 사진으로 직접 확인": the fraction guide without requiring any product-DB match.
// Works from two entry points: the standalone upload panel (no known product), and the "no official
// photo" prompt inside the search flow (product known, but only the crop step needs a user photo).
// Processing stays entirely on-device (object URL + canvas), same privacy posture as the
// prescription OCR photo handling above - nothing here is uploaded to the server.
$('#liquidWaySearch').onclick = () => {
  $('#liquidWaySearch').setAttribute('aria-pressed', 'true'); $('#liquidWayUpload').setAttribute('aria-pressed', 'false');
  $('#liquidSearchWay').hidden = false; $('#liquidUploadWay').hidden = true;
};
$('#liquidWayUpload').onclick = () => {
  $('#liquidWaySearch').setAttribute('aria-pressed', 'false'); $('#liquidWayUpload').setAttribute('aria-pressed', 'true');
  $('#liquidSearchWay').hidden = true; $('#liquidUploadWay').hidden = false;
};

let uploadObjectUrl = null, uploadSourceImage = null;
const DEFAULT_UPLOAD_CROP = { top: 10, bottom: 90, left: 30, right: 70 };
let uploadCropRegion = { ...DEFAULT_UPLOAD_CROP };
let uploadUsableRegion = { ...DEFAULT_USABLE };
let uploadFraction = .5, uploadFractionLabel = '1/2';
function resetUploadGuide() {
  if (uploadObjectUrl) { URL.revokeObjectURL(uploadObjectUrl); uploadObjectUrl = null; }
  uploadSourceImage = null;
  $('#uploadGuide').hidden = true; $('#uploadCropAdjust').hidden = true; $('#uploadResult').hidden = true;
  $('#uploadRawPhoto').removeAttribute('src'); $('#uploadPhoto').removeAttribute('src');
  uploadCropRegion = { ...DEFAULT_UPLOAD_CROP }; uploadUsableRegion = { ...DEFAULT_USABLE };
}
function validUploadCrop(region) {
  return Object.values(region).every(n => Number.isFinite(n) && n >= 0 && n <= 100) && region.bottom - region.top >= 5 && region.right - region.left >= 5;
}
async function handleUploadedPhoto(file, { title, dbMatched }) {
  if (!file) return;
  const statusEl = $(dbMatched ? '#liquidImageStatus' : '#uploadPickStatus');
  if (!file.type.startsWith('image/') || file.size > 20 * 1024 * 1024) { statusEl.textContent = '20MB 이하의 이미지 파일을 선택해주세요.'; return; }
  resetUploadGuide();
  $('#uploadGuide').hidden = false; $('#uploadTitle').textContent = title || '직접 업로드한 사진'; $('#uploadDbNote').hidden = !!dbMatched;
  statusEl.textContent = '';
  uploadObjectUrl = URL.createObjectURL(file);
  const img = new Image();
  try { img.src = uploadObjectUrl; await img.decode(); }
  catch { statusEl.textContent = '이미지를 불러오지 못했습니다. 다른 사진을 선택해주세요.'; resetUploadGuide(); return; }
  uploadSourceImage = img; $('#uploadRawPhoto').src = uploadObjectUrl;
  let rect = null;
  try {
    if (pouchCropModule) {
      const scale = Math.min(1, 450 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d');
      if (ctx) { ctx.drawImage(img, 0, 0, canvas.width, canvas.height); rect = pouchCropModule.findPouchRegion(ctx.getImageData(0, 0, canvas.width, canvas.height)); }
    }
  } catch { /* Canvas unavailable - fall through to manual adjustment below. */ }
  if (rect) finishUploadCrop(rect, true);
  else { uploadCropRegion = { ...DEFAULT_UPLOAD_CROP }; syncUploadCropInputs(); renderUploadCropBox(); $('#uploadCropAdjust').hidden = false; $('#uploadResult').hidden = true; }
  $('#uploadGuide').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function syncUploadCropInputs() {
  for (const key of ['top', 'bottom', 'left', 'right']) {
    const id = 'uploadCrop' + key[0].toUpperCase() + key.slice(1);
    $('#' + id).value = uploadCropRegion[key]; $('#' + id + 'Value').textContent = uploadCropRegion[key] + '%';
  }
}
function renderUploadCropBox() {
  const r = uploadCropRegion, box = $('#uploadCropBox');
  box.style.top = r.top + '%'; box.style.height = (r.bottom - r.top) + '%'; box.style.left = r.left + '%'; box.style.width = (r.right - r.left) + '%';
}
for (const key of ['top', 'bottom', 'left', 'right']) {
  const id = 'uploadCrop' + key[0].toUpperCase() + key.slice(1);
  $('#' + id).oninput = () => { uploadCropRegion[key] = Number($('#' + id).value); $('#' + id + 'Value').textContent = uploadCropRegion[key] + '%'; renderUploadCropBox(); };
}
$('#confirmUploadCrop').onclick = () => {
  if (!validUploadCrop(uploadCropRegion)) return;
  const r = uploadCropRegion;
  finishUploadCrop({ x: r.left / 100, y: r.top / 100, width: (r.right - r.left) / 100, height: (r.bottom - r.top) / 100 }, false);
};
$('#uploadAdjustCropAgain').onclick = () => { $('#uploadResult').hidden = true; $('#uploadCropAdjust').hidden = false; renderUploadCropBox(); };
$('#uploadRetake').onclick = () => resetUploadGuide();
function finishUploadCrop(rect, auto) {
  const img = uploadSourceImage;
  const sx = Math.round(rect.x * img.naturalWidth), sy = Math.round(rect.y * img.naturalHeight);
  const sw = Math.max(1, Math.round(rect.width * img.naturalWidth)), sh = Math.max(1, Math.round(rect.height * img.naturalHeight));
  const outScale = Math.min(1, 1100 / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * outScale)); canvas.height = Math.max(1, Math.round(sh * outScale));
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  $('#uploadPhoto').src = canvas.toDataURL('image/jpeg', 0.95); $('#uploadPhoto').alt = '지정한 포장 영역';
  $('#uploadResultStatus').textContent = auto ? '사진에서 자동으로 찾은 영역입니다.' : '지정한 영역입니다.';
  $('#uploadCropAdjust').hidden = true; $('#uploadResult').hidden = false;
  uploadUsableRegion = { ...DEFAULT_USABLE }; syncUploadUsableInputs();
  uploadFraction = .5; uploadFractionLabel = '1/2'; renderUploadFraction();
}
function syncUploadUsableInputs() {
  $('#uploadUsableTop').value = uploadUsableRegion.top; $('#uploadUsableTopValue').textContent = uploadUsableRegion.top + '%';
  $('#uploadUsableBottom').value = uploadUsableRegion.bottom; $('#uploadUsableBottomValue').textContent = uploadUsableRegion.bottom + '%';
}
function renderUploadFraction() {
  const line = $('#uploadFractionLine');
  // Top-based, same reasoning as renderPhotoOverlay(): drunk from the torn-open top downward.
  line.style.top = (uploadUsableRegion.top + (uploadUsableRegion.bottom - uploadUsableRegion.top) * uploadFraction) + '%';
  $('#uploadFractionLabel').textContent = uploadFractionLabel + ' 복용선';
  $('#uploadFractionVolume').textContent = `${uploadFractionLabel} 위치 · 대략적인 참고용 표시입니다`;
  document.querySelectorAll('[data-upload-fraction]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.uploadFraction) === uploadFraction)));
  const showGuides = $('#uploadUsableAdjustment').open;
  $('#uploadUsableTopGuide').hidden = !showGuides; $('#uploadUsableBottomGuide').hidden = !showGuides;
  if (showGuides) { $('#uploadUsableTopGuide').style.top = uploadUsableRegion.top + '%'; $('#uploadUsableBottomGuide').style.top = uploadUsableRegion.bottom + '%'; }
}
document.querySelectorAll('[data-upload-fraction]').forEach(button => button.onclick = () => {
  uploadFraction = Number(button.dataset.uploadFraction); uploadFractionLabel = button.textContent; renderUploadFraction();
});
$('#uploadUsableTop').oninput = () => {
  uploadUsableRegion.top = Math.min(Number($('#uploadUsableTop').value), uploadUsableRegion.bottom - 10);
  $('#uploadUsableTop').value = uploadUsableRegion.top; $('#uploadUsableTopValue').textContent = uploadUsableRegion.top + '%'; renderUploadFraction();
};
$('#uploadUsableBottom').oninput = () => {
  uploadUsableRegion.bottom = Math.max(Number($('#uploadUsableBottom').value), uploadUsableRegion.top + 10);
  $('#uploadUsableBottom').value = uploadUsableRegion.bottom; $('#uploadUsableBottomValue').textContent = uploadUsableRegion.bottom + '%'; renderUploadFraction();
};
$('#uploadUsableAdjustment').addEventListener('toggle', renderUploadFraction);
$('#uploadPhotoZoom').onclick = () => {
  const photo = $('#uploadPhoto'); if (!photo.src) return;
  $('#photoModalImage').replaceChildren(Object.assign(document.createElement('img'), { src: photo.src, alt: photo.alt }));
  if (typeof photoModal.showModal === 'function') photoModal.showModal(); else photoModal.setAttribute('open', '');
};
$('#uploadCamera').onchange = event => handleUploadedPhoto(event.target.files?.[0], { title: null, dbMatched: false });
$('#uploadFile').onchange = event => handleUploadedPhoto(event.target.files?.[0], { title: null, dbMatched: false });
$('#liquidOwnCamera').onchange = event => handleUploadedPhoto(event.target.files?.[0], { title: liquidSelectedItem?.name, dbMatched: true });
$('#liquidOwnFile').onchange = event => handleUploadedPhoto(event.target.files?.[0], { title: liquidSelectedItem?.name, dbMatched: true });
