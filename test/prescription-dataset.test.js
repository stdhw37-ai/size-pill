import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { scoreFixture, aggregate, nameSimilarity } from '../scripts/prescriptions/evaluate.mjs';
import { loadDataset, validateLabels, tags, localPath } from '../scripts/prescriptions/dataset.mjs';
import { parserAdapter } from '../scripts/prescriptions/adapters.mjs';
const root = new URL('./fixtures/prescriptions/', import.meta.url).pathname;
const row = { productCode: '123456789', rawName: '가상알파정/1정', drugName: '가상알파정', dosePerAdministration: .5, doseUnit: '정', frequencyPerDay: 2, durationDays: 60 };

test('dataset: every fixture validates, all requested types exist, original image absence is explicit', async () => {
  const { fixtures } = await loadDataset(root);
  assert.ok(fixtures.length >= 9);
  for (const tag of tags) assert.ok(fixtures.some(f => f.tags.includes(tag)), tag);
  assert.ok(fixtures.filter(f => f.imagePath).length >= 8);
  const reference = fixtures.find(f => f.id === 'current-reference');
  assert.equal(reference.status, reference.imagePath ? 'ready' : 'awaiting-image'); assert.equal(reference.label.medications.length, 4);
  assert.equal(reference.label.medications[0].doseUnit, '포');
});
test('whole fixture parser regression uses separate stored labels and independent OCR inputs', async () => {
  const { fixtures } = await loadDataset(root), scores = [];
  for (const f of fixtures.filter(f => f.ocrPath)) { const output = await parserAdapter({ ocrPath: f.ocrPath }); scores.push(scoreFixture(f.label.medications, output.medications)); }
  const summary = aggregate(scores);
  assert.equal(summary.expectedRows, fixtures.filter(f => f.ocrPath).reduce((n, f) => n + f.label.medications.length, 0)); assert.equal(summary.accuracy.fullRow, 1);
});
test('row reordering does not change scores', () => {
  const second = { ...row, productCode: '987654321', rawName: '가상베타정/1정', drugName: '가상베타정', durationDays: 10 };
  assert.equal(scoreFixture([row, second], [second, row]).correct.fullRow, 2);
});
test('numeric strings, decimal rounding and wrong column values never fuzzy-match', () => {
  const result = scoreFixture([row], [{ ...row, dosePerAdministration: '0.5', frequencyPerDay: 3, durationDays: 6 }]);
  assert.equal(result.correct.dosePerAdministration, 0); assert.equal(result.correct.frequencyPerDay, 0); assert.equal(result.correct.durationDays, 0); assert.equal(result.correct.fullRow, 0);
});
test('wrong code is scored as an error even when the exact name identifies the row', () => {
  const result = scoreFixture([row], [{ ...row, productCode: '123456788' }]);
  assert.equal(result.matchedRows, 1); assert.equal(result.correct.productCode, 0); assert.equal(result.correct.dosePerAdministration, 1);
});
test('limited name fuzzy matching is diagnostic only; strength and punctuation remain exact', () => {
  assert.ok(nameSimilarity('가상아주긴시험약이름캡슐', '가상아주긴시험약이름캡슬') > .9);
  assert.equal(nameSimilarity('가상아주긴시험약10mg', '가상아주긴시험약11mg'), 0);
  assert.equal(nameSimilarity('가상-아주긴시험약캡슐', '가상아주긴시험약캡슐'), 0);
  assert.equal(nameSimilarity('시험정', '시헙정'), 0);
  const expected = { ...row, drugName: '가상아주긴시험약이름캡슐' };
  const score = scoreFixture([expected], [{ ...expected, drugName: '가상아주긴시험약이름캡슬' }]);
  assert.equal(score.correct.drugName, 0); assert.equal(score.correct.drugNameFuzzy, 1); assert.equal(score.correct.fullRow, 0);
});
test('missing, duplicate and spurious rows are penalized, empty datasets do not score 100%', () => {
  assert.equal(scoreFixture([row], []).denominator, 1);
  assert.equal(scoreFixture([row], [row, row]).denominator, 2);
  assert.equal(aggregate([scoreFixture([row], [row, row])]).accuracy.fullRow, .5);
  assert.equal(aggregate([]).accuracy.fullRow, null);
  assert.equal(scoreFixture([], [row]).extraRows, 1);
});
test('repeated identical identities use occurrence order, never dosage to optimize matching', () => {
  const b = { ...row, durationDays: 10 };
  assert.equal(scoreFixture([row, b], [b, row]).correct.fullRow, 0);
});
test('unknown null code is valid; omitted prediction fields are errors', () => {
  const e = { ...row, productCode: null }, p = { ...e }; delete p.productCode;
  assert.equal(scoreFixture([e], [e]).correct.productCode, 1);
  assert.equal(scoreFixture([e], [p]).correct.productCode, 0);
  assert.throws(() => validateLabels({ schemaVersion: 1, medications: [{ ...row, dosePerAdministration: '0.5' }] }));
});
test('label text and doseUnit participate in strict full row accuracy', () => {
  const score = scoreFixture([row], [{ ...row, rawName: 'wrong', doseUnit: 'mL' }]);
  assert.equal(score.correct.drugName, 1); assert.equal(score.correct.fullRow, 0);
});
test('dataset paths cannot traverse outside the fixture root', async () => {
  await assert.rejects(localPath(root, '../../../ui.test.js'));
});
test('CLI evaluates all fixtures and fails for missing predictions, bad thresholds and image coverage', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'rx-eval-test-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const path = join(temp, 'missing.json'); await writeFile(path, JSON.stringify({ schemaVersion: 1, pipeline: 'empty-test', fixtures: {} }));
  const run = args => spawnSync(process.execPath, ['scripts/prescriptions/run.mjs', ...args], { encoding: 'utf8' });
  assert.equal(run(['--mode', 'parser', '--min-full-row', '1']).status, 0);
  const missing = run(['--predictions', path]); assert.equal(missing.status, 1); assert.match(missing.stdout, new RegExp(`failed ${(await loadDataset(root)).fixtures.filter(f => f.status === 'ready').length}`));
  assert.equal(run(['--min-full-row', 'NaN']).status, 1);
  assert.equal(run(['--require-images']).status, (await loadDataset(root)).fixtures.some(f => !f.imagePath) ? 1 : 0);
});

test('saved pipeline output can be replayed and compared to a baseline without reading images', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'rx-baseline-test-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const baseline = join(temp, 'baseline.json'), changed = join(temp, 'changed.json');
  const run = args => spawnSync(process.execPath, ['scripts/prescriptions/run.mjs', ...args], { encoding: 'utf8' });
  assert.equal(run(['--output', baseline]).status, 0);
  assert.equal(run(['--predictions', baseline, '--baseline', baseline]).status, 0);
  const { readFile } = await import('node:fs/promises');
  const report = JSON.parse(await readFile(baseline, 'utf8'));
  report.fixtures['current-reference'].prediction.medications[0].frequencyPerDay = 4;
  await writeFile(changed, JSON.stringify(report));
  const result = run(['--predictions', changed, '--baseline', baseline]);
  assert.equal(result.status, 1); assert.match(result.stderr, /REGRESSION:.*frequencyPerDay/);
});
