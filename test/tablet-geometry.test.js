import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildTabletGeometry, classifyShape3D, paintCapsuleColors } from '../public/tablet-geometry.js';

function bboxSize(geometry) {
  geometry.computeBoundingBox();
  const b = geometry.boundingBox;
  return { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z };
}
const ratioClose = (a, b, tolerance = 0.03) => Math.abs(a / b - 1) < tolerance;

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
});

test('장방형 정제: geometry bounding box가 장축(19.2) : 단축(7.1) : 두께(7.1) 비율을 정확히 반영한다', () => {
  const long = 19.2, short = 7.1, thick = 7.1;
  const geo = buildTabletGeometry(THREE, { long, short, thick, shape3d: 'oblong' });
  const size = bboxSize(geo);
  assert.ok(ratioClose(size.x, long), `x=${size.x}, expected ~${long}`);
  assert.ok(ratioClose(size.y, short), `y=${size.y}, expected ~${short}`);
  assert.ok(ratioClose(size.z, thick), `z=${size.z}, expected ~${thick}`);
  assert.ok(ratioClose(size.x / size.y, long / short), 'X:Y ratio must match long:short');
});

test('두께가 큰 정제: 두께가 장축의 절반에 가까워도 Z가 임의로 얇아지지 않는다', () => {
  const long = 12, short = 9, thick = 8;
  const geo = buildTabletGeometry(THREE, { long, short, thick, shape3d: 'oval' });
  const size = bboxSize(geo);
  assert.ok(ratioClose(size.z, thick), `expected thick z=${thick}, got ${size.z}`);
  assert.ok(ratioClose(size.z / size.x, thick / long), 'Z:X ratio must match thick:long, not be flattened');
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
});

test('사각형: 모서리가 둥글더라도 bounding box는 장축·단축 비율을 유지한다', () => {
  const long = 11, short = 9, thick = 4.5;
  const geo = buildTabletGeometry(THREE, { long, short, thick, shape3d: 'square' });
  const size = bboxSize(geo);
  assert.ok(ratioClose(size.x, long) && ratioClose(size.y, short) && ratioClose(size.z, thick));
});
