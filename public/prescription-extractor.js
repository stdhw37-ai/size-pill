// Provider abstraction for prescription image -> structured data (item 4 of the request). Anything
// that implements extract(file, opts) -> Promise<{ medications, source }> is a valid extractor:
//   - extractWithVision      PRIMARY. Calls the Worker's /api/prescription/extract - the API key
//                            lives only server-side (src/prescription-vision.js), never here.
//   - extractWithLegacyOcr   FALLBACK. Wraps the existing, UNCHANGED on-device pipeline
//                            (prescription-image.js/prescription-parser.js/prescription-ocr.js) -
//                            used whenever vision is not configured or fails for any reason.
// extractPrescription() is the one entry point the rest of the app calls; it never needs to know
// which path actually ran (group/row shape is identical either way - see prescription-schema.js).
import { clampMedication, parsedRowToRaw } from './prescription-schema.js';

// status/providerMessage let the caller show "Google Vision 호출 실패: [status] [message]" (never the
// API key, never the full OCR text - see item 5/6 of the request) without needing to re-parse the
// server's response shape at every call site.
export class VisionUnavailableError extends Error {
  constructor(message, { status, provider, providerMessage } = {}) {
    super(message);
    this.status = status; this.provider = provider; this.providerMessage = providerMessage;
  }
}

// Same on-device Tesseract pipeline as before this rework - untouched (prescription-image.js/
// prescription-parser.js/prescription-ocr.js are not modified by this change, per the request's
// "기존 OCR parser를 이번 작업에서 또 대규모 수정하지 마세요"). Only the bootstrap/orchestration that used
// to live inline in app.js's scanPrescription() moved here, so both extractors share one call shape.
let ocrLoader;
function loadTesseractScript(document) {
  if (window.Tesseract) return Promise.resolve();
  if (!ocrLoader) ocrLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = '/vendor/ocr/tesseract.min.js';
    script.onload = resolve; script.onerror = () => { ocrLoader = null; script.remove(); reject(new Error('OCR 로딩 실패')); };
    document.head.append(script);
  });
  return ocrLoader;
}
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('cancelled', 'AbortError'));
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function extractWithLegacyOcr(file, { document, signal, onStatus, onWorker, debug } = {}) {
  await abortable(loadTesseractScript(document), signal);
  const objectURL = URL.createObjectURL(file);
  const image = new Image(); image.src = objectURL;
  let canvas, worker;
  try {
    await abortable(image.decode(), signal);
    const preprocessing = await import('./prescription-image.js');
    const { recognizePrescription } = await import('./prescription-ocr.js');
    canvas = preprocessing.preparePrescriptionImage(image, document);
    URL.revokeObjectURL(objectURL); image.src = '';
    const creation = window.Tesseract.createWorker(['kor', 'eng'], 1, {
      workerPath: '/vendor/ocr/worker.min.js', corePath: '/vendor/ocr/core', langPath: '/vendor/ocr/lang',
      cacheMethod: 'none', logger: event => onStatus?.(`기기에서 분석 중… ${Math.round((event.progress || 0) * 100)}%`)
    });
    creation.then(instance => { if (signal.aborted) instance.terminate(); }, () => {});
    worker = await abortable(creation, signal);
    onWorker?.(worker);
    // debug is opt-in only (?debugPrescription=1 - see app.js), never populated in normal use (item 11).
    const rows = await recognizePrescription(worker, canvas, signal, promise => abortable(promise, signal), debug);
    return { medications: rows.map(row => clampMedication(parsedRowToRaw(row))), source: 'legacy-ocr', provider: 'local-tesseract' };
  } finally {
    if (worker) await worker.terminate();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

// Server holds the API key (src/prescription-vision.js) - this only ever sends the image itself, once,
// over HTTPS, and never persists a copy (see item 8's privacy notes for the full data-handling chain).
export async function extractWithVision(file, { signal, apiBase = '' } = {}) {
  const body = new FormData(); body.append('image', file);
  let response;
  try { response = await fetch(apiBase + '/api/prescription/extract', { method: 'POST', body, signal }); }
  catch (error) { if (error.name === 'AbortError') throw error; throw new VisionUnavailableError('network', { status: 0 }); }
  const data = await response.json().catch(() => null);
  if (response.status === 501) throw new VisionUnavailableError('vision_not_configured', { status: 501, provider: data?.provider });
  if (response.status === 429) throw new VisionUnavailableError('rate_limited', { status: 429, provider: data?.provider });
  if (!response.ok || !data) {
    throw new VisionUnavailableError(data?.error || 'upstream', { status: response.status, provider: data?.provider, providerMessage: data?.providerMessage });
  }
  return { medications: (data.medications || []).map(clampMedication), source: 'vision', provider: data.provider };
}

// The one entry point the rest of the app calls (item 3): vision first, legacy OCR only when vision
// is not configured or fails for any reason. A vision failure is never shown to the user as an error
// by itself - falling back to on-device OCR is the expected, normal behavior while no provider (or a
// temporarily unavailable one) is configured, not a broken feature.
// opts.visionExtractor/opts.legacyExtractor default to the real implementations above; app.js never
// passes them and gets the real behavior. Tests inject fakes here to verify the FALLBACK DECISION
// itself without needing a real provider call or a real browser/Tesseract for the legacy path.
//
// opts.disableFallbackOnFailure (TEMPORARY - see item 6 of the request): while debugging why vision
// wasn't being reached/failing silently, a failure that isn't "not configured" should surface
// directly instead of being masked by the normal legacy-OCR fallback. Only ever set from app.js's own
// ?debugPrescription=1 path (never the default) - flip DEBUG_PRESCRIPTION off there to restore normal
// production fallback behavior at any time; nothing here needs to change back.
export async function extractPrescription(file, opts = {}) {
  const vision = opts.visionExtractor || extractWithVision;
  const legacy = opts.legacyExtractor || extractWithLegacyOcr;
  try {
    return await vision(file, opts);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    opts.onVisionUnavailable?.(error);
    if (opts.disableFallbackOnFailure && !(error instanceof VisionUnavailableError && error.message === 'vision_not_configured')) throw error;
    return legacy(file, opts);
  }
}
