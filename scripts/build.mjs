import { mkdir, copyFile, cp } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await copyFile('index.html', 'dist/index.html');
await cp('public', 'dist', { recursive: true });
// Self-host the exact three.js files the 3D tablet model needs (no CDN dependency).
// Directory layout is preserved so OrbitControls.js's own relative/bare imports resolve.
await mkdir('dist/vendor/three/build', { recursive: true });
await copyFile('node_modules/three/build/three.module.js', 'dist/vendor/three/build/three.module.js');
await mkdir('dist/vendor/three/examples/jsm/controls', { recursive: true });
await copyFile('node_modules/three/examples/jsm/controls/OrbitControls.js', 'dist/vendor/three/examples/jsm/controls/OrbitControls.js');
// OCR runs locally; ship worker, WASM and Korean/English models with web/native assets.
await mkdir('dist/vendor/ocr/lang', { recursive: true });
await copyFile('node_modules/tesseract.js/dist/tesseract.min.js', 'dist/vendor/ocr/tesseract.min.js');
await copyFile('node_modules/tesseract.js/dist/worker.min.js', 'dist/vendor/ocr/worker.min.js');
await cp('node_modules/tesseract.js-core', 'dist/vendor/ocr/core', { recursive: true });
for (const lang of ['kor', 'eng']) {
  await copyFile(`node_modules/@tesseract.js-data/${lang}/4.0.0/${lang}.traineddata.gz`, `dist/vendor/ocr/lang/${lang}.traineddata.gz`);
}
