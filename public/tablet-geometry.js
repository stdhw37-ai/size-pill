// Pure geometry logic, independent of where THREE is imported from (browser vendor copy vs the
// npm package in tests) - callers inject THREE so this module has no import of its own.

// Finer shape classification for 3D geometry than the 3-bucket 2D shape (round/oval/capsule button row).
export function classifyShape3D(rawShapeText, coarseShape) {
  const raw = String(rawShapeText || '');
  if (raw.includes('캡슐')) return 'capsule';
  if (raw.includes('장방')) return 'oblong';
  if (raw.includes('사각')) return 'square';
  if (raw.includes('타원')) return 'oval';
  if (raw.includes('원형')) return 'round';
  return coarseShape === 'round' ? 'round' : coarseShape === 'capsule' ? 'oblong' : 'oval';
}

function stadiumShape(THREE, halfLength, radius) {
  const shape = new THREE.Shape();
  const straight = Math.max(0, halfLength - radius);
  shape.moveTo(-straight, radius);
  shape.lineTo(straight, radius);
  shape.absarc(straight, 0, radius, Math.PI / 2, -Math.PI / 2, true);
  shape.lineTo(-straight, -radius);
  shape.absarc(-straight, 0, radius, -Math.PI / 2, Math.PI / 2, true);
  shape.closePath();
  return shape;
}

function ellipseShape(THREE, halfX, halfY, segments = 64) {
  const shape = new THREE.Shape();
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const x = Math.cos(a) * halfX, y = Math.sin(a) * halfY;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  return shape;
}

function roundedRectShape(THREE, halfX, halfY, radius) {
  const r = Math.min(radius, halfX, halfY);
  const shape = new THREE.Shape();
  shape.moveTo(-halfX + r, -halfY);
  shape.lineTo(halfX - r, -halfY);
  shape.absarc(halfX - r, -halfY + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(halfX, halfY - r);
  shape.absarc(halfX - r, halfY - r, r, 0, Math.PI / 2, false);
  shape.lineTo(-halfX + r, halfY);
  shape.absarc(-halfX + r, halfY - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-halfX, -halfY + r);
  shape.absarc(-halfX + r, -halfY + r, r, Math.PI, Math.PI * 1.5, false);
  shape.closePath();
  return shape;
}

// Builds tablet geometry with X=long, Y=short, Z=thick as the exact bounding-box dimensions
// (mm units treated 1:1 as world units). Bevel/convexity only rounds edges *within* that box -
// it never changes the long:short:thick ratio of the final bounding box.
export function buildTabletGeometry(THREE, { long, short, thick, shape3d }) {
  const longR = long / 2, shortR = short / 2, halfT = thick / 2;

  if (shape3d === 'round') {
    // A LatheGeometry revolved around Y, then rotated so the revolve (radius) plane is XY
    // and the height axis becomes Z (thickness) - X and Y both end up as the exact diameter.
    const steps = 16;
    const points = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const y = -halfT + t * thick;
      const edge = Math.pow(Math.abs(2 * t - 1), 3); // 0 at the equator, 1 at the extreme top/bottom
      const r = Math.max(shortR * (1 - 0.25 * edge), 0.001);
      points.push(new THREE.Vector2(r, y));
    }
    const geometry = new THREE.LatheGeometry(points, 48);
    geometry.rotateX(Math.PI / 2);
    geometry.computeVertexNormals();
    return geometry;
  }

  const bevelSize = Math.min(shortR * 0.25, 0.6);
  const bevelThickness = Math.min(thick * 0.2, 0.6);
  const depth = Math.max(thick - 2 * bevelThickness, thick * 0.2);
  const insetLong = Math.max(longR - bevelSize, 0.05);
  const insetShort = Math.max(shortR - bevelSize, 0.05);

  let shape;
  if (shape3d === 'oblong' || shape3d === 'capsule') shape = stadiumShape(THREE, insetLong, insetShort);
  else if (shape3d === 'square') shape = roundedRectShape(THREE, insetLong, insetShort, Math.min(insetLong, insetShort) * 0.35);
  else shape = ellipseShape(THREE, insetLong, insetShort);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness, bevelSize, bevelSegments: 6, curveSegments: 32
  });
  geometry.translate(0, 0, -depth / 2 - bevelThickness);
  geometry.computeVertexNormals();
  return geometry;
}

// Real capsules are two differently colored halves split across the long axis, not a front/back gradient.
export function paintCapsuleColors(THREE, geometry, colorFrontHex, colorBackHex) {
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox;
  const midX = (min.x + max.x) / 2;
  const position = geometry.attributes.position;
  const front = new THREE.Color(colorFrontHex), back = new THREE.Color(colorBackHex);
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const c = position.getX(i) < midX ? front : back;
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}
