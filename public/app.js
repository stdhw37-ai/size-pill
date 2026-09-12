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
const root = document.documentElement, longEl = $('#long'), shortEl = $('#short'), thickEl = $('#thick'), pill = $('#pill'), measure = $('#measure');
let shape = 'oval', view = 'front', selected = null, query = {}, page = 1, controller;
const readCal = () => { try { return JSON.parse(localStorage.getItem('pillCalV2')); } catch { return null; } };
let calibration = readCal();
const validCal = value => value && Number.isFinite(value.scale) && value.scale >= .5 && value.scale <= 1.5;
if (!validCal(calibration)) calibration = null;
function applyCal(value) {
  root.style.setProperty('--ppmm', 3.7795275591 * value);
  const zoom = window.visualViewport?.scale || 1;
  const valid = calibration && calibration.dpr === window.devicePixelRatio && Math.abs(zoom - 1) < .01;
  $('#status').textContent = valid ? '화면 보정 적용 중' : '화면 보정 필요';
}
function number(el) { const n = Number(el.value); return el.value.trim() && Number.isFinite(n) && n > 0 && n <= 100 ? n : null; }
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

  function updateNote(hasDims) {
    if (!hasDims) { $('#model3dNote').textContent = '치수 정보가 없어 형태를 정확히 표시할 수 없습니다. 예시 비율로 표시합니다.'; return; }
    const subject = selected ? '공개 치수·색상·형태를 그대로 반영한 3D 모형입니다.' : '직접 입력 예시 · 특정 의약품의 형태가 아닙니다.';
    const mode = sizeMode === 'fit'
      ? '확대 보기 · 크기 비교용이 아닌 형태·두께 관찰용입니다.'
      : '실제 크기 · 2D 실물크기와 같은 화면 보정 기준입니다.';
    $('#model3dNote').textContent = `${subject} ${mode}`;
  }

  function update(l, s, t) {
    hasDims = !!(l && s);
    const long = l || 12, short = s || 6, thick = t || 4;
    const shape3d = classifyShape3D(selected?.shape, shape, `${selected?.description || ''} ${selected?.name || ''}`);
    const geometry = buildTabletGeometry(THREE, { long, short, thick, shape3d });
    geometry.computeBoundingSphere();
    boundingRadius = geometry.boundingSphere.radius;
    const front = colorToCss(selected?.colorFront), back = colorToCss(selected?.colorBack || selected?.colorFront);
    // Matte/semi-matte finish (high roughness, ~0 metalness) so the base color reads clearly instead
    // of a glossy plastic-like specular highlight, and no environment map so specular stays subtle.
    const materialOptions = { roughness: 0.88, metalness: 0 };
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
  const l = number(longEl), s = number(shortEl), t = number(thickEl), b = view === 'front' ? s : t;
  pill.hidden = !(l && b);
  pill.style.setProperty('--long', l || 0); pill.style.setProperty('--short', b || 0);
  pill.className = 'pill ' + (view === 'side' ? 'capsule' : shape);
  pill.querySelector('span').textContent = '';
  measure.replaceChildren();
  for (const [label, value] of view === 'front' ? [['장축', l], ['단축', s]] : [['길이', l], ['두께', t]]) {
    const badge = document.createElement('span'); badge.textContent = label + ' ' + (value ? value + ' mm' : '정보 없음'); measure.append(badge);
  }
  $('#modelNote').textContent = !(l && b) ? '치수 정보가 없어 이 방향의 크기를 표시할 수 없습니다.' : selected ? '공개 치수를 반영한 단순 모형입니다. 색·각인·특수 모양은 재현하지 않습니다.' : '직접 입력 예시 · 특정 의약품의 치수가 아닙니다.';
  three3d?.update(l, s, t);
}
function setManual() {
  selected = null;
  [longEl, shortEl, thickEl].forEach(el => el.readOnly = false);
  document.querySelectorAll('.shape').forEach(el => el.disabled = false);
  document.querySelectorAll('.result').forEach(el => el.setAttribute('aria-pressed', 'false'));
  $('#selection').textContent = '직접 입력 모드 · 확인한 치수를 mm 단위로 입력하세요.';
  $('#medicineDetails').hidden = true;
  render();
}
$('#manual').onclick = setManual;
[longEl, shortEl, thickEl].forEach(el => el.addEventListener('input', render));
document.querySelectorAll('.shape').forEach(button => button.onclick = () => {
  shape = button.dataset.shape;
  document.querySelectorAll('.shape').forEach(el => el.classList.toggle('active', el === button)); render();
});
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => {
  view = button.dataset.view;
  document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el === button)); render();
});
document.querySelectorAll('[data-dim]').forEach(button => button.onclick = () => {
  document.querySelectorAll('[data-dim]').forEach(el => el.classList.toggle('active', el === button));
  const is3d = button.dataset.dim === '3d';
  $('#view2d').hidden = is3d; $('#view3d').hidden = !is3d;
  if (is3d) three3d?.show(); else three3d?.hide();
});
function selectMedicine(item, button, fetchedAt) {
  selected = item;
  [longEl, shortEl, thickEl].forEach((el, i) => { el.value = [item.long, item.short, item.thick][i] ?? ''; el.readOnly = true; });
  shape = item.shape === '원형' ? 'round' : item.shape === '장방형' ? 'capsule' : 'oval';
  document.querySelectorAll('.shape').forEach(el => { el.disabled = true; el.classList.toggle('active', el.dataset.shape === shape); });
  document.querySelectorAll('.result').forEach(el => el.setAttribute('aria-pressed', String(el === button)));
  $('#selection').textContent = `${item.name} · ${item.company} · 품목 ${item.id} · 모양 ${item.shape || '미제공'} · 식약처 조회 ${new Date(fetchedAt).toLocaleDateString('ko-KR')}`;
  showIdentity(item);
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
// Only literal, explicit taste/scent words found in official text (성상/CHART) are shown; nothing is
// inferred from color, ingredients, or excipients. Confirmed against real data: e.g. 센트룸키즈츄어블정's
// CHART is "레몬향이나는 밝은 회색의 원형 츄어블정제" - genuine flavor wording does occur in this field.
const FLAVOR_EXCLUDE = new Set(['방향', '방향족', '방향성', '방향제', '경향', '영향', '동향', '상향', '하향', '일방향', '양방향', '무향', '무취']);
function extractFlavor(...texts) {
  const taste = new Set(), scent = new Set();
  for (const raw of texts) {
    for (const match of String(raw ?? '').matchAll(/[가-힣]{1,6}(?:맛|향)/g)) {
      const word = match[0];
      if (FLAVOR_EXCLUDE.has(word)) continue;
      (word.endsWith('맛') ? taste : scent).add(word);
    }
  }
  return { taste: [...taste], scent: [...scent] };
}
function showIdentity(item) {
  $('#medicineDetails').hidden = false;
  $('#medicineImage').replaceChildren(productImage(item.imageUrl, `${item.name} 제품 사진`));
  const mm = key => item[key] ? `${item[key]} mm` : item.dimensionsRaw?.[key] ? `${item.dimensionsRaw[key]} (원문 · 정확한 크기로 표시 불가)` : '미제공';
  const sizeSummary = $('#sizeSummary');
  if (item.long && item.short && item.thick) {
    sizeSummary.hidden = false;
    sizeSummary.replaceChildren();
    const value = document.createElement('strong'); value.textContent = `${item.long} × ${item.short} × ${item.thick} mm`;
    const caption = document.createElement('small'); caption.textContent = '장축 × 단축 × 두께';
    sizeSummary.append(value, caption);
  } else {
    sizeSummary.hidden = true;
  }
  const rows = [
    ['모양', item.shape], ['색상 (앞 / 뒤)', `${item.colorFront || '미제공'} / ${item.colorBack || '미제공'}`],
    ['앞면 식별표시', item.printFront], ['뒷면 식별표시', item.printBack],
    ['분할선 (앞 / 뒤)', `${item.lineFront || '미제공'} / ${item.lineBack || '미제공'}`],
    ['장축 / 단축', `${mm('long')} / ${mm('short')}`], ['두께', mm('thick')],
    ['제형', item.form], ['성상', item.description]
  ];
  const { taste, scent } = extractFlavor(item.description, item.permit?.data?.description);
  if (taste.length && scent.length) rows.push(['맛', taste.join(', ')], ['향', scent.join(', ')]);
  else if (taste.length || scent.length) rows.push(['맛/향', [...taste, ...scent].join(', ')]);
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
async function search(nextPage = 1) {
  controller?.abort(); controller = new AbortController(); const current = controller;
  $('#searchStatus').textContent = '의약품 정보를 찾고 있습니다…';
  $('#results').replaceChildren(); $('#pagination').hidden = true;
  try {
    const response = await fetch(API_BASE + '/api/medicines?' + new URLSearchParams({ ...query, pageNo: nextPage, numOfRows: 20 }), { signal: current.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '검색에 실패했습니다.');
    if (current !== controller) return;
    page = data.page;
    $('#searchStatus').textContent = data.total ? `총 ${data.total}개 제품 · 제조사와 함량을 확인해주세요.` : '검색 결과가 없습니다. 제품명을 확인하거나 치수를 직접 입력해주세요.';
    for (const item of data.items) {
      const button = document.createElement('button'); button.className = 'result'; button.type = 'button'; button.setAttribute('aria-pressed', String(selected?.id === item.id));
      const title = document.createElement('b'); title.textContent = item.name;
      const company = document.createElement('small'); company.className = 'r-meta'; company.textContent = item.company || '제조사 미제공';
      const identity = document.createElement('small'); identity.className = 'r-meta';
      identity.textContent = `품목 ${item.id} · ${item.shape || '모양 미제공'} · ${item.colorFront || '색상 미제공'}${item.colorBack ? ' / ' + item.colorBack : ''}`;
      const dims = document.createElement('small'); dims.className = 'r-meta';
      dims.textContent = item.long && item.short ? `장축 × 단축 · ${item.long} × ${item.short} mm` : '치수 정보 부족';
      const copy = document.createElement('span'); copy.className = 'result-copy'; copy.append(title, company, identity, dims);
      if (safeImage(item.imageUrl)) button.append(productImage(item.imageUrl, '', 'result-photo'));
      button.append(copy); button.onclick = () => selectMedicine(item, button, data.fetchedAt); $('#results').append(button);
    }
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
  document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{document.querySelectorAll('[data-mode]').forEach(x=>x.classList.remove('active'));b.classList.add('active');const liquid=b.dataset.mode==='liquid';document.querySelector('#pillTool').classList.toggle('hidden',liquid);document.querySelector('#liquidTool').classList.toggle('active',liquid)});
  const level=document.querySelector('#levelRange'),maxMl=document.querySelector('#maxMl'),cupShape=document.querySelector('#cupShape');
  function liquidRender(){const p=Number(level.value)/100,m=Math.max(0,Number(maxMl.value)||0);const ratio=cupShape.value==='taper'?(.45*p+.55*p*p):p;const ml=Math.round(m*ratio*10)/10;document.querySelector('#currentMl').value=ml;document.querySelector('#volumeText').textContent=ml+' mL';document.querySelector('#levelPercent').textContent=level.value+'%';document.querySelector('#levelLine').style.bottom=level.value+'%'}
  [level,maxMl,cupShape].forEach(x=>x.addEventListener('input',liquidRender));liquidRender();
  document.querySelector('#startCamera').onclick=async()=>{const err=document.querySelector('#cameraError');try{const stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});const v=document.querySelector('#camera');v.srcObject=stream;await v.play();document.querySelector('#cameraWrap').classList.add('live')}catch(e){err.textContent='카메라 권한을 확인해주세요. HTTPS 환경에서만 사용할 수 있습니다.'}};

const APP_VERSION = 'v1.0.0';
document.querySelectorAll('#appVersion, #appVersionFooter').forEach(el => el.textContent = APP_VERSION);
// Placeholder pages - replace with real, published policy/terms URLs before release.
for (const [id, label] of [['privacyLink', '개인정보처리방침'], ['termsLink', '이용약관']]) {
  const link = $('#' + id);
  if (link) link.onclick = event => { event.preventDefault(); alert(`${label} 페이지를 준비 중입니다.`); };
}
