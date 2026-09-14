import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleBackground, buildForegroundMask, fillHoles, labelComponents, findPouchRegion } from '../public/pouch-crop.js';

// Paints a solid axis-aligned rectangle of `color` onto an RGBA buffer already filled with `bg`.
function paintRect(data, width, x0, y0, x1, y1, color) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      data[i] = color[0]; data[i + 1] = color[1]; data[i + 2] = color[2]; data[i + 3] = 255;
    }
  }
}
function frame(width, height, bg = [255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) { data[i * 4] = bg[0]; data[i * 4 + 1] = bg[1]; data[i * 4 + 2] = bg[2]; data[i * 4 + 3] = 255; }
  return { data, width, height };
}

test('sampleBackground reads the border color, ignoring an interior object', () => {
  const { data, width, height } = frame(20, 20, [250, 250, 250]);
  paintRect(data, width, 5, 5, 15, 15, [10, 10, 10]);
  assert.deepEqual(sampleBackground(data, width, height), [250, 250, 250]);
});

test('buildForegroundMask flags only pixels far enough from the background color', () => {
  const { data, width, height } = frame(10, 10, [255, 255, 255]);
  paintRect(data, width, 3, 3, 7, 7, [0, 0, 0]);
  const mask = buildForegroundMask(data, width, height, [255, 255, 255], 45);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
    const inside = x >= 3 && x < 7 && y >= 3 && y < 7;
    assert.equal(mask[y * 10 + x], inside ? 1 : 0, `(${x},${y})`);
  }
});

test('fillHoles closes a background-colored patch fully enclosed by foreground', () => {
  const width = 10, height = 10;
  const mask = new Uint8Array(width * height);
  for (let y = 1; y < 9; y++) for (let x = 1; x < 9; x++) mask[y * width + x] = 1;
  mask[5 * width + 5] = 0; // one enclosed "hole" pixel, e.g. printed text matching the backdrop
  const filled = fillHoles(mask, width, height);
  assert.equal(filled[5 * width + 5], 1);
  assert.equal(filled[0], 0, 'true background pixels stay background');
});

test('labelComponents separates two disconnected foreground blobs and reports each bounding box', () => {
  const width = 20, height = 20;
  const mask = new Uint8Array(width * height);
  for (let y = 1; y < 5; y++) for (let x = 1; x < 3; x++) mask[y * width + x] = 1;
  for (let y = 10; y < 18; y++) for (let x = 10; x < 12; x++) mask[y * width + x] = 1;
  const components = labelComponents(mask, width, height);
  assert.equal(components.length, 2);
  const bySize = components.sort((a, b) => a.area - b.area);
  assert.equal(bySize[0].area, 2 * 4); assert.equal(bySize[1].area, 2 * 8);
});

test('findPouchRegion picks the tall isolated pouch and excludes a nearby squarish box', () => {
  const { data, width, height } = frame(120, 120, [255, 255, 255]);
  // A boxy, near-square object (a "box") - should be rejected for low aspect ratio.
  paintRect(data, width, 60, 10, 100, 45, [40, 90, 160]);
  // A tall, slender object (a "pouch") well separated from the box. A slightly narrower cap
  // (like a real pouch's heat-sealed top) keeps this short of a perfect rectangle, same as a real
  // product photo - a flawless solid rectangle instead reads as a flat box and is rejected.
  paintRect(data, width, 10, 20, 30, 100, [200, 40, 90]);
  paintRect(data, width, 10, 20, 14, 26, [255, 255, 255]);
  paintRect(data, width, 26, 20, 30, 26, [255, 255, 255]);
  const region = findPouchRegion({ data, width, height });
  assert.ok(region, 'expected a confident pouch region');
  // Region should land on the pouch (left) rather than the box (right).
  assert.ok(region.x < 0.4, `x=${region.x}`);
  assert.ok(region.x + region.width < 0.6, `right edge=${region.x + region.width}`);
  assert.ok(region.height > region.width, 'picked region should be taller than wide');
});

test('findPouchRegion returns null when the only object is a flat box filling most of the frame', () => {
  const { data, width, height } = frame(100, 160, [255, 255, 255]);
  paintRect(data, width, 5, 5, 95, 155, [180, 40, 40]); // a single tall-but-solid rectangle, like a box shot alone
  assert.equal(findPouchRegion({ data, width, height }), null);
});

test('findPouchRegion returns null when nothing in the frame differs from the background', () => {
  const { data, width, height } = frame(50, 50, [255, 255, 255]);
  assert.equal(findPouchRegion({ data, width, height }), null);
});

test('findPouchRegion returns null when two objects merge into one ambiguous blob', () => {
  const { data, width, height } = frame(100, 100, [255, 255, 255]);
  // Box and pouch touching with no background gap between them - looks like one squarish blob.
  paintRect(data, width, 10, 10, 50, 90, [50, 50, 50]);
  paintRect(data, width, 50, 10, 90, 90, [50, 50, 50]);
  assert.equal(findPouchRegion({ data, width, height }), null);
});
