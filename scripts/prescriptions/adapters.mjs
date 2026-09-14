import { readFile, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, extname } from 'node:path';
import { parsePrescriptionWords, parsePrescriptionText, ocrWords } from '../../public/prescription-parser.js';
import { extractWithVision } from '../../public/prescription-extractor.js';
// Parser-only canonical projection, not the app's legacy extractor. No truth-based corrections.
export function parserMedication(row) {
  const unit = row.prescribedUnit || '';
  return { productCode: row.code ?? null, rawName: row.rawName, drugName: row.drugName,
    dosePerAdministration: row.dosePerAdministration, doseUnit: unit.match(/(캡슐|정|포|병)$/)?.[1] || (/mL$/i.test(unit) ? 'mL' : null),
    frequencyPerDay: row.frequencyPerDay, durationDays: row.durationDays };
}
export async function parserAdapter({ ocrPath }) {
  const data = JSON.parse(await readFile(ocrPath, 'utf8'));
  if (!['synthetic-tokens', 'manual-transcription', 'engine-capture'].includes(data.provenance)) throw new Error('OCR capture provenance is required');
  const rows = data.words ? parsePrescriptionWords(data.words) : parsePrescriptionText(data.text);
  return { medications: rows.map(parserMedication), source: `parser:${data.provenance}` };
}
export async function visionAdapter({ imagePath, apiBase, signal }) {
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(imagePath).toLowerCase()];
  return extractWithVision(new File([await readFile(imagePath)], 'fixture' + extname(imagePath), { type: mime }), { apiBase, signal });
}
export async function createPageOcrAdapter() {
  // Deliberately a named engine/page-parser benchmark. The browser preprocessing,
  // fallback pass and numeric crop pass are NOT emulated here or included in this score.
  const { createWorker } = await import('tesseract.js');
  const langPath = await mkdtemp(join(tmpdir(), 'rx-eval-lang-'));
  let worker;
  try {
    for (const lang of ['kor', 'eng']) await copyFile(resolve(`node_modules/@tesseract.js-data/${lang}/4.0.0/${lang}.traineddata.gz`), join(langPath, `${lang}.traineddata.gz`));
    worker = await createWorker(['kor', 'eng'], 1, { langPath, cacheMethod: 'none' });
    await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1', thresholding_method: '0' });
  } catch (error) { await rm(langPath, { recursive: true, force: true }); throw error; }
  return {
    async extract({ imagePath }) {
      const { data } = await worker.recognize(imagePath, { rotateAuto: true }, { text: true, blocks: true });
      return { medications: parsePrescriptionWords(ocrWords(data)).map(parserMedication), source: 'tesseract-page-parser', engine: 'tesseract.js', engineVersion: '7.0.0' };
    },
    async close() { try { await worker.terminate(); } finally { await rm(langPath, { recursive: true, force: true }); } }
  };
}
