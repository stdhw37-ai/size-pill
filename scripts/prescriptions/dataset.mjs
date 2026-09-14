import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fields } from './evaluate.mjs';
export const tags = ['table', 'borderless', 'wrapped-name', 'with-code', 'without-code', 'skewed', 'low-light', 'mobile-photo', 'decimal-dose', 'liquid', 'reordered-columns'];
export async function localPath(root, path) {
  if (typeof path !== 'string' || isAbsolute(path)) throw new Error('Fixture path must be relative');
  const base = await realpath(root), target = await realpath(resolve(base, path)), rel = relative(base, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Fixture path escapes dataset');
  return target;
}
export function validateLabels(label) {
  if (label.schemaVersion !== 1 || !Array.isArray(label.medications) || !label.medications.length) throw new Error('Invalid labels schemaVersion/medications');
  for (const row of label.medications) {
    if (!row || fields.some(f => !Object.hasOwn(row, f))) throw new Error('Missing required medication field');
    if (row.productCode !== null && (typeof row.productCode !== 'string' || !/^\d{8,9}$/.test(row.productCode))) throw new Error('Invalid productCode');
    for (const f of ['rawName', 'drugName']) if (typeof row[f] !== 'string' || !row[f].trim()) throw new Error(`Invalid ${f}`);
    if (row.doseUnit !== null && (typeof row.doseUnit !== 'string' || !row.doseUnit.trim())) throw new Error('Invalid doseUnit');
    for (const f of ['dosePerAdministration', 'frequencyPerDay', 'durationDays']) if (row[f] !== null && (typeof row[f] !== 'number' || !Number.isFinite(row[f]) || row[f] <= 0)) throw new Error(`Invalid ${f}`);
  }
}
export async function loadDataset(root) {
  const manifest = JSON.parse(await readFile(resolve(root, 'dataset.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.fixtures) || !manifest.fixtures.length) throw new Error('Invalid dataset manifest');
  const seen = new Set(), fixtures = [];
  for (const item of manifest.fixtures) {
    if (!/^[a-z0-9-]+$/.test(item.id) || seen.has(item.id)) throw new Error('Invalid or duplicate fixture id'); seen.add(item.id);
    if (!Array.isArray(item.tags) || !item.tags.length || item.tags.some(t => !tags.includes(t))) throw new Error(`Invalid tags: ${item.id}`);
    if (!['synthetic', 'deidentified', 'transcribed-reference'].includes(item.source)) throw new Error(`Invalid source: ${item.id}`);
    if (!['ready', 'awaiting-image'].includes(item.status) || (item.status === 'ready' && !item.image) || (item.status === 'awaiting-image' && item.image !== null)) throw new Error(`Invalid image status: ${item.id}`);
    if (item.privacyReviewed !== true) throw new Error(`Privacy review required: ${item.id}`);
    const label = JSON.parse(await readFile(await localPath(root, item.labels), 'utf8')); validateLabels(label);
    const imagePath = item.image ? await localPath(root, item.image) : null;
    if (imagePath && (!(await stat(imagePath)).size || !/\.(png|jpe?g|webp)$/i.test(imagePath))) throw new Error(`Invalid image: ${item.id}`);
    const ocrPath = item.ocr ? await localPath(root, item.ocr) : null;
    fixtures.push({ ...item, label, imagePath, ocrPath });
  }
  return { manifest, fixtures };
}
