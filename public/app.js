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
// Prescription dose math/parsing (see dose-calc.js) - same dynamic-import pattern as pouch-crop.js
// below, so a browser/test environment without it just skips dose analysis instead of failing.
let doseCalc = null;
import('./dose-calc.js').then(m => { doseCalc = m; }).catch(() => {});
// The Three.js/OrbitControls scene loads asynchronously (real fetch in the browser); this stays
// null in environments without it (e.g. the DOM test harness), and 2D keeps working regardless.
let three3d = null;
(async () => {
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
function selectMedicine(item, button, fetchedAt) {
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
function showFlavorBadge(flavorInfo) {
  const badge = $('#flavorBadge'), chips = $('#flavorChips');
  if (!badge || !chips) return;
  if (!flavorInfo) { badge.hidden = true; return; }
  chips.replaceChildren();
  for (const label of flavorInfo.labels) {
    const chip = document.createElement('span'); chip.className = 'flavor-chip'; chip.textContent = label;
    if (flavorInfo.sourceText) chip.title = `${flavorInfo.sourceType}: ${flavorInfo.sourceText}`;
    chips.append(chip);
  }
  badge.hidden = false;
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
  // A compact one-line summary next to the name, so shape/color/identifying marks are visible
  // without expanding anything. Flavor gets its own dedicated badge (showFlavorBadge above) instead
  // of being folded into this line, since it's the one fact people scan for specifically.
  const quickFacts = $('#quickFacts');
  if (quickFacts) {
    const color = [item.colorFront, item.colorBack].filter(Boolean).join('/');
    const marks = [item.printFront && `앞 ${item.printFront}`, item.printBack && `뒤 ${item.printBack}`].filter(Boolean).join('/');
    const bits = [item.shape, color, marks].filter(Boolean);
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
function readRecents() { try { return JSON.parse(localStorage.getItem('recentMedicines')) || []; } catch { return []; } }
function writeRecents(list) { try { localStorage.setItem('recentMedicines', JSON.stringify(list.slice(0, 8))); } catch { /* Recents are a convenience; failing to persist is not fatal. */ } }
function pushRecent(item) {
  writeRecents([{ id: item.id, name: item.name, company: item.company }, ...readRecents().filter(r => r.id !== item.id)]);
  renderRecents();
}
function renderRecents() {
  const row = $('#recentRow'), section = $('#recentSection');
  if (!row || !section) return;
  const list = readRecents();
  section.hidden = list.length === 0;
  row.replaceChildren();
  for (const r of list) {
    const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'recent-chip';
    const name = document.createElement('b'); name.textContent = r.name;
    const company = document.createElement('small'); company.textContent = r.company || '';
    chip.append(name, company);
    chip.onclick = () => openRecent(r.id);
    row.append(chip);
  }
}
async function openRecent(id) {
  showScreen('pill'); setPillStep('search');
  query = { item_seq: String(id) }; page = 1;
  await search();
  $('#results button')?.click();
}
// "내 약 보관함": deliberate, user-initiated saves (♡ toggle) - independent of "최근 확인한 약" above,
// which is an automatic view-history list. Do not merge the two. Schema mirrors a future
// `saved_medicines` table (itemSeq as the primary identifier, not the whole API response) so this
// can move to a real account/Supabase backend later without a data migration; see savedEntryFor().
const SAVED_KEY = 'savedMedicinesV1';
function readSaved() { try { const list = JSON.parse(localStorage.getItem(SAVED_KEY)); return Array.isArray(list) ? list : []; } catch { return []; } }
function writeSaved(list) { try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch { /* Saves are device-local; a full disk/private-mode failure just means nothing persists. */ } }
function isSavedMedicine(itemSeq) { return readSaved().some(entry => entry.itemSeq === String(itemSeq)); }
function savedEntryFor(item, kind) {
  return {
    itemSeq: String(item.id), itemName: item.name, entpName: item.company || '',
    dosageForm: kind === 'liquid' ? (item.permit?.data?.description || item.description || '') : (item.form || ''),
    shape: item.shape || '', color: [item.colorFront, item.colorBack].filter(Boolean).join('/'),
    length: item.long ?? null, width: item.short ?? null, thickness: item.thick ?? null,
    imageUrl: safeImage(item.imageUrl) ? item.imageUrl : '', kind
  };
}
function saveMedicine(item, kind) {
  const list = readSaved();
  if (list.some(entry => entry.itemSeq === String(item.id))) return;
  list.unshift({ ...savedEntryFor(item, kind), savedAt: new Date().toISOString() });
  writeSaved(list); renderStorageList(); syncSaveButtons();
}
function unsaveMedicine(itemSeq) {
  writeSaved(readSaved().filter(entry => entry.itemSeq !== String(itemSeq)));
  renderStorageList(); syncSaveButtons();
}
function toggleSaveMedicine(item, kind) { if (isSavedMedicine(item.id)) unsaveMedicine(item.id); else saveMedicine(item, kind); }
// One shared button factory for every card (pill results, pill detail, rx candidates/selected,
// liquid results) so ♡/♥ state and behavior stay identical everywhere - see item 7/13 of the request.
function makeSaveButton(item, kind) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'save-heart'; button.dataset.saveId = String(item.id);
  button.onclick = event => { event.preventDefault(); event.stopPropagation(); toggleSaveMedicine(item, kind); };
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
    const canCompare = entry.kind === 'pill' && Number.isFinite(entry.length) && Number.isFinite(entry.width);
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'storage-check';
    checkbox.checked = storageCompareIds.has(entry.itemSeq); checkbox.disabled = !canCompare;
    checkbox.setAttribute('aria-label', `${entry.itemName} 비교에 포함`);
    checkbox.onchange = () => { if (checkbox.checked) storageCompareIds.add(entry.itemSeq); else storageCompareIds.delete(entry.itemSeq); syncStorageCompareButton(); };
    const info = flowNode('div', '', 'storage-card-info');
    info.append(flowNode('b', entry.itemName), flowNode('small', entry.entpName || '제조사 미제공'));
    if (entry.kind === 'pill') {
      info.append(flowNode('small', Number.isFinite(entry.length) && Number.isFinite(entry.width) ? `${entry.length} × ${entry.width}${Number.isFinite(entry.thickness) ? ' × ' + entry.thickness : ''} mm` : '치수 정보 부족'));
      info.append(flowNode('small', `${entry.shape || '모양 미제공'}${entry.dosageForm ? ' · ' + entry.dosageForm : ''}`));
    } else {
      info.append(flowNode('small', entry.dosageForm || '액체약'));
    }
    const actions = flowNode('div', '', 'flow-actions');
    const view = flowNode('button', entry.kind === 'pill' ? '크기 보기' : '확인하기'); view.type = 'button';
    view.onclick = () => openSavedMedicine(entry);
    const remove = flowNode('button', '삭제'); remove.type = 'button'; remove.onclick = () => unsaveMedicine(entry.itemSeq);
    actions.append(view, remove);
    card.append(checkbox, info, actions); container.append(card);
  }
  syncStorageCompareButton();
}
function syncStorageCompareButton() { $('#storageCompareBtn').disabled = storageCompareIds.size < 2; }
// Saved entries intentionally carry only a trimmed snapshot (see savedEntryFor's comment) - refetch
// the current official data by item_seq rather than rendering from possibly-stale saved fields.
async function openSavedMedicine(entry) {
  if (entry.kind === 'liquid') {
    showScreen('liquid'); $('#liquidWaySearch').click();
    try {
      const response = await fetch(API_BASE + '/api/liquids?' + new URLSearchParams({ item_seq: entry.itemSeq }));
      const data = await response.json();
      if (response.ok && data.items?.[0]) selectLiquid(data.items[0]);
      else $('#liquidStatus').textContent = '저장된 제품 정보를 다시 불러오지 못했습니다.';
    } catch { $('#liquidStatus').textContent = '저장된 제품 정보를 다시 불러오지 못했습니다.'; }
    return;
  }
  showScreen('pill'); setPillStep('search');
  query = { item_seq: entry.itemSeq }; page = 1;
  await search();
  $('#results button')?.click();
}
$('#storageCompareBtn').onclick = () => {
  const entries = readSaved().filter(entry => storageCompareIds.has(entry.itemSeq));
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
function renderRevealedResults() {
  const results = $('#results');
  for (let i = results.children.length; i < Math.min(revealedCount, allResultItems.length); i++) {
    const { item, fetchedAt } = allResultItems[i];
    const button = document.createElement('button'); button.className = 'result'; button.type = 'button'; button.setAttribute('aria-pressed', String(selected?.id === item.id));
    const title = document.createElement('b'); title.textContent = item.name;
    const company = document.createElement('small'); company.className = 'r-meta'; company.textContent = item.company || '제조사 미제공';
    // Item_seq (품목일련번호) is intentionally left off this compact card - it's still available
    // once selected, in the "추가 품목 정보 보기" accordion - so the card only carries what's needed
    // to tell products apart at a glance: shape, color, and the long x short size.
    const identity = document.createElement('small'); identity.className = 'r-meta';
    identity.textContent = `${item.shape || '모양 미제공'} · ${item.colorFront || '색상 미제공'}${item.colorBack ? ' / ' + item.colorBack : ''}`;
    const dims = document.createElement('small'); dims.className = 'r-meta';
    dims.textContent = item.long && item.short ? `장축 × 단축 · ${item.long} × ${item.short} mm` : '치수 정보 부족';
    const copy = document.createElement('span'); copy.className = 'result-copy'; copy.append(title, company, identity, dims);
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
      if (liquid) { showScreen('liquid'); $('#liquidWaySearch').click(); selectLiquid(item); return; }
      selectMedicine(item, button, fetchedAt);
    };
    results.append(button);
  }
  $('#showMoreResults').hidden = revealedCount >= allResultItems.length;
  syncSaveButtons();
}
$('#showMoreResults').onclick = () => { revealedCount += REVEAL_STEP; renderRevealedResults(); };

async function search(nextPage = 1) {
  controller?.abort(); controller = new AbortController(); const current = controller;
  $('#searchStatus').textContent = '의약품 정보를 찾고 있습니다…';
  $('#results').replaceChildren(); $('#pagination').hidden = true; $('#showMoreResults').hidden = true;
  allResultItems = []; revealedCount = 0;
  try {
    const response = await fetch(API_BASE + '/api/medicines?' + new URLSearchParams({ ...query, pageNo: nextPage, numOfRows: 20 }), { signal: current.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '검색에 실패했습니다.');
    if (current !== controller) return;
    page = data.page;
    $('#searchStatus').textContent = data.total ? `총 ${data.total}개 제품 · 제조사와 함량을 확인해주세요.` : '검색 결과가 없습니다. 제품명을 확인하거나 치수를 직접 입력해주세요.';
    allResultItems = data.items.map(item => ({ item, fetchedAt: data.fetchedAt }));
    revealedCount = REVEAL_STEP;
    renderRevealedResults();
    $('#pagination').hidden = data.total <= data.pageSize;
    $('#prevPage').disabled = page <= 1; $('#nextPage').disabled = page * data.pageSize >= data.total || page >= 100;
    $('#pageLabel').textContent = `${page} / ${Math.ceil(data.total / data.pageSize)}`;
  } catch (error) {
    if (current === controller && error.name !== 'AbortError') {
      $('#searchStatus').textContent = error instanceof TypeError ? '네트워크 연결을 확인해주세요.'
        : error instanceof SyntaxError ? '검색 서버에 연결되지 않았습니다. 앱 서버를 실행해주세요.'
        : error.message;
    }
  }
}
$('#searchForm').onsubmit = event => {
  event.preventDefault();
  query = { item_name: $('#query').value.trim(), entp_name: $('#companyQuery').value.trim(), item_seq: $('#itemSeqQuery').value.trim() };
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
    const home = document.querySelector('#screenHome'), settings = document.querySelector('#screenSettings');
    const pillTool = document.querySelector('#pillTool'), liquidTool = document.querySelector('#liquidTool');
    if (home) home.hidden = mode !== 'home';
    document.querySelector('#prescriptionTool').hidden = mode !== 'prescription';
    document.querySelector('#storageTool').hidden = mode !== 'storage';
    window.dispatchEvent(new CustomEvent('screenchange', { detail: mode }));
    if (settings) settings.hidden = mode !== 'settings';
    pillTool.classList.toggle('hidden', mode !== 'pill');
    liquidTool.classList.toggle('active', mode === 'liquid');
    document.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('active', x.dataset.mode === mode));
    if (mode === 'pill') syncPillStep();
    syncThreeVisibility();
    window.scrollTo(0, 0);
  }
  // The 3D scene is the app's sole tablet viewer now (no 2D/3D tab to drive show()/hide() any more),
  // so its render loop just follows whether the pill screen is actually on screen.
  function syncThreeVisibility() {
    if (!three3d) return;
    if (document.querySelector('#pillTool').classList.contains('hidden')) three3d.hide(); else three3d.show();
  }
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => showScreen(b.dataset.mode));

  // Mobile shows the pill tool as two full-screen steps (search results, then the size/result
  // screen) instead of the side-by-side desktop layout; see the `#pillTool[data-step]` CSS rules.
  // `smooth` requires a real layout engine (no-op/instant in the happy-dom test harness, which has
  // no scrolling concept anyway) - selecting a product visibly glides to the result area instead of
  // an abrupt jump, on both the mobile step-through view and the desktop 2-column view.
  function setPillStep(step) { document.querySelector('#pillTool').dataset.step = step; window.scrollTo({ top: 0, behavior: 'smooth' }); }
  // Re-entering pill mode (Home card / bottom-nav tap) resumes the result screen only if the user
  // actually did something this session - NOT just because the manual-entry fields still hold their
  // non-empty placeholder example values (17.2/7.1), which would otherwise always look "engaged".
  function syncPillStep() { setPillStep(pillEngaged ? 'result' : 'search'); }
  document.querySelector('#backToHomeFromSearch').onclick = () => rxSearchTarget ? $('#rxSearchCancel').click() : showScreen('home');
  document.querySelector('#backToSearchFromResult').onclick = () => setPillStep('search');
  document.querySelector('#settingsCalRow').onclick = () => { showScreen('pill'); setPillStep('result'); if (!panel.classList.contains('open')) toggle.click(); };

  showScreen('home');
  renderRecents();
  renderStorageList(); syncSaveButtons();
  const level=document.querySelector('#levelRange'),maxMl=document.querySelector('#maxMl'),cupShape=document.querySelector('#cupShape');
  function liquidRender(){const p=Number(level.value)/100,m=Math.max(0,Number(maxMl.value)||0);const ratio=cupShape.value==='taper'?(.45*p+.55*p*p):p;const ml=Math.round(m*ratio*10)/10;document.querySelector('#currentMl').value=ml;document.querySelector('#volumeText').textContent=ml+' mL';document.querySelector('#levelPercent').textContent=level.value+'%';document.querySelector('#levelLine').style.bottom=level.value+'%'}
  [level,maxMl,cupShape].forEach(x=>x.addEventListener('input',liquidRender));liquidRender();

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
async function flowSearch(path, term, signal, page = 1) {
  const response = await fetch(API_BASE + path + '?' + new URLSearchParams({ item_name: term, pageNo: page, numOfRows: 20 }), { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '검색에 실패했습니다.');
  return data;
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
// Patient info for dose comparison only - never sent to the server (see #rxPatientInfo's own tip
// text). DOB/age text is shown back to the user for their own reference but is deliberately NOT
// parsed into an automatic age-band pick (see computeDoseAnalysis's ageBandCount guard) - free-text
// birth dates are too failure-prone to trust for silently selecting which official dose row applies.
let patientWeightKg = null, patientDobText = '';
$('#rxPatientWeight').oninput = () => {
  const n = Number($('#rxPatientWeight').value);
  patientWeightKg = Number.isFinite(n) && n > 0 ? n : null;
  rxGroups.forEach(group => { if (group.chosen) renderRxDoseDetail(group); });
};
$('#rxPatientDob').oninput = () => { patientDobText = $('#rxPatientDob').value; };
function updateRxSelection() {
  rxSelected.clear();
  for (const group of rxGroups) if (group.chosen) rxSelected.set(group.chosen.item.id, group.chosen);
  $('#rxCompare').disabled = !rxSelected.size;
  $('#rxComparison').hidden = true;
  $('#rxSelectedSection').hidden = !rxSelected.size;
  $('#rxSelectedTitle').textContent = `선택한 처방약 ${rxSelected.size}개`;
  const list = $('#rxSelectedList'); list.replaceChildren();
  for (const { item, fetchedAt, kind } of rxSelected.values()) {
    const group = rxGroups.find(g => g.chosen && g.chosen.item.id === item.id);
    const row = flowNode('article', '', 'rx-selected-card'); row.id = `rxCard-${item.id}`;
    row.append(flowNode('b', `✓ ${item.name}`), flowNode('p', item.company || '제조사 미제공'));
    row.append(kind === 'liquid' ? flowNode('p', `액상 · ${item.permit?.data?.packaging || '포장단위 미제공'}`) : flowNode('p', medicineSize(item)));
    if (kind !== 'liquid') row.append(flowNode('p', `${item.form || '제형 미제공'} · ${item.shape || '모양 미제공'} · ${[item.colorFront, item.colorBack].filter(Boolean).join(' / ') || '색상 미제공'}`));
    row.append(flowNode('p', rxDoseSummaryLine(group), 'rx-dose-summary'));
    const actions = flowNode('div', '', 'flow-actions');
    const size = flowNode('button', kind === 'liquid' ? '포장 보기' : '크기 확인'); size.type = 'button';
    size.onclick = () => { if (kind === 'liquid') { showScreen('liquid'); $('#liquidWaySearch').click(); selectLiquid(item); } else { showScreen('pill'); selectMedicine(item, size, fetchedAt); } };
    const analyze = flowNode('button', '용량 분석 보기'); analyze.type = 'button';
    analyze.onclick = () => toggleRxDoseDetail(group, row, analyze);
    const remove = flowNode('button', '삭제'); remove.type = 'button';
    remove.onclick = () => { rxGroups.forEach(g => { if (g.chosen?.item.id === item.id) { g.chosen = null; renderRxGroup(g); } }); updateRxSelection(); };
    // Confirming a prescription item never auto-saves it to 내 약 보관함 - this button is the only
    // path from "처방전에서 찾은 약" into the separate, user-curated storage list (see item 8).
    // Ordered before "삭제" so the destructive action stays last.
    actions.append(size, analyze, makeSaveButton(item, kind), remove); row.append(actions);
    const detailPanel = flowNode('div', '', 'rx-dose-detail'); detailPanel.hidden = true; row.append(detailPanel); list.append(row);
  }
  syncSaveButtons();
}
// 섹션 11의 간략 표시 형식: "1회 ○○ · 1일 ○회", 계산 가능한 항목만 보여준다.
function rxDoseSummaryLine(group) {
  if (group?.row && medSchema) return medSchema.medicationSummary(group.row);
  if (!group?.ocrDose || !Number.isFinite(group.ocrDose.doseAmount)) return '처방 용량: 처방전에서 읽지 못함 - 아래 "용량 분석 보기"에서 직접 확인하세요.';
  const { doseAmount, doseUnit, frequencyPerDay } = group.ocrDose;
  const unitLabel = { tablet: '정', mL: 'mL', pack: '포' }[doseUnit] || '';
  const parts = [`1회 ${doseAmount}${unitLabel}`];
  if (Number.isFinite(frequencyPerDay)) parts.push(`1일 ${frequencyPerDay}회`);
  return parts.join(' · ') + ' (처방전 인식 결과 - 아래 "용량 분석"에서 성분량·공식 허가용량과 비교)';
}
let rxDoseDetailOpen = new Set();
function toggleRxDoseDetail(group, row, button) {
  const panel = row.querySelector('.rx-dose-detail');
  const opening = panel.hidden !== false; // hidden=true or never set -> opening now
  if (!opening) { panel.hidden = true; button.textContent = '용량 분석 보기'; rxDoseDetailOpen.delete(group.id); return; }
  button.textContent = '용량 분석 접기'; rxDoseDetailOpen.add(group.id);
  renderRxDoseDetail(group);
}
async function renderRxDoseDetail(group) {
  if (!group?.chosen || !rxDoseDetailOpen.has(group.id)) return;
  const { item, kind } = group.chosen;
  const row = $(`#rxCard-${item.id}`); if (!row) return;
  const panel = row.querySelector('.rx-dose-detail'); panel.hidden = false;
  panel.replaceChildren(flowNode('p', '용량을 계산하는 중…', 'tip'));
  const analysis = await computeDoseAnalysis(group);
  if (!rxDoseDetailOpen.has(group.id)) return; // collapsed while awaiting
  panel.replaceChildren();
  const flavor = buildFlavorInfo(item);
  if (flavor) panel.append(flowNode('p', `맛/향: ${flavor.labels.join(', ')}`, 'cal-note'));
  if (safeImage(item.imageUrl)) panel.append(productImage(item.imageUrl, `${item.name} 제품 사진`, 'result-photo'));
  panel.append(flowNode('h4', '이번 처방'));
  if (!analysis || analysis.status === 'insufficient') {
    panel.append(flowNode('p', '정확한 용량 비교를 위해 추가 정보가 필요합니다.', 'tip danger'));
  } else {
    for (const c of analysis.perIngredient) {
      if (c.status !== 'ok') { panel.append(flowNode('p', `${c.name}: 계산에 필요한 정보가 부족합니다.`, 'tip')); continue; }
      const lines = [`1회 ${doseCalc.formatMg(c.doseMg)}`];
      if (Number.isFinite(group.ocrDose.frequencyPerDay)) lines.push(`1일 ${group.ocrDose.frequencyPerDay}회 · 1일 총량 ${doseCalc.formatMg(c.dailyMg)}`);
      if (c.mgPerKgDose) lines.push(`체중 기준 ${doseCalc.round1(c.mgPerKgDose)} mg/kg/회${c.mgPerKgDay ? ` · ${doseCalc.round1(c.mgPerKgDay)} mg/kg/day` : ''}`);
      const box = flowNode('div', '', 'rx-dose-ingredient');
      box.append(flowNode('b', analysis.perIngredient.length > 1 ? c.name : '용량'));
      lines.forEach(l => box.append(flowNode('p', l)));
      panel.append(box);
    }
  }
  panel.append(flowNode('h4', '공식 허가용량'));
  if (analysis?.usageText) {
    for (const c of (analysis.comparisons || [])) {
      if (!c.position) continue;
      const block = flowNode('div', '', 'rx-range-block');
      block.append(flowNode('p', `${c.range.min}${c.range.min !== c.range.max ? `–${c.range.max}` : ''} ${c.unit}`, 'rx-range-label'));
      block.append(rangeBar(c.range.min, c.range.max, c.actual, c.unit));
      block.append(flowNode('p', `현재 처방: ${c.actual} ${c.unit} → ${c.position.label}`, 'rx-position'));
      panel.append(block);
    }
    if (analysis.official.frequency) panel.append(flowNode('p', `공식 1일 투여횟수: ${analysis.official.frequency.min}${analysis.official.frequency.min !== analysis.official.frequency.max ? `~${analysis.official.frequency.max}` : ''}회${Number.isFinite(group.ocrDose?.frequencyPerDay) ? ` · 처방: 1일 ${group.ocrDose.frequencyPerDay}회` : ''}`));
    if (analysis.official.intervalHours) panel.append(flowNode('p', `공식 투여 간격: ${analysis.official.intervalHours.min}${analysis.official.intervalHours.min !== analysis.official.intervalHours.max ? `~${analysis.official.intervalHours.max}` : ''}시간마다 (처방전에 정확한 복용 시각이 없으면 실제 간격은 확인할 수 없습니다)`));
    const maxParts = [];
    if (analysis.official.dailyMaxMgPerKg) maxParts.push(`${analysis.official.dailyMaxMgPerKg} mg/kg/day`);
    if (analysis.official.dailyMaxMg) maxParts.push(`${analysis.official.dailyMaxMg} mg/day`);
    if (analysis.official.dailyMaxTablets) maxParts.push(`${analysis.official.dailyMaxTablets}정/day`);
    if (maxParts.length) panel.append(flowNode('p', `공식 1일 최대: ${maxParts.join(' · ')}`));
    const details = flowNode('details', '', 'guide-options'); details.append(flowNode('summary', '공식 사용법 원문 보기'), flowNode('p', analysis.usageText));
    panel.append(details);
    const source = flowNode('p', '', 'cal-note'); const link = document.createElement('a'); link.href = analysis.sourceUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = `용량정보 출처: ${analysis.sourceLabel}`;
    source.append(link); panel.append(source);
  } else {
    panel.append(flowNode('p', '공식 사용법 정보를 확인하지 못했습니다.', 'tip'));
  }
  for (const g of (analysis?.guards || [])) panel.append(flowNode('p', g, 'tip danger'));
  panel.append(flowNode('p', '이 화면은 의료적 판단이 아니라 공식 허가사항 대비 현재 처방의 위치를 계산해 보여주는 참고 정보입니다. 실제 복용 여부는 처방한 의사·약사와 상의하세요.', 'tip danger'));
}
function rangeBar(min, max, actual, unit) {
  const wrap = flowNode('div', '', 'dose-range-bar');
  const track = flowNode('div', '', 'dose-range-track');
  const clamped = Math.min(1, Math.max(0, (actual - min) / (max - min || 1)));
  const marker = flowNode('span', '', 'dose-range-marker'); marker.style.left = (clamped * 100) + '%';
  marker.title = `${actual} ${unit}`;
  track.append(marker);
  const labels = flowNode('div', '', 'dose-range-labels');
  labels.append(flowNode('span', String(min)), flowNode('span', String(max)));
  wrap.append(track, labels);
  return wrap;
}
function openRxSearch(group = null) {
  const target = group || { id: ++rxGroupSerial, term: '', candidates: [], chosen: null, manual: true };
  target.request?.abort(); rxSearchTarget = target;
  showScreen('pill'); setPillStep('search');
  $('#rxSearchContext').hidden = false; $('#rxSearchTitle').textContent = group ? `인식된 약 이름 수정: ${group.term}` : '처방약 직접 추가';
  $('#query').value = group?.term || ''; $('#companyQuery').value = ''; $('#itemSeqQuery').value = '';
  $('#results').replaceChildren(); $('#pagination').hidden = true; $('#showMoreResults').hidden = true;
  controller?.abort(); $('#searchStatus').textContent = '약 이름을 검색한 뒤 공식 제품을 선택해주세요.'; $('#query').focus();
}
function acceptRxSearch(item, fetchedAt) {
  const target = rxSearchTarget; if (!target) return;
  if (!rxGroups.includes(target)) rxGroups.push(target);
  target.term = target.term || item.name; target.chosen = { item, fetchedAt, kind: isOralLiquidCandidate(item) ? 'liquid' : 'pill' }; target.candidates = [target.chosen]; target.status = '';
  rxSearchTarget = null; $('#rxSearchContext').hidden = true;
  renderRxGroups(); updateRxSelection(); showScreen('prescription');
  $('#rxSelectedSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function editRxRecognition(group) {
  group.request?.abort();
  const form = document.createElement('form'); form.className = 'rx-recognition-editor';
  const controls = {};
  // 약 이름 / 1회 투여량 / 단위 / 1일 투여횟수 / 총 투약일수 - 각각 독립적으로 수정 가능 (item 7).
  for (const [key, title] of [['drugName', '약 이름'], ['dosePerAdministration', '1회 투여량'], ['doseUnit', '단위 (예: 포, 캡슐, mL)'], ['frequencyPerDay', '1일 투여횟수'], ['durationDays', '총 투약일수']]) {
    const label = flowNode('label', title, 'field'), input = document.createElement('input');
    input.name = key; input.value = group.row[key] ?? ''; input.type = /drugName|doseUnit/.test(key) ? 'text' : 'number';
    if (input.type === 'number') { input.min = '0.001'; input.step = key === 'dosePerAdministration' ? 'any' : '1'; }
    if (key === 'drugName') input.required = true;
    controls[key] = input; label.append(input); form.append(label);
  }
  form.append(flowNode('p', `원본 인식 결과: ${group.row.rawName}`));
  const save = flowNode('button', '수정 후 공식 후보 검색'); save.type = 'submit';
  const cancel = flowNode('button', '취소'); cancel.type = 'button'; cancel.onclick = () => renderRxGroup(group);
  form.append(save, cancel);
  form.onsubmit = async event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    for (const [key, input] of Object.entries(controls)) group.row[key] = input.type === 'number' ? (input.value ? Number(input.value) : null) : input.value.trim() || null;
    group.row.strengthOrPackage = group.row.dosePerAdministration != null ? `${group.row.dosePerAdministration}${group.row.doseUnit || ''}` : group.row.strengthOrPackage;
    group.row.needsReview = ['dosePerAdministration', 'frequencyPerDay', 'durationDays'].some(key => group.row[key] == null);
    group.row.userConfirmed = true; group.term = group.row.drugName;
    group.chosen = null; group.candidates = []; updateRxSelection();
    await findRxCandidates(group);
  };
  group.el.replaceChildren(form); controls.drugName.focus();
}
function renderRxGroup(group) {
  if (!group.el) { group.el = flowNode('fieldset', '', 'rx-group'); $('#rxCandidates').append(group.el); }
  const el = group.el; el.replaceChildren(); el.append(flowNode('legend', `${rxGroups.indexOf(group) + 1}. ${group.term}`));
  if (group.row) {
    el.append(flowNode('p', medSchema.medicationSummary(group.row), 'rx-prescription-summary'));
    if (group.row.needsReview) el.append(flowNode('p', '⚠ 인식 결과를 확인해주세요 · 확인이 필요합니다', 'tip'));
    const correction = flowNode('button', '인식 내용 수정'); correction.type = 'button';
    correction.onclick = () => editRxRecognition(group); el.append(correction);
  }
  if (group.chosen) el.append(flowNode('p', `✓ 선택 완료: ${group.chosen.item.name}`));
  if (group.status) el.append(flowNode('p', group.status));
  let pending = null;
  const confirm = flowNode('button', '선택'); confirm.type = 'button'; confirm.disabled = true;
  for (const entry of group.candidates) {
    const { item, kind, strongMatch } = entry, label = flowNode('label', '', 'rx-choice'), radio = document.createElement('input'); radio.type = 'radio'; radio.name = `rx-${group.id}`; radio.value = item.id;
    radio.checked = group.chosen?.item.id === item.id;
    const copy = flowNode('span', item.name);
    // strongMatch: this candidate's own 보험코드(insuranceCode)가 처방전에서 읽은 productCode와 일치 -
    // 자동 선택하지 않고 배지로만 표시 (item 5).
    if (strongMatch) copy.append(flowNode('small', '✓ 코드 일치 · 공식 제품', 'rx-strong-match'));
    copy.append(flowNode('small', item.company || '제조사 미제공'));
    copy.append(kind === 'liquid' ? flowNode('small', `액상 · ${item.permit?.data?.packaging || '포장단위 미제공'}`) : flowNode('small', medicineSize(item)));
    if (kind !== 'liquid') copy.append(flowNode('small', `${item.shape || '모양 미제공'} · ${item.form || '제형 미제공'}`));
    radio.onchange = () => { pending = entry; confirm.disabled = false; }; label.append(radio, copy, makeSaveButton(item, kind)); el.append(label);
  }
  syncSaveButtons();
  confirm.onclick = () => { if (!pending) return; group.chosen = pending; renderRxGroup(group); updateRxSelection(); };
  const edit = flowNode('button', '인식된 약 이름 수정'); edit.type = 'button'; edit.onclick = () => openRxSearch(group);
  const actions = flowNode('div', '', 'flow-actions'); if (group.candidates.length) actions.append(confirm); actions.append(edit);
  if (group.failed) { const retry = flowNode('button', '후보 다시 찾기'); retry.type = 'button'; retry.onclick = () => findRxCandidates(group); actions.append(retry); }
  el.append(actions);
}
function renderRxGroups() {
  $('#rxCandidates').replaceChildren(); $('#rxFoundTitle').hidden = !rxGroups.length;
  rxGroups.forEach(group => { group.el = null; renderRxGroup(group); });
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
    try { data = await flowSearch(path, term, signal); if (data.items.length) return data; }
    catch (e) { error = e; }
  }
  if (error && !data.items.length) throw error;
  return data;
}
async function findRxCandidates(group) {
  group.request?.abort(); const request = group.request = new AbortController();
  group.status = '공식 제품 후보를 찾고 있습니다…'; group.failed = false; renderRxGroup(group);
  try {
    const normalized = rxNormalize(group.term), root = normalized.match(/^[가-힣a-z-]+/)?.[0] || normalized;
    let pillError;
    let data = await searchNameWithFallback('/api/medicines', root, request.signal).catch(error => { pillError = error; return { items: [], total: 0 }; });
    if (data.total > data.items.length && /\d/.test(normalized)) {
      const exact = await flowSearch('/api/medicines', normalized, request.signal);
      data.items = [...new Map([...exact.items, ...data.items].map(item => [item.id, item])).values()];
    }
    if (request.signal.aborted || !rxGroups.includes(group)) return;
    const pillCandidates = [...data.items].map(item => ({ item, fetchedAt: data.fetchedAt, kind: isOralLiquidCandidate(item) ? 'liquid' : 'pill' }));
    // 시럽 등 액상 제형은 낱알식별(위 검색)에 없다 - 처방 용량 분석에서 시럽 처방을 다루려면(요청 예시:
    // "코미시럽 3.5mL/회") 액체약 허가정보에서도 후보를 같이 찾아야 한다. 이름이 명백히 정제류(1~2자 제형
    // 접미어 없이 숫자+mg 로 끝나는 등)면 건너뛰어 불필요한 요청을 줄인다.
    let liquidCandidates = [];
    if (/시럽|액|현탁|내복|산제/.test(group.term) || !pillCandidates.length) {
      try {
        const liquidData = await searchNameWithFallback('/api/liquids', root, request.signal);
        if (!request.signal.aborted) liquidCandidates = liquidData.items.filter(isOralLiquidCandidate).map(item => ({ item, fetchedAt: liquidData.fetchedAt, kind: 'liquid' }));
      } catch (error) { if (!pillCandidates.length) throw error; }
      if (pillError && !liquidCandidates.length) throw pillError;
    }
    if (request.signal.aborted || !rxGroups.includes(group)) return;
    // MFDS cross-validation (item 5): the official APIs only accept item_name/entp_name/item_seq as
    // search filters - there is no way to query by the 보험코드/EDI code a prescription actually
    // prints (see docs/mfds-api.md), so this can't be "look the code up directly". What IS possible,
    // and done here: search still runs by name as always, then any candidate whose OWN insuranceCode
    // (EDI_CODE, already in every search response) matches the code read off the prescription is
    // marked a strong match - never auto-selected, just surfaced first with a badge.
    const productCode = group.row?.productCode || null;
    group.candidates = [...new Map([...pillCandidates, ...liquidCandidates].map(entry => [entry.item.id, entry])).values()]
      .map(entry => ({ ...entry, strongMatch: !!(productCode && entry.item.insuranceCode && entry.item.insuranceCode === productCode) }))
      .sort((a, b) => (b.strongMatch - a.strongMatch) || (rxScore(b.item.name, group.term) - rxScore(a.item.name, group.term)));
    group.status = !group.candidates.length ? '후보가 없습니다. 인식된 약 이름을 수정해 검색해주세요.' : data.total > pillCandidates.length ? '일부 후보를 표시합니다. 찾는 약이 없으면 이름 수정에서 검색해주세요.' : '이름·함량·제조사를 확인한 뒤 제품 하나를 선택하세요.';
  } catch (error) {
    if (request.signal.aborted) return; group.failed = true; group.status = error instanceof TypeError ? '연결을 확인한 뒤 다시 검색해주세요.' : error.message;
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
// The single function that turns (OCR dose + chosen official product + optional weight) into
// everything the detail view shows. Never returns a verdict - only computed numbers, a neutral
// POSITION label, and (when the inputs don't support a confident comparison) a list of reasons why
// not, per the request's own safety-guard list (section 12).
async function computeDoseAnalysis(group) {
  if (!group.chosen) return null;
  if (!doseCalc) return { status: 'insufficient', guards: ['용량 계산 모듈을 아직 불러오지 못했습니다. 잠시 후 다시 시도해주세요.'] };
  const { item, kind } = group.chosen;
  const ocr = group.ocrDose;
  const guards = [];
  if (!ocr || !Number.isFinite(ocr.doseAmount)) {
    return { status: 'insufficient', guards: ['처방전에서 1회 투여량을 정확히 읽지 못했습니다. 정확한 용량 비교를 위해 추가 정보가 필요합니다.'], ocr };
  }
  const materials = item.permit?.data?.materials || '';
  const rawIngredients = doseCalc.parseIngredients(materials);
  if (!rawIngredients.length) {
    return { status: 'insufficient', guards: ['제품의 성분 함량 정보(공식 허가정보)를 확인하지 못했습니다. 정확한 용량 비교를 위해 추가 정보가 필요합니다.'], ocr };
  }
  const concByMl = kind === 'liquid' ? new Map(doseCalc.concentrationsPerMl(materials).map(c => [c.name, c.mgPerMl])) : null;
  const multiIngredient = rawIngredients.length > 1;
  if (multiIngredient) guards.push('복합제입니다 - 성분별로 각각 계산했습니다.');

  const unitOk = kind === 'liquid' ? (!ocr.doseUnit || ocr.doseUnit === 'mL') : (!ocr.doseUnit || ocr.doseUnit === 'tablet');
  if (!unitOk) guards.push('처방전에서 읽은 단위가 제품 제형과 달라 자동 계산을 보류합니다.');

  const perIngredient = rawIngredients.map(ing => {
    if (!unitOk) return { name: ing.name, status: 'insufficient' };
    const doseMg = kind === 'liquid' ? doseCalc.doseFromSyrup(concByMl.get(ing.name), ocr.doseAmount) : doseCalc.doseFromTablet(ing.amountMg, ocr.doseAmount);
    if (doseMg === null) return { name: ing.name, status: 'insufficient' };
    const dailyMg = Number.isFinite(ocr.frequencyPerDay) ? doseCalc.dailyTotal(doseMg, ocr.frequencyPerDay) : null;
    const mgPerKgDose = patientWeightKg ? doseCalc.perKg(doseMg, patientWeightKg) : null;
    const mgPerKgDay = patientWeightKg && dailyMg !== null ? doseCalc.perKg(dailyMg, patientWeightKg) : null;
    return { name: ing.name, status: 'ok', doseMg, dailyMg, mgPerKgDose, mgPerKgDay };
  });

  await ensureEasyData(item, kind);
  const usageText = item.easy?.data?.usage || '';
  const official = usageText ? doseCalc.parseOfficialDosage(usageText) : { confidence: 'insufficient' };

  if (!patientWeightKg && (official.singleDoseMgPerKg || official.singleDoseMlPerKg)) guards.push('체중을 입력하지 않아 체중(mg/kg·mL/kg) 기준 비교를 표시하지 않습니다.');
  if (official.ageBandCount > 1) guards.push('연령대별로 허가용량이 다른 제품입니다 - 처방전 인식만으로는 어느 연령대 기준인지 자동으로 판단하지 않습니다. 허가사항 전체를 직접 확인해주세요.');
  if (/신[ \t]*기능|간[ \t]*기능|투석|신부전|간부전/.test(usageText)) guards.push('신기능·간기능 등에 따라 용량 조절이 필요할 수 있는 약입니다. 해당 사항이 있다면 의사·약사와 상의해주세요.');
  if (multiIngredient && perIngredient.some(p => p.status === 'insufficient')) guards.push('복합제 성분 중 일부는 용량을 계산하지 못했습니다.');

  // Comparison priority: weight-based mg/kg > weight-based mL/kg > plain tablet-count range > plain
  // single mL (only when there's exactly one age band, i.e. no ambiguity about which line applies).
  const comparisons = perIngredient.filter(p => p.status === 'ok').map(p => {
    let range = null, actual = null, unit = '';
    if (patientWeightKg && official.singleDoseMgPerKg && Number.isFinite(p.mgPerKgDose)) { range = official.singleDoseMgPerKg; actual = p.mgPerKgDose; unit = 'mg/kg/회'; }
    else if (patientWeightKg && kind === 'liquid' && official.singleDoseMlPerKg && Number.isFinite(patientWeightKg)) { range = official.singleDoseMlPerKg; actual = doseCalc.round1(ocr.doseAmount / patientWeightKg); unit = 'mL/kg/회'; }
    else if (kind === 'pill' && official.singleDoseTablets && Number.isFinite(ocr.doseAmount)) { range = official.singleDoseTablets; actual = ocr.doseAmount; unit = '정/회'; }
    else if (kind === 'liquid' && official.singleDoseMl && official.ageBandCount <= 1 && Number.isFinite(ocr.doseAmount)) { range = official.singleDoseMl; actual = ocr.doseAmount; unit = 'mL/회'; }
    const position = range ? doseCalc.positionInRange(actual, range.min, range.max) : null;
    return { name: p.name, ...p, range, actual, unit, position };
  });
  const anyComparable = comparisons.some(c => c.position);
  const status = anyComparable && official.ageBandCount <= 1 ? 'ok' : (perIngredient.some(p => p.status === 'ok') ? 'partial' : 'insufficient');
  if (status !== 'ok' && !guards.length) guards.push('정확한 용량 비교를 위해 추가 정보가 필요합니다.');
  return { status, ocr, perIngredient, comparisons, official, usageText, guards, sourceLabel: kind === 'liquid' ? 'e약은요 · 식품의약품안전처' : 'e약은요 · 식품의약품안전처', sourceUrl: 'https://www.data.go.kr/data/15075057/openapi.do' };
}
async function processRxNames(names) {
  const added = names.map(value => {
    const row = typeof value === 'string' ? null : value;
    return { id: ++rxGroupSerial, term: row ? row.drugName : value, row,
      candidates: [], chosen: null, ocrDose: null };
  });
  rxGroups.push(...added); renderRxGroups();
  $('#rxStatus').textContent = added.length ? '처방전에서 찾은 약입니다. 각 항목의 공식 후보를 하나씩 선택해주세요.' : '약 이름을 읽지 못했습니다. 다시 촬영하거나 + 약 직접 추가에서 검색해주세요.';
  // Sequential requests keep OCR lookup load bounded. Every row can be corrected independently.
  for (const group of added) { if (!rxGroups.includes(group)) break; await findRxCandidates(group); }
}
$('#rxAdd').onclick = () => openRxSearch();
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
$('#rxClear').onclick = () => {
  cancelRxOCR(); rxGroups.forEach(group => group.request?.abort()); rxGroups = []; rxSelected.clear(); renderRxGroups(); updateRxSelection();
  $('#rxCompareList').replaceChildren(); $('#rxStatus').textContent = '처방전 내용을 지웠습니다.';
};
$('#rxCompare').onclick = () => {
  const list = $('#rxCompareList'); list.replaceChildren();
  const values = [...rxSelected.values()];
  // Fixed common scale, reduced for unusually large official dimensions; no per-item resizing.
  const scale = Math.min(5, 220 / Math.max(1, ...values.map(v => v.item.long || 0)));
  for (const { item, fetchedAt, kind } of values) {
    const button = flowNode('button', item.name); button.type = 'button';
    // A selected prescription item can be a liquid (kind decided once, at selection time, by
    // isOralLiquidCandidate - never re-guessed here). This card must never send it into the pill 3D
    // view just because it also has an item.id - that was the exact bug reported in item 1/2.
    if (kind === 'liquid') button.append(flowNode('small', `${item.company || '제조사 미제공'} · 액상 · ${item.permit?.data?.packaging || '포장단위 미제공'}`));
    else {
      button.append(flowNode('small', `${item.company || '제조사 미제공'} · ${medicineSize(item)}`), flowNode('small', `${item.shape || '모양 미제공'} · ${item.form || '제형 미제공'}`));
      if (item.long > 0 && item.short > 0) {
        const silhouette = flowNode('span', '', 'rx-silhouette'); silhouette.style.width = item.long * scale + 'px'; silhouette.style.height = item.short * scale + 'px';
        if (item.shape === '장방형') silhouette.style.borderRadius = '999px';
        button.append(silhouette);
      }
    }
    button.append(flowNode('small', kind === 'liquid' ? '포장 정보 확인 →' : '개별 3D 실물크기 확인 →'));
    button.onclick = () => { if (kind === 'liquid') { showScreen('liquid'); $('#liquidWaySearch').click(); selectLiquid(item); } else { showScreen('pill'); selectMedicine(item, button, fetchedAt); } };
    list.append(button);
  }
  $('#rxComparison').hidden = false; $('#rxComparison').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

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
// The 제품 허가정보 endpoint has no structured dosage-form field (see docs/mfds-api.md) - only the
// item name and free-text 성상(CHART, exposed here as item.description). A narrow name-substring
// list (원래: 시럽|현탁액|내복액|내용액|경구용액|경구액) missed a whole class of real oral liquids whose
// name just ends in "액" with no other marker - e.g. 알지에스액/알지셀액/알지드액 (알긴산나트륨 제제,
// packaged 20mL/포 등), whose CHART text says "...점성이 있는 액제" but whose NAME matched none of those
// six words. 액제/시럽제/현탁제/유제/엘릭서 close that gap. The exclusion list is broadened to match:
// non-oral forms also commonly end in "액" (주사액/외용액/점안액/점이액/점비액/가글액/관장액/흡입액/세정액),
// so recall and precision both depend on keeping this list current - see resolveContainerType() for
// the separate, later step that decides pouch vs bottle vs "ask the user" once a product is chosen.
const ORAL_LIQUID_INCLUDE = /시럽|시럽제|현탁액|현탁제|내복액|내용액|경구용액|경구액|액제|유제|엘릭서/;
const ORAL_LIQUID_EXCLUDE = /주사|외용|점안|점이|점비|가글|건조|분말|관장|흡입|세정|소독|도포|첩부|패치|겔|크림|연고|스프레이|분무|좌제/;
// Single classification used by every entry point (일반 검색/최근 검색/저장된 약/처방전 검색 - see item 1/2
// of the request), not just the rx flow: see renderRevealedResults' liquid branch and #rxCompare's
// kind branch below, which now call this same function instead of assuming 'pill'. Neither the
// 낱알식별(pill) nor 허가정보(permit) API exposes a structured dosage-form code we can trust across
// both datasets (see the comment above - the permit API has none at all, and 정제/pill entries occasionally
// leave item.form blank too), so name + CHART(성상) text stays the one signal used everywhere.
function isOralLiquidCandidate(item) {
  return ORAL_LIQUID_INCLUDE.test(item.name + ' ' + item.description) && !ORAL_LIQUID_EXCLUDE.test(item.name);
}
let liquidRequest, liquidTerm = '', liquidPage = 1, fraction = .5, fractionLabel = '1/2';
async function searchLiquids(page = 1) {
  liquidRequest?.abort(); const request = liquidRequest = new AbortController();
  $('#liquidStatus').textContent = '공식 허가정보에서 검색 중…'; $('#liquidResults').replaceChildren(); $('#liquidMore').hidden = true;
  $('#liquidGuide').hidden = true; $('#containerTypeChoice').hidden = true; $('#bottleNotice').hidden = true; $('#bottleCalculator').hidden = true;
  resetLiquidPhoto();
  try {
    const data = await flowSearch('/api/liquids', liquidTerm, request.signal, page); if (request.signal.aborted) return;
    liquidPage = page;
    // Permit search also includes non-oral products; only explicit oral-liquid forms are offered.
    const items = data.items.filter(isOralLiquidCandidate);
    $('#liquidStatus').textContent = items.length ? '제품명·제조사·포장단위를 확인하고 선택하세요.' : '이 페이지에 확인 가능한 액체약이 없습니다. 시럽·내복액 등 정확한 제품명으로 검색해주세요.';
    for (const item of items) {
      const button = flowNode('button', item.name); button.type = 'button';
      button.append(flowNode('small', item.company || '제조사 미제공'), flowNode('small', `공식 포장단위: ${item.permit?.data?.packaging || '미제공'}`));
      const flavor = buildFlavorInfo(item); if (flavor) button.append(flowNode('small', `맛/향: ${flavor.labels.join(', ')}`));
      button.onclick = () => selectLiquid(item);
      const row = document.createElement('div'); row.className = 'save-row';
      row.append(button, makeSaveButton(item, 'liquid')); $('#liquidResults').append(row);
    }
    syncSaveButtons();
    $('#liquidMore').hidden = page * data.pageSize >= data.total || page >= 100;
  } catch (error) { if (!request.signal.aborted) $('#liquidStatus').textContent = error instanceof TypeError ? '네트워크 연결을 확인해주세요.' : error.message; }
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
  const byPackaging = classifyContainerType(packaging);
  if (byPackaging !== 'unknown') return byPackaging;
  const hasBottle = /병|보틀/.test(packaging);
  const extra = `${item.permit?.data?.description || ''} ${item.permit?.data?.materials || ''} ${item.description || ''}`;
  if (!hasBottle && /알루미늄\s*호일|호일\s*포장|스틱\s*포장|파우치/.test(extra)) return 'pouch';
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
  liquidSelectedItem = item; bottlePhotoRequest?.abort();
  $('#liquidName').textContent = item.name; $('#liquidCompany').textContent = item.company || '제조사 미제공';
  const flavor = buildFlavorInfo(item);
  $('#liquidFlavor').hidden = !flavor;
  $('#liquidFlavor').textContent = flavor ? `맛/향: ${flavor.labels.join(', ')} · 출처: ${flavor.sourceType} (${flavor.sourceText})` : '';
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
  $('#bottleManualMl').value = '';
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
let bottleFraction = .5, bottleFractionLabel = '1/2';
function renderBottleCalculator() {
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

let liquidImageRequest, liquidImageItem = null, liquidPhotoReady = false, usingFallbackShape = false;
const DEFAULT_USABLE = { top: 6, bottom: 94 };
let usableRegion = { ...DEFAULT_USABLE };
// The pixel-analysis module is dynamically imported (same pattern as the 3D model, see above) so a
// browser/test environment without it just skips auto-detection instead of failing to load.
let pouchCropModule = null;
import('./pouch-crop.js').then(m => { pouchCropModule = m; }).catch(() => {});
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
  liquidImageRequest?.abort(); liquidPhotoReady = false; usingFallbackShape = false;
  const photo = $('#liquidProductPhoto'); photo.onload = photo.onerror = null; photo.removeAttribute('src'); photo.hidden = true;
  $('#liquidFallback').hidden = true; $('#liquidPhotoStage').hidden = true; $('#photoFractionLine').hidden = true;
  $('#usableTopGuide').hidden = true; $('#usableBottomGuide').hidden = true; $('#liquidPhotoZoom').hidden = true;
  $('#usableAdjustment').hidden = true; $('#liquidImageRetry').hidden = true; $('#liquidImageSource').textContent = '';
  $('#liquidUploadOwnPrompt').hidden = true; $('#liquidOwnCamera').value = ''; $('#liquidOwnFile').value = '';
  usableRegion = { ...DEFAULT_USABLE };
}
function showFallbackSchematic(message) {
  liquidPhotoReady = false; usingFallbackShape = true;
  $('#liquidPhotoStage').hidden = false; $('#liquidFallback').hidden = false; $('#liquidProductPhoto').hidden = true;
  $('#liquidImageStatus').textContent = message; $('#usableAdjustment').hidden = true; $('#liquidPhotoZoom').hidden = true;
  // No official photo exists at all - offer to use the user's own photo of the same product
  // instead of leaving them with only the generic schematic (only meaningful for pouch/stick
  // products, since that is the only case this whole screen is reachable from).
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
    if (data.status === 'not_found') { showFallbackSchematic('공식 포장 사진이 없어 참고용 도형을 표시합니다.'); return; }
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
    liquidPhotoReady = true; usingFallbackShape = false;
    $('#liquidImageStatus').textContent = auto ? '공식 사진에서 자동으로 찾은 포장 용기 영역입니다.' : '지정된 포장 용기 영역입니다.';
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
  liquidPhotoReady = true; usingFallbackShape = false;
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
  // or usingFallbackShape happen to be - see currentContainerType's definition above.
  if (currentContainerType !== 'pouch') {
    $('#photoFractionLine').hidden = true; $('#usableTopGuide').hidden = true; $('#usableBottomGuide').hidden = true; return;
  }
  const ready = liquidPhotoReady || usingFallbackShape;
  const region = usingFallbackShape ? { top: 10, bottom: 90 } : usableRegion;
  const line = $('#photoFractionLine');
  line.hidden = !ready || $('#liquidPhotoStage').hidden;
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
