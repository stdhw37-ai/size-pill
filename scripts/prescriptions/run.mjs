import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadDataset, tags } from './dataset.mjs';
import { scoreFixture, aggregate } from './evaluate.mjs';
import { parserAdapter, visionAdapter, createPageOcrAdapter } from './adapters.mjs';

const { values } = parseArgs({ options: {
  dataset: { type: 'string', default: 'test/fixtures/prescriptions' }, mode: { type: 'string', default: 'parser' },
  predictions: { type: 'string' }, baseline: { type: 'string' }, adapter: { type: 'string' }, 'api-base': { type: 'string' }, output: { type: 'string' },
  'require-images': { type: 'boolean', default: false }, 'min-full-row': { type: 'string' }
} });
async function main() {
  const root = resolve(values.dataset), { fixtures } = await loadDataset(root);
  const mode = values.predictions ? 'saved' : values.adapter ? 'custom' : values.mode;
  if (!['saved', 'custom', 'parser', 'page-ocr', 'vision'].includes(mode)) throw new Error('Unknown evaluation mode');
  const minimum = values['min-full-row'] === undefined ? null : Number(values['min-full-row']);
  if (minimum !== null && (!Number.isFinite(minimum) || minimum < 0 || minimum > 1)) throw new Error('--min-full-row must be between 0 and 1');
  if (mode === 'vision' && !values['api-base']) throw new Error('--api-base is required for vision; this mode sends reviewed fixture images to that endpoint');
  const saved = mode === 'saved' ? JSON.parse(await readFile(values.predictions, 'utf8')) : null;
  if (saved && (saved.schemaVersion !== 1 || !saved.fixtures || typeof saved.pipeline !== 'string')) throw new Error('Saved predictions require schemaVersion:1, pipeline and fixtures');
  if (saved) for (const id of Object.keys(saved.fixtures)) if (!fixtures.some(f => f.id === id)) throw new Error(`Unknown prediction fixture: ${id}`);
  let pageOcr, customClose, extract = parserAdapter;
  if (mode === 'page-ocr') { pageOcr = await createPageOcrAdapter(); extract = pageOcr.extract; }
  if (mode === 'vision') extract = visionAdapter;
  if (mode === 'custom') { const adapter = await import(pathToFileURL(resolve(values.adapter))); extract = adapter.extract; customClose = adapter.close; if (typeof extract !== 'function') throw new Error('Adapter must export extract({imagePath,signal})'); }
  const results = [], skipped = [], reportFixtures = {};
  try {
    for (const fixture of fixtures) {
      const requiresImage = !['parser', 'saved'].includes(mode);
      if ((requiresImage && !fixture.imagePath) || (mode === 'saved' && fixture.status === 'awaiting-image' && !saved.fixtures[fixture.id]) || (mode === 'parser' && !fixture.ocrPath)) {
        skipped.push({ id: fixture.id, reason: mode !== 'parser' ? 'image unavailable' : 'OCR capture unavailable' }); continue;
      }
      let prediction, error;
      try {
        // Intentionally excludes labels, metadata, tags and fixture id from extractor input.
        prediction = mode === 'saved' ? (saved.fixtures[fixture.id]?.prediction || saved.fixtures[fixture.id]) : await extract({ imagePath: fixture.imagePath, ocrPath: mode === 'parser' ? fixture.ocrPath : undefined, signal: AbortSignal.timeout(120000), apiBase: values['api-base'] });
        if (!prediction || !Array.isArray(prediction.medications)) throw new Error('Missing or malformed prediction');
        scoreFixture(fixture.label.medications, prediction.medications);
      } catch (e) { error = e.message; prediction = { medications: [], source: mode }; }
      const score = scoreFixture(fixture.label.medications, prediction.medications);
      const result = { id: fixture.id, source: fixture.source, tags: fixture.tags, layoutFamily: fixture.layoutFamily, ...score, error: error || null };
      results.push(result);
      reportFixtures[fixture.id] = { ...result, prediction, ocrSha256: fixture.ocrPath ? createHash('sha256').update(await readFile(fixture.ocrPath)).digest('hex') : null, imageSha256: fixture.imagePath ? createHash('sha256').update(await readFile(fixture.imagePath)).digest('hex') : null };
      console.log(`${fixture.id}: ${score.correct.fullRow}/${score.denominator} full rows${error ? ` [ERROR: ${error}]` : ''}`);
    }
  } finally { await pageOcr?.close(); await customClose?.(); }
  const summary = aggregate(results), groups = {};
  for (const tag of tags) { const subset = results.filter(r => r.tags.includes(tag)); groups[tag] = aggregate(subset); }
  const report = { schemaVersion: 1, pipeline: mode === 'saved' ? saved.pipeline : mode, createdAt: new Date().toISOString(),
    datasetSha256: createHash('sha256').update(JSON.stringify(fixtures.map(({ label, ...f }) => ({ id: f.id, label, tags: f.tags })))).digest('hex'),
    coverage: { registered: fixtures.length, evaluated: results.length, skipped, imagesAvailable: fixtures.filter(f => f.imagePath).length, failed: results.filter(r => r.error).length },
    summary, actualSources: [...new Set(Object.values(reportFixtures).map(f => f.prediction.source || 'unknown'))].sort(), byLayout: Object.fromEntries([...new Set(results.map(r => r.layoutFamily))].map(family => [family, aggregate(results.filter(r => r.layoutFamily === family))])), byTag: groups, bySource: Object.fromEntries([...new Set(results.map(r => r.source))].map(source => [source, aggregate(results.filter(r => r.source === source))])), fixtures: reportFixtures };
  console.log(`\nPipeline: ${report.pipeline}; fixtures ${results.length}/${fixtures.length}; images ${report.coverage.imagesAvailable}/${fixtures.length}; failed ${report.coverage.failed}`);
  for (const [field, accuracy] of Object.entries(summary.accuracy)) console.log(`${field} accuracy: ${accuracy === null ? 'N/A' : (accuracy * 100).toFixed(2) + '%'}`);
  console.log(`missing rows: ${summary.missingRows}; extra rows: ${summary.extraRows}`);
  for (const item of skipped) console.log(`SKIPPED ${item.id}: ${item.reason}`);
  if (values.baseline) {
    const baseline = JSON.parse(await readFile(values.baseline, 'utf8'));
    if (baseline.schemaVersion !== 1 || baseline.pipeline !== report.pipeline || baseline.datasetSha256 !== report.datasetSha256 || JSON.stringify(baseline.actualSources) !== JSON.stringify(report.actualSources)) throw new Error('Baseline dataset/pipeline/source mismatch');
    const imageHashes = Object.values(report.fixtures).map(f => [f.id, f.imageSha256, f.ocrSha256]);
    if (JSON.stringify(imageHashes) !== JSON.stringify(Object.values(baseline.fixtures).map(f => [f.id, f.imageSha256, f.ocrSha256]))) throw new Error('Baseline image/coverage mismatch');
    report.regressions = Object.keys(summary.accuracy).filter(f => baseline.summary.accuracy[f] !== null && (summary.accuracy[f] === null || summary.accuracy[f] + 1e-12 < baseline.summary.accuracy[f]));
    if (report.regressions.length) { console.error(`REGRESSION: ${report.regressions.join(', ')}`); process.exitCode = 1; }
  }
  if (values.output) { await mkdir(dirname(resolve(values.output)), { recursive: true }); await writeFile(values.output, JSON.stringify(report, null, 2) + '\n'); }
  if (!results.length || report.coverage.failed || (values['require-images'] && report.coverage.imagesAvailable !== fixtures.length) || (minimum !== null && (summary.accuracy.fullRow === null || summary.accuracy.fullRow < minimum))) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
