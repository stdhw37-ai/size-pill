import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildTabletGeometry, classifyShape3D, paintCapsuleColors, colorToCss, COLOR_MAP } from '../public/tablet-geometry.js';

function bboxSize(geometry) {
  geometry.computeBoundingBox();
  const b = geometry.boundingBox;
  return { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z };
}
const ratioClose = (a, b, tolerance = 0.03) => Math.abs(a / b - 1) < tolerance;

// Bounding-box ratio checks alone don't catch a hollow shape (a ring's bbox is identical to a
// solid disc's) - that's exactly how the round-tablet LatheGeometry shipped as a hollow tube with
// open caps while every bbox test kept passing. A straight ray through the model's own center,
// perpendicular to its flattest axis (thickness), must enter through one face and exit through the
// opposite one - any hollow tube/ring, or a geometry missing a front or back cap, fails this.
function assertSolidThroughCenter(geometry, expectedThickness, tolerance = 0.15) {
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const raycaster = new THREE.Raycaster();
  // A tiny, deliberately non-axis-aligned offset (not 0, not a round number like 0.05/0.1): a ray
  // passing exactly through the origin or along an axis can graze the exact shared edge between two
  // of the lofted dome's triangles (the apex fan, or a ring seam that lands on a sampled angle like
  // 0°/45°/90°), which THREE's raycaster can double-count as two grazing hits on a perfectly solid
  // mesh - confirmed by probing many nearby offsets, where only the axis-aligned ones ever do this.
  raycaster.set(new THREE.Vector3(0.037, 0.081, 1000), new THREE.Vector3(0, 0, -1));
  const hits = raycaster.intersectObject(mesh);
  assert.equal(hits.length, 2, `a ray through the model's center must hit a front cap and a back cap (got ${hits.length} intersections - a hollow/open geometry hits 0)`);
  const gap = Math.abs(hits[0].distance - hits[1].distance);
  assert.ok(ratioClose(gap, expectedThickness, tolerance), `front/back cap separation should be ~${expectedThickness}mm, got ${gap}`);
}

test('classifyShape3D reads the official DRUG_SHAPE text, falling back to the coarse 2D bucket', () => {
  assert.equal(classifyShape3D('원형', 'oval'), 'round');
  assert.equal(classifyShape3D('타원형', 'oval'), 'oval');
  assert.equal(classifyShape3D('장방형', 'capsule'), 'oblong');
  assert.equal(classifyShape3D('사각형', 'oval'), 'square');
  assert.equal(classifyShape3D('캡슐형', 'oval'), 'capsule');
  assert.equal(classifyShape3D('', 'round'), 'round');
  assert.equal(classifyShape3D('', 'capsule'), 'oblong');
  assert.equal(classifyShape3D('', 'oval'), 'oval');
});

test('원형 정제: geometry bounding box의 X:Y:Z 비율이 장축:단축:두께와 일치한다', () => {
  const geo = buildTabletGeometry(THREE, { long: 10, short: 10, thick: 4, shape3d: 'round' });
  const size = bboxSize(geo);
  assert.ok(ratioClose(size.x, 10), `x=${size.x}`);
  assert.ok(ratioClose(size.y, 10), `y=${size.y}`);
  assert.ok(ratioClose(size.z, 4), `z=${size.z}`);
  assert.ok(ratioClose(size.x, size.y), 'round must have equal X/Y');
  assertSolidThroughCenter(geo, 4);
});

test('장방형 정제: geometry bounding box가 장축(19.2) : 단축(7.1) : 두께(7.1) 비율을 정확히 반영한다', () => {
  const long = 19.2, short = 7.1, thick = 7.1;
  const geo = buildTabletGeometry(THREE, { long, short, thick, shape3d: 'oblong' });
  const size = bboxSize(geo);
  assert.ok(ratioClose(size.x, long), `x=${size.x}, expected ~${long}`);
  assert.ok(ratioClose(size.y, short), `y=${size.y}, expected ~${short}`);
  assert.ok(ratioClose(size.z, thick), `z=${size.z}, expected ~${thick}`);
  assert.ok(ratioClose(size.x / size.y, long / short), 'X:Y ratio must match long:short');
  assertSolidThroughCenter(geo, thick);
});

test('두께가 큰 정제: 두께가 장축의 절반에 가까워도 Z가 임의로 얇아지지 않는다', () => {
  const long = 12, short = 9, thick = 8;
  const geo = buildTabletGeometry(THREE, { long, short, thick, shape3d: 'oval' });
  const size = bboxSize(geo);
  assert.ok(ratioClose(size.z, thick), `expected thick z=${thick}, got ${size.z}`);
  assert.ok(ratioClose(size.z / size.x, thick / long), 'Z:X ratio must match thick:long, not be flattened');
  assertSolidThroughCenter(geo, thick);
});

test('얇은 필름코팅정: 두께가 작아도(2mm) geometry에 실제 Z 깊이가 그대로 존재한다', () => {
  const long = 17.6, short = 7.1, thick = 2;
  const geo = buildTabletGeometry(THREE, { long, short, thick, shape3d: 'oval' });
  const size = bboxSize(geo);
  assert.ok(ratioClose(size.z, thick, 0.08), `expected thick z~${thick}, got ${size.z}`);
  assert.ok(size.z > 0.5, 'thickness must not collapse toward a flat plane');
  assert.ok(ratioClose(size.x, long) && ratioClose(size.y, short));
});

test('캡슐형: 장축·단축 비율을 반영하고, 정점 색상이 장축 중앙을 기준으로 좌우 두 가지 색으로 나뉜다', () => {
  const long = 19, short = 7, thick = 6;
  const geo = buildTabletGeometry(THREE, { long, short, thick, shape3d: 'capsule' });
  const size = bboxSize(geo);
  assert.ok(ratioClose(size.x, long) && ratioClose(size.y, short) && ratioClose(size.z, thick));
  assertSolidThroughCenter(geo, thick);
  paintCapsuleColors(THREE, geo, '#ffffff', '#ffe066');
  const colors = geo.attributes.color, position = geo.attributes.position;
  geo.computeBoundingBox();
  const midX = (geo.boundingBox.min.x + geo.boundingBox.max.x) / 2;
  const front = new THREE.Color('#ffffff'), back = new THREE.Color('#ffe066');
  const closeTo = (a, b) => Math.abs(a - b) < 0.01;
  let sawFront = false, sawBack = false;
  for (let i = 0; i < position.count; i++) {
    const isLeft = position.getX(i) < midX;
    const r = colors.getX(i), g = colors.getY(i), b = colors.getZ(i);
    if (isLeft && closeTo(r, front.r) && closeTo(g, front.g) && closeTo(b, front.b)) sawFront = true;
    if (!isLeft && closeTo(r, back.r) && closeTo(g, back.g) && closeTo(b, back.b)) sawBack = true;
  }
  assert.ok(sawFront, 'left half should be painted with the front color');
  assert.ok(sawBack, 'right half should be painted with the back color');
});

test('실제 API 예시(19.2 x 7.8 x 7.1mm): 두께가 CSS가 아닌 geometry Z축 실치수로 반영된다', () => {
  const long = 19.2, short = 7.8, thick = 7.1;
  const geo = buildTabletGeometry(THREE, { long, short, thick, shape3d: 'oblong' });
  const size = bboxSize(geo);
  assert.ok(ratioClose(size.x, long), `x=${size.x}, expected ~${long}`);
  assert.ok(ratioClose(size.y, short), `y=${size.y}, expected ~${short}`);
  assert.ok(ratioClose(size.z, thick), `z=${size.z}, expected ~${thick}`);
  assert.ok(ratioClose(size.x / size.y / (long / short), 1), 'X:Y ratio must match long:short');
  assert.ok(ratioClose(size.x / size.z / (long / thick), 1), 'X:Z ratio must match long:thick (thickness not flattened)');
  assert.ok(ratioClose(size.y / size.z / (short / thick), 1), 'Y:Z ratio must match short:thick (thickness not flattened)');
  assertSolidThroughCenter(geo, thick);
});

test('사각형: 모서리가 둥글더라도 bounding box는 장축·단축 비율을 유지한다', () => {
  const long = 11, short = 9, thick = 4.5;
  const geo = buildTabletGeometry(THREE, { long, short, thick, shape3d: 'square' });
  const size = bboxSize(geo);
  assert.ok(ratioClose(size.x, long) && ratioClose(size.y, short) && ratioClose(size.z, thick));
  assertSolidThroughCenter(geo, thick);
});

// Regression guard for a real rendering bug: the round tablet's LatheGeometry revolved a profile
// whose radius never reached 0, producing a hollow tube (open front/back) that looked like a thin
// ring on screen ("테두리만 보이고 색상이 안 보임") while every bbox-ratio test above still passed,
// because a ring's bounding box is identical to a solid disc's. Caught only by loading the running
// app in a real (headless) browser and screenshotting the 3D canvas - not by bbox math alone.
test('원형 정제는 (버그였던) 속이 빈 고리가 아니라 중심까지 꽉 찬 solid geometry다', () => {
  const geo = buildTabletGeometry(THREE, { long: 7, short: 7, thick: 2.5, shape3d: 'round' });
  assertSolidThroughCenter(geo, 2.5);
});

test('classifyShape3D: 실제 DRUG_SHAPE는 캡슐도 "장방형"으로만 표기하므로, CHART/제품명의 캡슐·캅셀 텍스트로 판별한다', () => {
  // Real getMdcinGrnIdntfcInfoList03 pattern: 모빅캡슐15밀리그램(멜록시캄), DRUG_SHAPE="장방형".
  assert.equal(
    classifyShape3D('장방형', 'oval', '노란색 가루가 든 상부 밝은 초록색, 하부 노란색 캡슐 모빅캡슐15밀리그램(멜록시캄)'),
    'capsule'
  );
  // Older CHART spelling "캅셀" (e.g. 아주오메프라졸캡슐's own CHART text) must also match.
  assert.equal(classifyShape3D('장방형', 'oval', '경질캅셀'), 'capsule');
  // A plain oblong tablet with no capsule wording anywhere must NOT be misclassified.
  assert.equal(classifyShape3D('장방형', 'oval', '흰색의 장방형 필름코팅정제'), 'oblong');
});

test('colorToCss: COLOR_CLASS1/2에 쉼표로 붙는 실제 수식어/2색 표기를 첫 유효 색상 토큰으로 해석한다', () => {
  // Real observed values: base color + "투명" (capsule shell), + "옅은"/"진한" (shade), or two colors.
  assert.equal(colorToCss('주황, 투명'), COLOR_MAP['주황']);
  assert.equal(colorToCss('노랑, 옅은'), COLOR_MAP['노랑']);
  assert.equal(colorToCss('하양, 빨강'), COLOR_MAP['하양']);
  assert.equal(colorToCss('노랑'), COLOR_MAP['노랑']);
  assert.equal(colorToCss(''), '#eef2f0');
  assert.equal(colorToCss(null), '#eef2f0');
  assert.equal(colorToCss('이런색은없음'), '#eef2f0');
});

// Real DRUG_SHAPE values confirmed by scanning ~400 live 낱알식별 search results: 원형/장방형/타원형/
// 팔각형/오각형/삼각형/사각형/기타 all actually occur (마름모형/육각형 are in the same official
// vocabulary and mapped the same generalized way, though they didn't turn up in that particular
// sample). classifyShape3D must route every one of these to a distinct shape3d key.
test('classifyShape3D: 다각형 DRUG_SHAPE(마름모형·오각형·육각형·팔각형)을 각각 구분해서 분류한다', () => {
  assert.equal(classifyShape3D('마름모형', 'oval'), 'rhombus');
  assert.equal(classifyShape3D('오각형', 'oval'), 'pentagon');
  assert.equal(classifyShape3D('육각형', 'oval'), 'hexagon');
  assert.equal(classifyShape3D('팔각형', 'oval'), 'octagon');
  assert.equal(classifyShape3D('삼각형', 'oval'), 'triangle');
  // "기타" (e.g. a real 곰얼굴/bear-face novelty 츄어블정) has no dedicated geometry - it must fall
  // back to the closest basic 2D shape rather than silently matching some other polygon by accident.
  assert.equal(classifyShape3D('기타', 'round'), 'round');
});

// buildTabletGeometry's polygon branch must (a) hit each requested real long/short/thick exactly -
// filleting a polygon's corners pulls the vertex itself inward (unlike a rounded rect, where the
// flat edges between corners still reach the full width), so this specifically guards the
// corrective rescale in roundedPolygonExact() - and (b) still be a solid, not a shell.
for (const [shape3d, label, long, short, thick] of [
  ['triangle', '삼각형 (실측: 프로코라란정7.5밀리그램)', 7, 5, 3.1],
  ['rhombus', '마름모형', 10, 6, 4],
  ['pentagon', '오각형 (실측: 로큅정0.25밀리그램)', 8.1, 8.1, 3.8],
  ['hexagon', '육각형', 10, 7, 4],
  ['octagon', '팔각형 (실측: 바로디핀정5밀리그램)', 8.7, 6.2, 3.8]
]) {
  test(`${label}: bounding box가 장축:단축:두께(${long}:${short}:${thick})를 정확히 유지하는 solid geometry다`, () => {
    const geo = buildTabletGeometry(THREE, { long, short, thick, shape3d });
    const size = bboxSize(geo);
    assert.ok(ratioClose(size.x, long), `x=${size.x}, expected ~${long}`);
    assert.ok(ratioClose(size.y, short), `y=${size.y}, expected ~${short}`);
    assert.ok(ratioClose(size.z, thick), `z=${size.z}, expected ~${thick}`);
    assertSolidThroughCenter(geo, thick);
  });
}

// The 5 shapes above (round/oblong already covered earlier in this file, plus triangle/pentagon/
// octagon here) must not silently collapse to the same geometry - a regression that swapped one
// polygon's vertex count for another would still pass every bbox check individually.
test('원형·장방형·삼각형·오각형·팔각형은 서로 다른 정점 개수의 geometry를 생성한다(같은 모양으로 겹치지 않는다)', () => {
  const base = { long: 10, short: 8, thick: 4 };
  const counts = ['round', 'oblong', 'triangle', 'pentagon', 'octagon'].map(shape3d => {
    const geo = buildTabletGeometry(THREE, { ...base, shape3d });
    geo.computeBoundingBox();
    return geo.attributes.position.count;
  });
  assert.equal(new Set(counts).size, counts.length, `각 shape3d는 서로 다른 정점 수를 가져야 한다: ${JSON.stringify(counts)}`);
});
