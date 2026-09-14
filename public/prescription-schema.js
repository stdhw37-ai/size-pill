// Canonical prescription-medication shape shared by EVERY extraction path (vision primary, legacy
// on-device OCR fallback) and by the Worker's own response validation before it ever reaches the
// client. Pure, no DOM/browser globals - the Cloudflare Worker imports this file directly too, so it
// must run in both environments unchanged.
export const numericFields = ['dosePerAdministration', 'frequencyPerDay', 'durationDays'];
// Generous, non-clinical plausibility bounds - this is a data-quality guard against OCR/vision
// artifacts (e.g. three columns "1 3 10" merging into "19110"), never a medical judgement about what
// dose is "reasonable" for a given drug. Anything outside these is presumed to be a misread, not a
// real prescription value, and is nulled out + flagged rather than shown as-is (item 6 of the request).
const PLAUSIBLE_MAX = { dosePerAdministration: 100, frequencyPerDay: 10, durationDays: 365 };
const confidenceKey = { dosePerAdministration: 'dose', frequencyPerDay: 'frequency', durationDays: 'duration' };

const clamp01 = value => { const n = Number(value); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; };

// Every medication object - from a vision provider's raw JSON, from the legacy OCR adapter, or from
// a user's manual edit - passes through here before the app trusts it. Never fabricates a value:
// a field that fails the plausibility check becomes null, not a clamped/rounded guess.
export function clampMedication(raw) {
  const rawConfidence = raw?.confidence || {};
  const med = {
    productCode: raw?.productCode ? String(raw.productCode).trim() || null : null,
    rawName: raw?.rawName != null && String(raw.rawName).trim() ? String(raw.rawName) : (raw?.drugName != null ? String(raw.drugName) : ''),
    drugName: raw?.drugName != null ? String(raw.drugName).trim() : '',
    strengthOrPackage: raw?.strengthOrPackage ? String(raw.strengthOrPackage).trim() : null,
    doseUnit: raw?.doseUnit ? String(raw.doseUnit).trim() : null,
    dosePerAdministration: null, frequencyPerDay: null, durationDays: null,
    confidence: {
      productCode: clamp01(rawConfidence.productCode), drugName: clamp01(rawConfidence.drugName),
      dose: clamp01(rawConfidence.dose), frequency: clamp01(rawConfidence.frequency), duration: clamp01(rawConfidence.duration)
    },
    needsReview: false
  };
  for (const field of numericFields) {
    const present = raw?.[field] != null && raw[field] !== '';
    const n = Number(raw?.[field]);
    if (present && Number.isFinite(n) && n > 0 && n <= PLAUSIBLE_MAX[field]) { med[field] = n; continue; }
    if (present) {
      // A value WAS returned but looks like an extraction artifact, not a real prescription number -
      // flagged as an uncertain READING, never phrased as a medical verdict on the dose itself.
      med.needsReview = true; med.confidence[confidenceKey[field]] = Math.min(med.confidence[confidenceKey[field]], .2);
    }
  }
  if (!med.drugName) med.needsReview = true;
  if (Object.values(med.confidence).some(c => c < .7)) med.needsReview = true;
  return med;
}

// Converts a row from prescription-parser.js's parsePrescriptionWords() into this file's raw
// medication shape (see clampMedication above). The row shape itself is engine-agnostic - it only
// depends on the WORD ARRAY handed to parsePrescriptionWords, never on which OCR engine produced
// those words - so this one function is shared by every word-based path: the legacy on-device
// Tesseract adapter (public/prescription-extractor.js) and the server-side Google Vision adapter
// (src/prescription-vision.js). Neither prescription-parser.js itself nor this mapping is provider-
// specific.
export function parsedRowToRaw(row) {
  return {
    productCode: row.code,
    // row.rawName (from parseDrugName) is already the code-stripped name+unit text with no
    // dose/frequency/duration mixed in - row.rawText joins EVERY word array on the row (code AND all
    // three numeric columns included) and must never be used here instead.
    rawName: row.rawName || row.rawText,
    drugName: row.drugName,
    strengthOrPackage: row.prescribedUnit,
    doseUnit: row.prescribedUnit?.match(/mL|캡슐|정|포|병/)?.[0] || null,
    dosePerAdministration: row.dosePerAdministration,
    frequencyPerDay: row.frequencyPerDay,
    durationDays: row.durationDays,
    confidence: {
      productCode: (row.fieldConfidence?.drugName ?? 0) / 100,
      drugName: (row.fieldConfidence?.drugName ?? 0) / 100,
      dose: (row.fieldConfidence?.dosePerAdministration ?? 0) / 100,
      frequency: (row.fieldConfidence?.frequencyPerDay ?? 0) / 100,
      duration: (row.fieldConfidence?.durationDays ?? 0) / 100
    }
  };
}

export function medicationSummary(med) {
  const dose = med.dosePerAdministration != null ? `${med.dosePerAdministration}${med.doseUnit || ''}` : '?';
  const freq = med.frequencyPerDay != null ? med.frequencyPerDay : '?';
  const dur = med.durationDays != null ? med.durationDays : '?';
  return `처방내용: ${dose} × 하루 ${freq}회 × ${dur}일`;
}
