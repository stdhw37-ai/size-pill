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
