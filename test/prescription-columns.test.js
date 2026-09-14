import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectVerticalLines, computeColumnBoundaries } from '../public/prescription-columns.js';

// A fake <canvas> whose pixels are under direct control (RGBA Uint8ClampedArray, grayscale so R=G=B),
// so detectVerticalLines can be tested against a KNOWN table-line pattern rather than guessed output.
function canvasWithLines(width, height, lineXs, lineWidth = 2) {
  const buffer = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) {
    for (const lineX of lineXs) {
      for (let dx = 0; dx < lineWidth; dx++) {
        const x = lineX + dx, idx = (y * width + x) * 4;
        buffer[idx] = buffer[idx + 1] = buffer[idx + 2] = 0; buffer[idx + 3] = 255;
      }
    }
  }
  return {
    width, height,
    getContext: () => ({
      getImageData: (sx, sy, sw, sh) => {
        const data = new Uint8ClampedArray(sw * sh * 4);
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
          const srcIdx = ((sy + y) * width + (sx + x)) * 4, dstIdx = (y * sw + x) * 4;
          for (let c = 0; c < 4; c++) data[dstIdx + c] = buffer[srcIdx + c];
        }
        return { data, width: sw, height: sh };
      }
    })
  };
}

test('detectVerticalLines: 세로 룰선의 x 위치를 찾는다 (고정 픽셀이 아니라 실제 어두운 픽셀 기준)', () => {
  const canvas = canvasWithLines(1000, 200, [300, 600, 850], 1);
  const lines = detectVerticalLines(canvas, 0, 200);
  assert.deepEqual(lines, [300, 600, 850]);
});

test('detectVerticalLines: 지정한 y 범위 밖의 선은 잡지 않는다', () => {
  const buffer = new Uint8ClampedArray(1000 * 400 * 4).fill(255);
  // A vertical line only present in y=0..100 (e.g. an unrelated header divider), not in the table band.
  for (let y = 0; y < 100; y++) { const idx = (y * 1000 + 500) * 4; buffer[idx] = buffer[idx + 1] = buffer[idx + 2] = 0; }
  const canvas = {
    width: 1000, height: 400,
    getContext: () => ({
      getImageData: (sx, sy, sw, sh) => {
        const data = new Uint8ClampedArray(sw * sh * 4);
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
          const srcIdx = ((sy + y) * 1000 + (sx + x)) * 4, dstIdx = (y * sw + x) * 4;
          for (let c = 0; c < 4; c++) data[dstIdx + c] = buffer[srcIdx + c];
        }
        return { data, width: sw, height: sh };
      }
    })
  };
  assert.deepEqual(detectVerticalLines(canvas, 200, 400), []);
});

test('detectVerticalLines: 짧게 끊긴(글자와 겹친) 선은 기준 미달로 무시한다', () => {
  // A line dark for only 30% of the band height should not count (MIN_COVERAGE default .55).
  const width = 400, height = 200;
  const buffer = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < 60; y++) { const idx = (y * width + 200) * 4; buffer[idx] = buffer[idx + 1] = buffer[idx + 2] = 0; }
  const canvas = { width, height, getContext: () => ({ getImageData: (sx, sy, sw, sh) => {
    const data = new Uint8ClampedArray(sw * sh * 4);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const srcIdx = ((sy + y) * width + (sx + x)) * 4, dstIdx = (y * sw + x) * 4;
      for (let c = 0; c < 4; c++) data[dstIdx + c] = buffer[srcIdx + c];
    }
    return { data, width: sw, height: sh };
  } }) };
  assert.deepEqual(detectVerticalLines(canvas, 0, height), []);
});

test('computeColumnBoundaries: 헤더 x 위치 + 세로선을 결합해 정밀한 경계를 만든다', () => {
  const header = { columns: [{ field: 'name', x: 200 }, { field: 'dosePerAdministration', x: 1080 }, { field: 'frequencyPerDay', x: 1250 }, { field: 'durationDays', x: 1450 }] };
  const lines = [1030, 1180, 1350, 1550]; // real rule-line x positions bracketing each numeric column
  const boundaries = computeColumnBoundaries({ header, lines, nameRightEdge: 1000, imageWidth: 1700 });
  assert.deepEqual(boundaries.dosePerAdministration, { x0: 1030, x1: 1180, source: 'header+line' });
  assert.deepEqual(boundaries.frequencyPerDay, { x0: 1180, x1: 1350, source: 'header+line' });
  assert.equal(boundaries.durationDays.x0, 1350);
  assert.equal(boundaries.durationDays.x1, 1550, '마지막 열의 오른쪽 경계도 세로선을 그대로 쓴다');
});

test('computeColumnBoundaries: 세로선이 전혀 없어도 헤더 중간점으로 fallback한다', () => {
  const header = { columns: [{ field: 'name', x: 200 }, { field: 'dosePerAdministration', x: 1080 }, { field: 'frequencyPerDay', x: 1250 }, { field: 'durationDays', x: 1450 }] };
  const boundaries = computeColumnBoundaries({ header, lines: [], nameRightEdge: 1000, imageWidth: 1700 });
  assert.ok(boundaries.dosePerAdministration.x0 < boundaries.frequencyPerDay.x0);
  assert.ok(boundaries.frequencyPerDay.x0 < boundaries.durationDays.x0);
  assert.equal(boundaries.durationDays.x1, 1700, '헤더가 마지막 열이면 이미지 폭이 오른쪽 경계가 된다');
});

test('computeColumnBoundaries: 헤더가 전혀 없어도 세로선 순서만으로 3개 열을 나눈다', () => {
  // No header at all - only 4 detected lines to the right of the name text, in table order.
  const boundaries = computeColumnBoundaries({ header: null, lines: [1030, 1180, 1350, 1650], nameRightEdge: 1000, imageWidth: 1700 });
  assert.deepEqual(boundaries.dosePerAdministration, { x0: 1030, x1: 1180, source: 'line-order' });
  assert.deepEqual(boundaries.frequencyPerDay, { x0: 1180, x1: 1350, source: 'line-order' });
  assert.deepEqual(boundaries.durationDays, { x0: 1350, x1: 1650, source: 'line-order' });
});

test('computeColumnBoundaries: 헤더도 세로선도 부족하면 그 필드는 아예 비워둔다 (호출부가 다음 fallback을 쓰도록)', () => {
  const boundaries = computeColumnBoundaries({ header: null, lines: [1030], nameRightEdge: 1000, imageWidth: 1700 });
  assert.deepEqual(boundaries, {});
});

test('computeColumnBoundaries: 이름 텍스트보다 왼쪽에 있는 세로선(다른 열 경계)은 무시한다', () => {
  const header = { columns: [{ field: 'name', x: 200 }, { field: 'dosePerAdministration', x: 1080 }] };
  // A line to the left of nameRightEdge (e.g. a divider inside the name column) must never be chosen.
  const boundaries = computeColumnBoundaries({ header, lines: [500, 1030], nameRightEdge: 1000, imageWidth: 1700 });
  assert.equal(boundaries.dosePerAdministration.x0, 1030);
});
