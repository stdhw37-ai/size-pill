// Browser decoding applies EXIF orientation once. Never manually rotate the decoded
// image again. All pixels stay in memory; the caller owns canvas disposal.
export function preparePrescriptionImage(image, document) {
  const scale = Math.min(1, 3600 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height), hist = new Uint32Array(256);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const gray = Math.round(.299 * pixels.data[i] + .587 * pixels.data[i + 1] + .114 * pixels.data[i + 2]);
    hist[gray]++; pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = gray;
  }
  const total = canvas.width * canvas.height;
  let lo = 0, hi = 255, sum = 0;
  for (let i = 0; i < 256; i++) { sum += hist[i]; if (sum >= total * .005) { lo = i; break; } }
  sum = 0;
  for (let i = 255; i >= 0; i--) { sum += hist[i]; if (sum >= total * .005) { hi = i; break; } }
  if (hi - lo >= 40) for (let i = 0; i < pixels.data.length; i += 4) {
    const gray = Math.max(0, Math.min(255, (pixels.data[i] - lo) * 255 / (hi - lo)));
    pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = gray;
  }
  ctx.putImageData(pixels, 0, 0);
  // Preserve rules: removing them blindly also erases hyphens and Korean strokes.
  // Tesseract performs thresholding and line finding on this grayscale image.
  return canvas;
}
