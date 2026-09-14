// Pure scoring. Labels are never passed to an extractor. Dose values never participate in alignment.
export const fields = ['productCode', 'rawName', 'drugName', 'dosePerAdministration', 'doseUnit', 'frequencyPerDay', 'durationDays'];
const text = value => typeof value === 'string' ? value.normalize('NFC').trim() : value;
const equal = (a, b) => a !== undefined && b !== undefined && text(a) === text(b);
export function nameSimilarity(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return 0;
  a = text(a); b = text(b);
  if (a === b) return a ? 1 : 0;
  // Only one letter edit in a sufficiently long name. Strength digits and punctuation must match.
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1 || a.replace(/[가-힣A-Za-z]/g, '') !== b.replace(/[가-힣A-Za-z]/g, '')) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = next;
  }
  const distance = previous[b.length], similarity = 1 - distance / Math.max(a.length, b.length);
  return distance <= 1 && similarity >= .9 ? similarity : 0;
}
// Maximum-weight bipartite assignment (Hungarian); dummy nodes permit missing/extra rows.
function assign(weights) {
  const n = weights.length, u = Array(n + 1).fill(0), v = [...u], p = [...u], way = [...u];
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0; const min = Array(n + 1).fill(Infinity), used = Array(n + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) if (!used[j]) {
        const cost = -weights[i0 - 1][j - 1] - u[i0] - v[j];
        if (cost < min[j]) { min[j] = cost; way[j] = j0; }
        if (min[j] < delta) { delta = min[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else min[j] -= delta; }
      j0 = j1;
    } while (p[j0]);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  return p.slice(1).map((i, j) => [i - 1, j]);
}
export function scoreFixture(expected, predicted) {
  if (!Array.isArray(predicted) || predicted.some(p => !p || typeof p !== 'object' || Array.isArray(p))) throw new Error('Prediction must be an array of medication objects');
  const size = expected.length + predicted.length;
  const weights = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => {
    if (i >= expected.length || j >= predicted.length) return 0;
    const e = expected[i], p = predicted[j], sameCode = !!e.productCode && equal(e.productCode, p.productCode), similarity = nameSimilarity(e.drugName, p.drugName);
    const score = (sameCode ? 100 : 0) + (similarity === 1 ? 80 : similarity ? 50 * similarity : 0);
    return score ? score - Math.abs(i - j) / (size + 1) / 100 : 0;
  }));
  const pairs = assign(weights).filter(([i, j]) => i < expected.length && j < predicted.length && weights[i][j] > 0);
  const matches = new Map(pairs), used = new Set(pairs.map(([, j]) => j));
  const extras = predicted.map((_, j) => j).filter(j => !used.has(j));
  const correct = Object.fromEntries([...fields, 'drugNameFuzzy', 'fullRow'].map(f => [f, 0]));
  const rows = expected.map((e, i) => {
    const j = matches.get(i), p = j === undefined ? undefined : predicted[j];
    const checks = Object.fromEntries(fields.map(f => [f, !!p && equal(e[f], p[f])]));
    for (const f of fields) if (checks[f]) correct[f]++;
    if (p && nameSimilarity(e.drugName, p.drugName)) correct.drugNameFuzzy++;
    const full = Object.values(checks).every(Boolean); if (full) correct.fullRow++;
    return { expectedIndex: i, predictedIndex: j ?? null, checks, fullRow: full };
  });
  return { expectedRows: expected.length, predictedRows: predicted.length, matchedRows: pairs.length, missingRows: expected.length - pairs.length,
    extraRows: extras.length, denominator: expected.length + extras.length, correct, rows, extraIndices: extras };
}
export function aggregate(results) {
  const total = { fixtures: results.length, expectedRows: 0, predictedRows: 0, matchedRows: 0, missingRows: 0, extraRows: 0, denominator: 0, correct: Object.fromEntries([...fields, 'drugNameFuzzy', 'fullRow'].map(f => [f, 0])) };
  for (const r of results) {
    for (const key of ['expectedRows', 'predictedRows', 'matchedRows', 'missingRows', 'extraRows', 'denominator']) total[key] += r[key];
    for (const f of Object.keys(total.correct)) total.correct[f] += r.correct[f];
  }
  total.accuracy = Object.fromEntries(Object.entries(total.correct).map(([f, n]) => [f, total.denominator ? n / total.denominator : null]));
  return total;
}
