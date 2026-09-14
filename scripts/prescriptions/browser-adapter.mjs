// Optional actual browser pipeline adapter. Install Playwright separately; no app code changes.
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
let browser;
export async function extract({ imagePath, signal }) {
  const appUrl = process.env.RX_EVAL_APP_URL;
  if (!appUrl) throw new Error('RX_EVAL_APP_URL must point to the running app');
  const provider = process.env.RX_EVAL_PROVIDER || 'legacy-ocr';
  if (!['legacy-ocr', 'vision', 'auto'].includes(provider)) throw new Error('Invalid RX_EVAL_PROVIDER');
  if (!browser) { const { chromium } = await import(process.env.RX_EVAL_PLAYWRIGHT_MODULE || 'playwright'); browser = await chromium.launch({ headless: true }); }
  const page = await browser.newPage();
  const abort = () => { void page.close().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted(); await page.goto(appUrl);
    const base64 = (await readFile(imagePath)).toString('base64');
    const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(imagePath).toLowerCase()];
    return await page.evaluate(async ({ base64, type, provider }) => {
      const pipeline = await import('/prescription-extractor.js');
      const file = new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'fixture', { type });
      const opts = { document, signal: AbortSignal.timeout(115000) };
      const fn = provider === 'legacy-ocr' ? pipeline.extractWithLegacyOcr : provider === 'vision' ? pipeline.extractWithVision : pipeline.extractPrescription;
      return fn(file, opts);
    }, { base64, type, provider });
  } finally { signal.removeEventListener('abort', abort); await page.close(); }
}
export async function close() { await browser?.close(); browser = null; }
