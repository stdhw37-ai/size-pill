const $ = selector => document.querySelector(selector);
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
// Approximate CSS colors for the official 식약처 color-class names; unknown/blank falls back to a neutral tablet tone.
const COLOR_MAP = { 하양: '#ffffff', 흰색: '#ffffff', 노랑: '#ffe066', 노란색: '#ffe066', 주황: '#ff9f43', 분홍: '#f8b8c6', 빨강: '#e6544a', 빨간색: '#e6544a', 갈색: '#8a5a3c', 연두: '#c3e07a', 초록: '#4caf7d', 녹색: '#4caf7d', 청록: '#3fb8af', 파랑: '#4a7fe6', 파란색: '#4a7fe6', 남색: '#33418f', 자주: '#a54a8f', 보라: '#8a63c9', 회색: '#b7bfba', 검정: '#33383a', 검은색: '#33383a', 투명: '#eef2f0' };
function colorToCss(name) { return COLOR_MAP[String(name ?? '').trim()] || '#eef2f0'; }
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
function setupThree3D(THREE, OrbitControls, { buildTabletGeometry, classifyShape3D, paintCapsuleColors }) {
  const container = $('#scene3d');
  const FOV = 32;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 3.6);
  key.castShadow = true; key.shadow.mapSize.set(1024, 1024);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 1.4);
  scene.add(fill);
  const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.25 }));
  shadowPlane.receiveShadow = true;
  scene.add(shadowPlane);

  let mesh = null;
  let zoomFactor = 1; // 1 = real size, >1 = magnified view (never changes geometry, only camera distance)

  function currentPpmm() { return parseFloat(root.style.getPropertyValue('--ppmm')) || 3.7795275591; }
  // Solve the camera distance so that, at the object's depth, 1mm maps to exactly `ppmm` CSS pixels -
  // the same real-size basis the 2D model uses, shared via the same --ppmm value.
  function realSizeDistance() {
    const heightPx = Math.max(1, container.clientHeight);
    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    return heightPx / (2 * currentPpmm() * zoomFactor * Math.tan(fovRad / 2));
  }
  function applyDistance() {
    const distance = realSizeDistance();
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

  function update(l, s, t) {
    $('#model3dNote').textContent = !(l && s) ? '치수 정보가 없어 형태를 정확히 표시할 수 없습니다. 예시 비율로 표시합니다.' : selected ? '공개 치수·색상·형태를 그대로 반영한 실제 크기 3D 모형입니다.' : '직접 입력 예시 · 특정 의약품의 형태가 아닙니다.';
    const long = l || 12, short = s || 6, thick = t || 4;
    const shape3d = classifyShape3D(selected?.shape, shape);
    const geometry = buildTabletGeometry(THREE, { long, short, thick, shape3d });
    const front = colorToCss(selected?.colorFront), back = colorToCss(selected?.colorBack || selected?.colorFront);
    let material;
    if (shape3d === 'capsule') {
      paintCapsuleColors(THREE, geometry, front, back);
      material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.04 });
    } else {
      material = new THREE.MeshStandardMaterial({ color: new THREE.Color(front), roughness: 0.55, metalness: 0.04 });
    }
    if (mesh) { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
    mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    scene.add(mesh);

    const radius = Math.max(long, short, thick) * 0.6;
    key.position.set(radius * 0.9, radius * 1.4, radius * 1.7);
    key.shadow.camera.near = 0.1; key.shadow.camera.far = radius * 10;
    key.shadow.camera.left = -radius * 2; key.shadow.camera.right = radius * 2;
    key.shadow.camera.top = radius * 2; key.shadow.camera.bottom = -radius * 2;
    key.shadow.camera.updateProjectionMatrix();
    fill.position.set(-radius * 1.3, -radius * 0.5, radius * 1.1);
    shadowPlane.position.set(0, -short / 2 - Math.max(0.6, short * 0.1), 0);
    shadowPlane.rotation.set(-Math.PI / 2, 0, 0);
    shadowPlane.scale.setScalar(Math.max(long, short) * 6);

    syncRendererSize();
    applyDistance();
  }

  function setZoom(factor) { zoomFactor = factor; applyDistance(); }

  document.querySelectorAll('[data-zoom]').forEach(button => button.onclick = () => {
    document.querySelectorAll('[data-zoom]').forEach(el => el.classList.toggle('active', el === button));
    setZoom(button.dataset.zoom === '2' ? 2.2 : 1);
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
// Only literal, explicit taste/scent words found in official text are shown; nothing is inferred from color or ingredients.
const FLAVOR_EXCLUDE = new Set(['방향', '방향족', '방향성', '방향제', '경향', '영향', '동향', '상향', '하향', '일방향', '양방향', '무향', '무취']);
function extractFlavor(...texts) {
  const found = new Set();
  for (const raw of texts) {
    for (const match of String(raw ?? '').matchAll(/[가-힣]{1,6}(?:맛|향)/g)) {
      if (!FLAVOR_EXCLUDE.has(match[0])) found.add(match[0]);
    }
  }
  return found.size ? [...found].join(', ') : '';
}
function showIdentity(item) {
  $('#medicineDetails').hidden = false;
  $('#medicineImage').replaceChildren(productImage(item.imageUrl, `${item.name} 제품 사진`));
  const mm = key => item[key] ? `${item[key]} mm` : item.dimensionsRaw?.[key] ? `${item.dimensionsRaw[key]} (원문 · 정확한 크기로 표시 불가)` : '미제공';
  const rows = [
    ['모양', item.shape], ['색상 (앞 / 뒤)', `${item.colorFront || '미제공'} / ${item.colorBack || '미제공'}`],
    ['앞면 식별표시', item.printFront], ['뒷면 식별표시', item.printBack],
    ['분할선 (앞 / 뒤)', `${item.lineFront || '미제공'} / ${item.lineBack || '미제공'}`],
    ['장축 / 단축', `${mm('long')} / ${mm('short')}`], ['두께', mm('thick')],
    ['제형', item.form], ['성상', item.description]
  ];
  const flavor = extractFlavor(item.description, item.permit?.data?.description);
  if (flavor) rows.push(['맛/향', flavor]);
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
    const response = await fetch('/api/medicines?' + new URLSearchParams({ ...query, pageNo: nextPage, numOfRows: 20 }), { signal: current.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '검색에 실패했습니다.');
    if (current !== controller) return;
    page = data.page;
    $('#searchStatus').textContent = data.total ? `총 ${data.total}개 제품 · 제조사와 함량을 확인해주세요.` : '검색 결과가 없습니다. 제품명을 확인하거나 치수를 직접 입력해주세요.';
    for (const item of data.items) {
      const button = document.createElement('button'); button.className = 'result'; button.type = 'button'; button.setAttribute('aria-pressed', String(selected?.id === item.id));
      const title = document.createElement('b'), detail = document.createElement('small'); title.textContent = item.name;
      detail.textContent = `${item.company} · 품목 ${item.id} · ${item.shape || '모양 미제공'} · ${item.colorFront || '색상 미제공'}${item.colorBack ? ' / ' + item.colorBack : ''} · ${item.long && item.short ? item.long + ' × ' + item.short + ' mm' : '치수 정보 부족'}`;
      const copy = document.createElement('span'); copy.className = 'result-copy'; copy.append(title, detail);
      if (safeImage(item.imageUrl)) button.append(productImage(item.imageUrl, '', 'result-photo'));
      button.append(copy); button.onclick = () => selectMedicine(item, button, data.fetchedAt); $('#results').append(button);
    }
    $('#pagination').hidden = data.total <= data.pageSize;
    $('#prevPage').disabled = page <= 1; $('#nextPage').disabled = page * data.pageSize >= data.total || page >= 100;
    $('#pageLabel').textContent = `${page} / ${Math.ceil(data.total / data.pageSize)}`;
  } catch (error) {
    if (current === controller && error.name !== 'AbortError') $('#searchStatus').textContent = error instanceof SyntaxError ? '검색 서버에 연결되지 않았습니다. 앱 서버를 실행해주세요.' : error.message;
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
