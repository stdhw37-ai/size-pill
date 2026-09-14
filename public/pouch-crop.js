// Pure, DOM-free pouch/bottle region detection so it can run in a browser canvas context and be
// unit tested with plain pixel arrays. Given a downscaled RGBA image, finds the single most
// pouch/bottle-like foreground object (tall, mostly-solid, not filling most of the frame) against
// its own background/backdrop, so an outer box photographed alongside it is excluded. Thresholds
// were tuned against real 식약처 product photos (plain background vs. box-alongside-pouch vs.
// box-only shots); this is a heuristic, not real segmentation - low-confidence photos correctly
// return null so the caller can fall back to a per-product override rect or the fallback schematic,
// rather than guessing.
const DEFAULTS = {
  threshold: 45, // Euclidean RGB distance from the sampled background to count as foreground.
  minAreaFrac: 0.005, // Drop speckle components smaller than this fraction of the frame.
  aspectMin: 1.6, // height/width - a box photographed flat-on is rarely this tall relative to its width.
  fillMin: 0.3, // area / bbox area - rejects thin scattered noise.
  fillMax: 0.97, // a near-perfectly solid rectangle this close to 1 is almost always a flat box, not a pouch/bottle.
  areaPctMax: 0.45, // a single object filling most of the frame is usually a box shot alone, not an isolated container.
  padding: 0.08 // fractional padding added around the picked bounding box before cropping - keeps the pouch's top/bottom seals from being clipped.
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

export function sampleBackground(data, width, height) {
  const r = [], g = [], b = [];
  const push = i => { r.push(data[i * 4]); g.push(data[i * 4 + 1]); b.push(data[i * 4 + 2]); };
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
  return [median(r), median(g), median(b)];
}

export function buildForegroundMask(data, width, height, background, threshold = DEFAULTS.threshold) {
  const mask = new Uint8Array(width * height);
  const [br, bg, bb] = background;
  for (let i = 0; i < width * height; i++) {
    const dr = data[i * 4] - br, dg = data[i * 4 + 1] - bg, db = data[i * 4 + 2] - bb;
    mask[i] = Math.sqrt(dr * dr + dg * dg + db * db) > threshold ? 1 : 0;
  }
  return mask;
}

// Binary opening (erode then dilate) with a 2x2 structuring element - removes single-pixel/thin
// noise (e.g. JPEG ringing at the background edge) without needing a symmetric kernel.
export function openMask(mask, width, height) {
  const eroded = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!mask[i]) continue;
      const right = x + 1 < width && mask[i + 1];
      const down = y + 1 < height && mask[i + width];
      const diag = x + 1 < width && y + 1 < height && mask[i + width + 1];
      eroded[i] = right && down && diag ? 1 : 0;
    }
  }
  const dilated = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!eroded[i]) continue;
      dilated[i] = 1;
      if (x + 1 < width) dilated[i + 1] = 1;
      if (y + 1 < height) dilated[i + width] = 1;
      if (x + 1 < width && y + 1 < height) dilated[i + width + 1] = 1;
    }
  }
  return dilated;
}

// Fills background-colored pixels fully enclosed by foreground (e.g. a printed white label patch
// that happens to match the backdrop) so one physical object stays one connected component.
export function fillHoles(mask, width, height) {
  const outside = new Uint8Array(width * height);
  const stack = [];
  const mark = i => { if (!mask[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
  for (let x = 0; x < width; x++) { mark(x); mark((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { mark(y * width); mark(y * width + width - 1); }
  while (stack.length) {
    const idx = stack.pop();
    const x = idx % width, y = (idx / width) | 0;
    if (x > 0) mark(idx - 1);
    if (x < width - 1) mark(idx + 1);
    if (y > 0) mark(idx - width);
    if (y < height - 1) mark(idx + width);
  }
  const filled = mask.slice();
  for (let i = 0; i < width * height; i++) if (!mask[i] && !outside[i]) filled[i] = 1;
  return filled;
}

export function labelComponents(mask, width, height) {
  const labels = new Int32Array(width * height);
  const components = [];
  let current = 0;
  for (let start = 0; start < width * height; start++) {
    if (!mask[start] || labels[start]) continue;
    current++;
    const stack = [start];
    labels[start] = current;
    let minX = width, maxX = 0, minY = height, maxY = 0, area = 0;
    while (stack.length) {
      const idx = stack.pop();
      const x = idx % width, y = (idx / width) | 0;
      area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && mask[idx - 1] && !labels[idx - 1]) { labels[idx - 1] = current; stack.push(idx - 1); }
      if (x < width - 1 && mask[idx + 1] && !labels[idx + 1]) { labels[idx + 1] = current; stack.push(idx + 1); }
      if (y > 0 && mask[idx - width] && !labels[idx - width]) { labels[idx - width] = current; stack.push(idx - width); }
      if (y < height - 1 && mask[idx + width] && !labels[idx + width]) { labels[idx + width] = current; stack.push(idx + width); }
    }
    components.push({ id: current, minX, maxX, minY, maxY, area });
  }
  return components;
}

// Returns the best pouch/bottle candidate's bounding box as fractions (0..1) of the input image,
// or null when nothing in the frame confidently looks like an isolated container.
export function findPouchRegion(imageData, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const { data, width, height } = imageData;
  if (!data || !width || !height) return null;
  const background = sampleBackground(data, width, height);
  let mask = buildForegroundMask(data, width, height, background, o.threshold);
  mask = openMask(mask, width, height);
  mask = fillHoles(mask, width, height);
  const components = labelComponents(mask, width, height);
  const totalArea = width * height;
  let best = null;
  for (const c of components) {
    if (c.area < o.minAreaFrac * totalArea) continue;
    const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    const aspect = bh / bw, fill = c.area / (bw * bh), areaPct = c.area / totalArea;
    if (aspect < o.aspectMin || fill < o.fillMin || fill > o.fillMax || areaPct > o.areaPctMax) continue;
    if (!best || aspect > best.aspect) best = { minX: c.minX, maxX: c.maxX, minY: c.minY, maxY: c.maxY, aspect, fill, areaPct };
  }
  if (!best) return null;
  const bw = best.maxX - best.minX + 1, bh = best.maxY - best.minY + 1;
  const padX = bw * o.padding, padY = bh * o.padding;
  const x0 = Math.max(0, best.minX - padX), y0 = Math.max(0, best.minY - padY);
  const x1 = Math.min(width, best.maxX + 1 + padX), y1 = Math.min(height, best.maxY + 1 + padY);
  return { x: x0 / width, y: y0 / height, width: (x1 - x0) / width, height: (y1 - y0) / height };
}
