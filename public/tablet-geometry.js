// Pure geometry logic, independent of where THREE is imported from (browser vendor copy vs the
// npm package in tests) - callers inject THREE so this module has no import of its own.

// Approximate CSS colors for the official 식약처 color-class names; unknown/blank falls back to a neutral tablet tone.
export const COLOR_MAP = { 하양: '#ffffff', 흰색: '#ffffff', 노랑: '#ffe066', 노란색: '#ffe066', 주황: '#ff9f43', 분홍: '#f8b8c6', 빨강: '#e6544a', 빨간색: '#e6544a', 갈색: '#8a5a3c', 연두: '#c3e07a', 초록: '#4caf7d', 녹색: '#4caf7d', 청록: '#3fb8af', 파랑: '#4a7fe6', 파란색: '#4a7fe6', 남색: '#33418f', 자주: '#a54a8f', 보라: '#8a63c9', 회색: '#b7bfba', 검정: '#33383a', 검은색: '#33383a', 투명: '#eef2f0' };
// COLOR_CLASS1/2 is usually one plain color word, but real data also packs a modifier or a second
// color into the same field with a comma - e.g. "주황, 투명" (capsule body + transparent shell),
// "노랑, 옅은" (yellow, pale), "하양, 빨강" (bicolor). An exact-string lookup misses all of these and
// silently falls back to neutral gray, so this checks each comma/space-separated token in turn.
export function colorToCss(name) {
  const text = String(name ?? '').trim();
  if (!text) return '#eef2f0';
  for (const token of text.split(/[,\s]+/)) {
    if (COLOR_MAP[token]) return COLOR_MAP[token];
  }
  return '#eef2f0';
}

// Explicit map from the official 낱알식별 DRUG_SHAPE vocabulary to the internal shape3d key and the
// Three.js geometry each one builds in buildTabletGeometry() below. Confirmed against real search
// results (see docs/mfds-api.md history): a 400-product sample actually returned 원형/장방형/타원형/
// 팔각형/오각형/삼각형/사각형/기타 - 마름모형/육각형 are in the same official vocabulary but didn't
// happen to appear in that sample; they're mapped the same way (generalized n-gon) on the same basis.
export const SHAPE_MAP = {
  원형: { shape3d: 'round', geometry: 'rounded cylinder (LatheGeometry-equivalent via a circular extrude + bevel)' },
  타원형: { shape3d: 'oval', geometry: 'elliptical tablet (ellipse profile, extruded + bevel)' },
  장방형: { shape3d: 'oblong', geometry: 'rounded rectangular / oblong tablet (stadium profile, extruded + bevel)' },
  캡슐형: { shape3d: 'capsule', geometry: 'capsule (same stadium profile as 장방형, two-tone vertex colors) - see note below: real DRUG_SHAPE never actually says this, only CHART/name text does' },
  사각형: { shape3d: 'square', geometry: 'rounded box (axis-aligned rounded-rect profile, extruded + bevel)' },
  삼각형: { shape3d: 'triangle', geometry: 'rounded triangular prism (3-point rounded polygon, extruded + bevel)' },
  마름모형: { shape3d: 'rhombus', geometry: 'rounded rhombus prism (4-point rounded polygon, diamond orientation)' },
  오각형: { shape3d: 'pentagon', geometry: 'rounded pentagonal prism (5-point rounded polygon)' },
  육각형: { shape3d: 'hexagon', geometry: 'rounded hexagonal prism (6-point rounded polygon)' },
  팔각형: { shape3d: 'octagon', geometry: 'rounded octagonal prism (8-point rounded polygon)' },
  기타: { shape3d: null, geometry: 'no dedicated geometry - falls back to the closest basic shape (see classifyShape3D)' }
};
// Finer shape classification for 3D geometry than the 3-bucket 2D shape (round/oval/capsule button row).
// `extraText` is the official CHART/product-name text: real DRUG_SHAPE values are always a plain
// outline word (원형/장방형/타원형/...) even for capsules - MFDS never writes "캡슐형" there (confirmed
// against real search results). A hard (hinged, two-tone) capsule is only identifiable from CHART/
// name text ("...경질캡슐"/"...연질캅셀", the older "캅셀" spelling included), so that text is checked
// first and wins over the outline word. Unmapped/미분류 (등, "기타", a bear-face novelty shape, etc.)
// falls back to the closest basic 2D shape rather than inventing a geometry for it.
export function classifyShape3D(rawShapeText, coarseShape, extraText = '') {
  const raw = String(rawShapeText || '');
  if (/캡슐|캅셀/.test(String(extraText || '')) || raw.includes('캡슐')) return 'capsule';
  if (raw.includes('장방')) return 'oblong';
  if (raw.includes('마름모')) return 'rhombus';
  if (raw.includes('삼각')) return 'triangle';
  if (raw.includes('오각')) return 'pentagon';
  if (raw.includes('육각')) return 'hexagon';
  if (raw.includes('팔각')) return 'octagon';
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

// Generates an n-gon's vertices scaled so the shape's own bounding box is *exactly* long x short -
// not just "a regular n-gon scaled by long/short", which for odd n (triangle, pentagon) does not
// actually touch every edge of that box (a non-uniform scale of a regular polygon moves whichever
// vertex is extremal on each axis by a different factor). Instead: build a unit regular polygon,
// measure its own bounding box, then rescale+recenter per axis so the result touches long/short
// exactly on all four sides, whatever the vertex layout happens to be.
function polygonVertices(THREE, n, long, short, rotation = Math.PI / 2) {
  const raw = Array.from({ length: n }, (_, i) => {
    const a = rotation + i * (2 * Math.PI / n);
    return { x: Math.cos(a), y: Math.sin(a) };
  });
  const xs = raw.map(p => p.x), ys = raw.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const sx = long / (maxX - minX), sy = short / (maxY - minY);
  return raw.map(p => new THREE.Vector2((p.x - cx) * sx, (p.y - cy) * sy));
}

// Rounds every corner of an arbitrary (convex) polygon with a quadratic-Bezier fillet, the vertex
// itself as the control point - a standard, simple technique that keeps the fillet inside the
// original edges (never enlarges the shape), so it composes safely with the long/short-exact
// vertices above and the bevel/inset math already used by the other shapes in this file.
function roundedPolygonShape(THREE, points, radius) {
  const shape = new THREE.Shape();
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n], curr = points[i], next = points[(i + 1) % n];
    const toPrev = new THREE.Vector2().subVectors(prev, curr), toNext = new THREE.Vector2().subVectors(next, curr);
    const r = Math.min(radius, toPrev.length() * 0.4, toNext.length() * 0.4);
    const p1 = new THREE.Vector2().copy(curr).addScaledVector(toPrev.normalize(), r);
    const p2 = new THREE.Vector2().copy(curr).addScaledVector(toNext.normalize(), r);
    if (i === 0) shape.moveTo(p1.x, p1.y); else shape.lineTo(p1.x, p1.y);
    shape.quadraticCurveTo(curr.x, curr.y, p2.x, p2.y);
  }
  shape.closePath();
  return shape;
}

// Rounding a rectangle's corners doesn't shrink its bounding box (the flat edges between corners
// still reach the full width/height) - but for a triangle/rhombus/pentagon/etc the *vertex itself*
// is what touches the bounding box on that axis, so filleting it pulls that tip inward, by an
// amount that depends on the corner's interior angle (sharp corners lose more per unit radius than
// obtuse ones). Rather than deriving that trigonometry per polygon, this measures the actual result
// and applies one small corrective rescale - after which the profile (before the extrude/bevel step
// applied by the caller, exactly as for every other shape in this file) spans exactly long x short.
function roundedPolygonExact(THREE, n, long, short, rotation, filletFraction) {
  const vertices = polygonVertices(THREE, n, long, short, rotation);
  const filletRadius = Math.min(long, short) * filletFraction;
  const measured = roundedPolygonShape(THREE, vertices, filletRadius).getPoints(64);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of measured) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const scaleX = long / (maxX - minX), scaleY = short / (maxY - minY);
  const corrected = vertices.map(p => new THREE.Vector2(p.x * scaleX, p.y * scaleY));
  return roundedPolygonShape(THREE, corrected, filletRadius * Math.min(scaleX, scaleY));
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

// Lofts a genuine biconvex "lens" surface from a flat 2D outline instead of extruding it into a
// flat-topped block with only the rim beveled (ExtrudeGeometry's bevel rounds a thin strip near the
// edge, but the entire center of the top/bottom face stays perfectly flat - next to the official
// product photo, that reads as a slab, not a tablet). A real tablet - even a "flat" film-coated one
// - has a gently domed face that curves continuously from a short, mostly-vertical rim ("band")
// up to a rounded crown at the center.
//
// Construction: `boundaryPoints` is the outline at its true full size (ρ=1, the tablet's actual
// edge). Concentric copies of it, scaled toward the center (ρ→0), are lofted into a dome on each
// face: height h(ρ) runs from 1 at the center down to `edgeFraction` at the rim, along a
// superellipse curve (steeper `domePower` keeps the crown fuller before curving down, closer to a
// real convex tablet than a plain hemisphere). The two ρ=1 rings (top and bottom) are joined by a
// short side band - since edgeFraction > 0, there's still a visible rim, just a small one, instead
// of the whole side being one tall vertical wall.
//
// This never changes the bounding box: the ρ=1 rings reuse boundaryPoints exactly as given (already
// scaled to the true long/short by the caller), and the apex height is exactly thick/2 on each face
// (h(0) = edgeFraction + (1-edgeFraction)*1 = 1) - the dome only reshapes the interior surface.
function buildBiconvexGeometry(THREE, boundaryPoints, thick, { ringCount = 14, edgeFraction = 0.16, domePower = 2.6 } = {}) {
  const n = boundaryPoints.length;
  const halfT = thick / 2;
  const profile = rho => edgeFraction + (1 - edgeFraction) * Math.pow(Math.max(0, 1 - Math.pow(rho, domePower)), 1 / domePower);

  const positions = [];
  const pushRing = (rho, z) => {
    const start = positions.length / 3;
    for (const p of boundaryPoints) positions.push(p.x * rho, p.y * rho, z);
    return start;
  };

  const topApex = positions.length / 3; positions.push(0, 0, halfT);
  const topRing = [];
  for (let i = 1; i <= ringCount; i++) { const rho = i / ringCount; topRing[i] = pushRing(rho, halfT * profile(rho)); }
  const bottomApex = positions.length / 3; positions.push(0, 0, -halfT);
  const bottomRing = [];
  for (let i = 1; i <= ringCount; i++) { const rho = i / ringCount; bottomRing[i] = pushRing(rho, -halfT * profile(rho)); }

  const indices = [];
  // Top dome: apex fan, then ring-to-ring strips. Wound so the normal faces +Z-ish (outward/up).
  for (let j = 0; j < n; j++) indices.push(topApex, topRing[1] + j, topRing[1] + (j + 1) % n);
  for (let i = 1; i < ringCount; i++) {
    for (let j = 0; j < n; j++) {
      const a = topRing[i] + j, b = topRing[i] + (j + 1) % n, c = topRing[i + 1] + j, d = topRing[i + 1] + (j + 1) % n;
      indices.push(a, b, d, a, d, c);
    }
  }
  // Bottom dome: mirrored winding so its normal faces -Z-ish (outward/down).
  for (let j = 0; j < n; j++) indices.push(bottomApex, bottomRing[1] + (j + 1) % n, bottomRing[1] + j);
  for (let i = 1; i < ringCount; i++) {
    for (let j = 0; j < n; j++) {
      const a = bottomRing[i] + j, b = bottomRing[i] + (j + 1) % n, c = bottomRing[i + 1] + j, d = bottomRing[i + 1] + (j + 1) % n;
      indices.push(a, d, b, a, c, d);
    }
  }
  // Short outward-facing side band joining the two rims.
  for (let j = 0; j < n; j++) {
    const at = topRing[ringCount] + j, at2 = topRing[ringCount] + (j + 1) % n;
    const ab = bottomRing[ringCount] + j, ab2 = bottomRing[ringCount] + (j + 1) % n;
    indices.push(at, ab, at2, at2, ab, ab2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

// Builds tablet geometry with X=long, Y=short, Z=thick as the exact bounding-box dimensions
// (mm units treated 1:1 as world units). The dome/rim shaping only reshapes the interior surface -
// it never changes the long:short:thick ratio of the final bounding box.
export function buildTabletGeometry(THREE, { long, short, thick, shape3d }) {
  const longR = long / 2, shortR = short / 2;
  const POLYGON_SIDES = { triangle: 3, rhombus: 4, pentagon: 5, hexagon: 6, octagon: 8 };

  let shape;
  if (shape3d === 'oblong' || shape3d === 'capsule') shape = stadiumShape(THREE, longR, shortR);
  else if (shape3d === 'square') shape = roundedRectShape(THREE, longR, shortR, Math.min(longR, shortR) * 0.35);
  else if (POLYGON_SIDES[shape3d]) {
    const n = POLYGON_SIDES[shape3d];
    // A rhombus (4-gon with a vertex pointing along each axis) reads correctly starting from the
    // top; a triangle apex-up likewise starts at the top (rotation = 90°, the default). Higher-sided
    // polygons (pentagon/hexagon/octagon) look most like a real tablet outline flat-edge-up instead
    // of point-up, so they get an extra half-a-side rotation.
    const rotation = n <= 4 ? Math.PI / 2 : Math.PI / 2 + Math.PI / n;
    shape = roundedPolygonExact(THREE, n, long, short, rotation, 0.22);
  }
  else shape = ellipseShape(THREE, longR, shortR);

  const boundaryPoints = shape.getPoints(96);
  const geometry = buildBiconvexGeometry(THREE, boundaryPoints, thick);
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
