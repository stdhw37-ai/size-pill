import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDrugName, parsePrescriptionWords, parsePrescriptionText, ocrWords, prescriptionSummary } from '../public/prescription-parser.js';
const expected = [
  { code: '644913501', rawName: '듀파락-이지시럽/15mL/포', drugName: '듀파락-이지시럽', prescribedUnit: '15mL/포', dosePerAdministration: 1, frequencyPerDay: 3, durationDays: 10 },
  { code: '649401610', rawName: '에도스캡슐/1캡슐', drugName: '에도스캡슐', prescribedUnit: '1캡슐', dosePerAdministration: 1, frequencyPerDay: 2, durationDays: 60 },
  { code: '650202970', rawName: '애니코프캡슐300mg/1캡슐', drugName: '애니코프캡슐300mg', prescribedUnit: '1캡슐', dosePerAdministration: 1, frequencyPerDay: 2, durationDays: 60 },
  { code: '642204150', rawName: '셀벡스캡슐(내복)/1캡슐', drugName: '셀벡스캡슐(내복)', prescribedUnit: '1캡슐', dosePerAdministration: 1, frequencyPerDay: 2, durationDays: 60 }
];
const w = (text, x, y, width = 50, confidence = 95) => ({ text, x0: x, x1: x + width, y0: y, y1: y + 16, confidence });
function fixture({ noCode = false, columns = [20, 480, 590, 720], spacing = 40 } = {}) {
  const words = ['처방의약품의 명칭', '1회 투여량', '1일 투여횟수', '총 투약일수'].map((text, i) => w(text, columns[i], 20, i ? 70 : 240));
  expected.forEach((r, i) => {
    const y = 60 + i * spacing;
    words.push(w((noCode ? '' : r.code + ' ') + r.rawName, columns[0], y, 350));
    [r.dosePerAdministration, r.frequencyPerDay, r.durationDays].forEach((v, j) => words.push(w(String(v), columns[j + 1] + 20, y, 20)));
  });
  return words;
}
const essential = r => Object.fromEntries(Object.keys(expected[0]).map(k => [k, r[k]]));
// Minimal fake <canvas> supporting exactly what prescription-ocr.js/prescription-columns.js need
// (getImageData/putImageData/createImageData/drawImage/toDataURL) so PASS 2's cell-crop + vertical
// line detection can run in Node without a real browser. Pixels are uniform (no OCR real content),
// which deterministically means detectVerticalLines finds no lines - fine for orchestration tests,
// which drive OCR results entirely through the mocked worker.recognize(), not real pixel content.
// A real CanvasRenderingContext2D throws on a non-integer/NaN argument ("Value is not of type long")
// - this mock enforces the same, so a bug that leaks NaN/Infinity into a crop/scan region (as row.y
// once did before it was exposed from prescription-parser.js) fails a unit test here, not just a real
// browser (see the PR notes - this exact bug only surfaced in real-browser testing the first time).
function assertLong(...values) { for (const v of values) if (!Number.isInteger(v)) throw new TypeError(`Value is not of type 'long': ${v}`); }
function fakeCanvas(width = 0, height = 0) {
  const canvas = { width, height, toDataURL: () => 'data:fake' };
  canvas.ownerDocument = { createElement: () => fakeCanvas(0, 0) };
  canvas.getContext = () => ({
    getImageData: (sx, sy, sw, sh) => { assertLong(sx, sy, sw, sh); return { data: new Uint8ClampedArray(Math.max(1, sw) * Math.max(1, sh) * 4).fill(200), width: sw, height: sh }; },
    createImageData: (cw, ch) => { assertLong(cw, ch); return { data: new Uint8ClampedArray(Math.max(1, cw) * Math.max(1, ch) * 4), width: cw, height: ch }; },
    putImageData: () => {}, drawImage: () => {}
  });
  return canvas;
}
test('정상 4행: 하이픈·괄호·mg·mL/포·10/60 보존', () => {
  const rows = parsePrescriptionWords(fixture());
  assert.deepEqual(rows.map(essential), expected);
  assert.ok(rows.every(r => !r.needsReview));
  assert.equal(prescriptionSummary(rows[0]), '처방내용: 1포 × 하루 3회 × 10일');
});
test('코드 없는 표와 위치·표 폭·열 순서 변경', () => {
  assert.deepEqual(parsePrescriptionWords(fixture({ noCode: true, columns: [400, 20, 900, 200] })).map(essential), expected.map(r => ({ ...r, code: null })));
});
test('불규칙 공백과 코드 문맥 보정, 원본 토큰 보존', () => {
  const words = fixture(); words[4].text = '6449I35O1 듀 파 락 - 이 지 시 럽 / 15 mL / 포';
  const row = parsePrescriptionWords(words)[0];
  assert.deepEqual(essential(row), expected[0]); assert.equal(row.sourceWords[0].text, words[4].text);
  assert.equal(parseDrugName('OIl시럽40/10mg').drugName, 'OIl시럽40/10mg');
});
test('낮은 field confidence가 평균에 가려지지 않는다', () => {
  const words = fixture(); words[7].confidence = 20;
  const rows = parsePrescriptionWords(words);
  assert.equal(rows[0].needsReview, true); assert.equal(rows[0].fieldConfidence.durationDays, 20);
  assert.equal(rows[1].needsReview, false);
});
test('좌표 없는 fallback은 불확실성을 표시한다', () => {
  const rows = parsePrescriptionText(expected.map(r => `${r.code} ${r.rawName} 1 ${r.frequencyPerDay} ${r.durationDays}`).join('\n'));
  assert.deepEqual(rows.map(essential), expected); assert.ok(rows.every(r => r.needsReview));
});
test('두 줄 약명: 숫자가 마지막 줄, 새 코드는 결합하지 않는다', () => {
  const words = fixture(); words[4].text = '644913501 듀파락-'; words[4].y0 -= 20; words[4].y1 -= 20;
  words.push(w('이지시럽/15mL/포', 20, 60, 220));
  assert.deepEqual(parsePrescriptionWords(words).map(essential), expected);
});
test('두 줄 약명: 숫자가 첫 줄', () => {
  const words = fixture(); words[4].text = '644913501 듀파락-이지시럽'; words.push(w('/15mL/포', 20, 80, 110));
  assert.deepEqual(parsePrescriptionWords(words).map(essential), expected);
});
test('누락 숫자는 이웃 약에서 빌려오지 않는다', () => {
  const words = fixture(); words.splice(7, 1); const rows = parsePrescriptionWords(words);
  assert.equal(rows[0].durationDays, null); assert.equal(rows[0].needsReview, true); assert.equal(rows[1].durationDays, 60);
});
test('Tesseract blocks의 bbox/confidence/line/block 보존', () => {
  const word = { text: '시험정', confidence: 30, bbox: { x0: 1, x1: 40, y0: 2, y1: 20 } };
  assert.deepEqual(ocrWords({ blocks: [{ paragraphs: [{ lines: [{ words: [word] }] }] }] }), [{ text: '시험정', confidence: 30, ...word.bbox, blockId: 0, lineId: '0:0:0' }]);
});

test('분리된 코드 토큰과 잘게 나뉜 헤더도 같은 행에 연결', () => {
  const words = fixture(); words[4].text = expected[0].rawName; words[4].x0 = 130;
  words.push(w(expected[0].code, 20, 60, 95));
  words[1] = w('1회', 480, 20, 24); words.push(w('투여량', 510, 20, 40));
  assert.deepEqual(parsePrescriptionWords(words).map(essential), expected);
});
test('조밀한 행 간격과 좌표의 비례 확대/이동은 연결을 바꾸지 않는다', () => {
  const words = fixture({ spacing: 24 }).map(w => ({ ...w, x0: w.x0 * 1.7 + 233, x1: w.x1 * 1.7 + 233, y0: w.y0 * 1.7 + 177, y1: w.y1 * 1.7 + 177 }));
  assert.deepEqual(parsePrescriptionWords(words).map(essential), expected);
});
test('OCR 첫 표 인식이 완전하면 재인식하지 않고 좌표 출력을 요청한다', async () => {
  const { recognizePrescription } = await import('../public/prescription-ocr.js');
  let calls = 0;
  const worker = { setParameters: async () => {}, recognize: async (image, options, output) => {
    calls++; assert.equal(options.rotateAuto, true); assert.equal(output.blocks, true);
    return { data: { words: fixture() } };
  } };
  assert.deepEqual((await recognizePrescription(worker, {}, new AbortController().signal)).map(essential), expected); assert.equal(calls, 1);
});
test('불완전한 OCR은 sparse/adaptive 재시도, 취소된 작업은 인식하지 않는다', async () => {
  const { recognizePrescription } = await import('../public/prescription-ocr.js');
  let calls = 0; const parameters = [];
  const worker = { setParameters: async p => parameters.push(p), recognize: async () => ({ data: { words: ++calls === 1 ? [] : fixture() } }) };
  assert.deepEqual((await recognizePrescription(worker, {}, new AbortController().signal)).map(essential), expected);
  assert.equal(parameters[1].tessedit_pageseg_mode, '11');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(recognizePrescription(worker, {}, aborted.signal), { name: 'AbortError' }); assert.equal(calls, 2);
});
test('숫자 열이 통째로 비어도 헤더 열 위치로 계산한 개별 cell을 크롭해 0-9 whitelist로 복구한다', async () => {
  // Regression for the real failure mode found against actual Tesseract output: full-page layout
  // analysis can drop the ENTIRE numeric column for a row (not just misread it), so the fixture here
  // mimics that - no dose/frequency/duration words survive OCR at all for row0.
  const { recognizePrescription } = await import('../public/prescription-ocr.js');
  const words = fixture().filter((_, i) => i !== 5 && i !== 6 && i !== 7); // strip row0's 3 number tokens
  const paramCalls = []; const cellCalls = [];
  const canvas = fakeCanvas(2000, 2000);
  const worker = {
    setParameters: async p => paramCalls.push(p),
    recognize: async (image, options, output) => {
      if (output?.blocks) return { data: { words } };
      cellCalls.push(image);
      const answers = ['1', '3', '10']; // dose, frequency, duration - processing order
      return { data: { text: answers[cellCalls.length - 1] ?? '', confidence: 92 } };
    }
  };
  const rows = await recognizePrescription(worker, canvas, new AbortController().signal);
  assert.equal(rows[0].dosePerAdministration, 1);
  assert.equal(rows[0].frequencyPerDay, 3);
  assert.equal(rows[0].durationDays, 10);
  assert.equal(rows[0].fieldConfidence.durationDays, 92);
  assert.equal(cellCalls.length, 3, '3개 필드 각각 독립된 cell을 정확히 한 번씩 크롭한다 (첫 preprocessing 시도가 이미 confident하므로 variant 재시도 없음)');
  assert.ok(paramCalls.some(p => p.tessedit_char_whitelist === '0123456789.'), '숫자 영역은 이름 OCR과 다른 whitelist로 처리한다');
  assert.ok(rows.slice(1).every(r => !r.needsReview), '이미 완전했던 다른 행들은 영향받지 않는다');
});
test('cell 크롭에서 일부 필드만 나와도 나머지는 그대로 두고, 이미 confident한 필드는 덮어쓰지 않는다', async () => {
  const { recognizePrescription } = await import('../public/prescription-ocr.js');
  const words = fixture(); words.splice(7, 1); // row0의 durationDays 토큰 자체가 없음
  const canvas = fakeCanvas(2000, 2000);
  const cellCalls = [];
  const worker = {
    setParameters: async () => {},
    recognize: async (image, options, output) => {
      if (output?.blocks) return { data: { words } };
      cellCalls.push(image);
      return { data: { text: '10', confidence: 92 } }; // >=90 so the first preprocessing variant already stops the retry loop
    }
  };
  const rows = await recognizePrescription(worker, canvas, new AbortController().signal);
  assert.equal(rows[0].dosePerAdministration, 1, '이미 읽혔던 값은 그대로 유지된다');
  assert.equal(rows[0].frequencyPerDay, 3);
  assert.equal(rows[0].durationDays, 10, '누락됐던 값만 크롭 결과로 채워진다');
  assert.equal(cellCalls.length, 1, '이미 confident한 필드는 다시 크롭되지 않는다 - 누락된 필드 1개만 크롭한다');
});
test('cell OCR: 첫 preprocessing variant의 confidence가 낮으면 다른 variant를 더 시도해 가장 높은 confidence를 선택한다', async () => {
  // item 7/8: passthrough(A) 오독("7"), otsu(B) 저confidence, contrast(C) 정답("1")고confidence 순서로
  // mock해 세 variant 모두 시도되고 confidence가 가장 높은 결과가 최종 선택되는지 확인한다.
  const { recognizePrescription } = await import('../public/prescription-ocr.js');
  const words = fixture().filter((_, i) => i !== 5 && i !== 6 && i !== 7); // row0 숫자 3개 전부 결측
  const canvas = fakeCanvas(2000, 2000);
  let variantCall = 0;
  const answers = [
    ['7', 52], ['1', 91],                  // dose: A=오답/저confidence, B=정답/고confidence(>=90) -> B에서 멈춤(2번만 시도)
    ['3', 40], ['8', 45], ['3', 88],        // frequency: A,B 모두 90 미만 -> C까지 시도, 그중 가장 높은 C가 최종 선택
  ];
  const worker = {
    setParameters: async () => {},
    recognize: async (image, options, output) => {
      if (output?.blocks) return { data: { words } };
      const [text, confidence] = answers[variantCall++] ?? ['10', 91]; // duration: 그대로 통과
      return { data: { text, confidence } };
    }
  };
  const rows = await recognizePrescription(worker, canvas, new AbortController().signal);
  assert.equal(rows[0].dosePerAdministration, 1, '가장 높은 confidence(91)를 준 두 번째 variant의 값을 선택한다');
  assert.equal(rows[0].fieldConfidence.dosePerAdministration, 91);
  assert.equal(rows[0].frequencyPerDay, 3, '세 variant 모두 시도한 뒤 그중 가장 높은 confidence(88)의 값을 선택한다');
  assert.equal(rows[0].fieldConfidence.frequencyPerDay, 88);
  assert.equal(variantCall, 2 + 3 + 1, 'dose는 2번째 variant에서 멈추고, frequency는 3번 모두 시도하고, duration은 1번만 시도한다');
});

test('약명 함량 숫자와 mg가 개별 OCR 토큰이어도 투여량으로 빼앗지 않는다', () => {
  const words = fixture(); words[12].text = '650202970 애니코프캡슐'; words[12].x1 = 350;
  words.push(w('300', 360, 140, 25), w('mg/1캡슐', 390, 140, 75));
  assert.deepEqual(parsePrescriptionWords(words).map(essential), expected);
});
test('함량 조합 슬래시와 괄호·하이픈은 검색용 약명에도 보존한다', () => {
  assert.deepEqual(parseDrugName('복합-시험정(내복)40/10mg/1정'), { code: null, rawName: '복합-시험정(내복)40/10mg/1정', drugName: '복합-시험정(내복)40/10mg', prescribedUnit: '1정' });
});
test('정/캡슐/포/병처럼 닫힌 소어휘의 1글자 오인식은 안전하게 보정하지만, 부피 숫자는 절대 추측하지 않는다', () => {
  // "캡슐" -> "캡슬" (실제 Tesseract 테스트에서 재현된 오인식) 같은 1글자 차이는 보정 가능한 닫힌 후보군.
  // 단위 필드뿐 아니라 약 이름 자체의 끝(제품명이 실제로 "...캡슐"로 끝나는 경우)도 같은 근거로 보정한다 -
  // 이름 안 다른 위치의 텍스트는 절대 건드리지 않는다(정/포/병처럼 1글자 후보는 애초에 보정하지 않음).
  assert.deepEqual(parseDrugName('에도스캡슬/1캡슬'), { code: null, rawName: '에도스캡슬/1캡슬', drugName: '에도스캡슐', prescribedUnit: '1캡슐' });
  assert.equal(parseDrugName('셀벡스캡슬(내복)/1캡슐').drugName, '셀벡스캡슐(내복)', '괄호로 된 경로 설명은 보정 대상 뒤에 그대로 유지된다');
  assert.equal(parseDrugName('애니코프캡슬300079/1캡슐').drugName, '애니코프캡슬300079', '캡슐이 이름 끝이 아니면(뒤에 다른 문자가 더 있으면) 보정하지 않는다');
  assert.equal(parseDrugName('셀벡스정/2정').prescribedUnit, '2정');
  // 후보 단어와 전혀 다른(2글자 이상 차이) 텍스트는 보정하지 않고 unitOcrFailed로만 표시한다.
  assert.equal(parseDrugName('시험약/1xyz').unitOcrFailed, true);
  assert.equal(parseDrugName('시험약/1xyz').prescribedUnit, null);
});
test('깨진 단위(예: 15mL→150ㄴ_)는 약명에서 분리되어 검색어를 오염시키지 않는다', () => {
  const broken = parseDrugName('644913501듀파락-이지시럽/150ㄴ_/포');
  assert.equal(broken.drugName, '듀파락-이지시럽');
  // The unreadable volume number is never guessed, but the trailing "/포" itself is an exact regex
  // match (not a guess) - kept as a partial unit so "1포 × 하루 3회 × 10일" still displays correctly.
  assert.equal(broken.prescribedUnit, '포');
  assert.equal(broken.unitOcrFailed, true);
  assert.ok(broken.rawUnitFragment.startsWith('150') && broken.rawUnitFragment.endsWith('/포'), '깨진 원문 조각을 보존한다(가공하지 않음)');
  assert.equal(broken.rawName, '듀파락-이지시럽/150ㄴ_/포'.normalize('NFKC'));
  // A clean-looking combination strength (no junk characters) must never be treated as broken.
  assert.equal(parseDrugName('OIl시럽40/10mg').unitOcrFailed, undefined);
});
test('깨진 단위는 행 전체를 needsReview로 표시하지만 이름·투여정보는 보존한다', () => {
  const words = fixture(); words[4].text = '644913501 듀파락-이지시럽/150ㄴ_/포';
  const rows = parsePrescriptionWords(words);
  assert.equal(rows[0].drugName, '듀파락-이지시럽');
  assert.equal(rows[0].needsReview, true);
  assert.equal(rows[0].dosePerAdministration, 1); assert.equal(rows[0].frequencyPerDay, 3); assert.equal(rows[0].durationDays, 10);
  assert.equal(rows[1].needsReview, false, '다른 행은 영향받지 않는다');
});
test('numericZone은 헤더 열의 실제 좌표와 그 행 자신의 이름 글자 끝을 기준으로 하고, 고정 픽셀을 쓰지 않는다', () => {
  const rows = parsePrescriptionWords(fixture());
  const nameX1 = Math.max(...rows[0].sourceWords.filter(w => w.text === expected[0].code + ' ' + expected[0].rawName).map(w => w.x1));
  const zone = rows[0].numericZone;
  assert.ok(zone.x0 > nameX1, '숫자 영역은 그 행의 이름 텍스트가 끝난 다음부터 시작한다');
  assert.equal(zone.x1, Infinity, '오른쪽 경계는 크롭 시점의 실제 이미지 폭으로 정해진다');
  assert.ok(zone.y0 < rows[0].sourceWords[0].y0 + 1 && zone.y1 > rows[0].sourceWords[0].y0);
  // A moved/rescaled fixture must move the bounds by the same proportion, not stay fixed.
  const scaled = parsePrescriptionWords(fixture().map(word => ({ ...word, x0: word.x0 * 2 + 500, x1: word.x1 * 2 + 500, y0: word.y0, y1: word.y1 })));
  assert.ok(scaled[0].numericZone.x0 > zone.x0);
});
test('헤더 탐지가 실패해도(예: 표 전체가 sparse 처리) numericZone은 그 행 자신의 이름 글자 끝으로 계산된다', () => {
  // No header words at all in this OCR pass - exactly the real failure mode found against actual
  // Tesseract output (see the PR notes: full-page layout analysis can miss the header row entirely).
  const words = fixture().slice(4); // drop the 4 header words, keep only the 4 drug rows
  const rows = parsePrescriptionWords(words);
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.ok(r.numericZone, '헤더 없이도 이름 좌표만으로 numericZone을 계산한다');
    const nameX1 = Math.max(...r.sourceWords.filter(w => !/^\d+(\.\d+)?$/.test(w.text)).map(w => w.x1));
    assert.ok(r.numericZone.x0 > nameX1);
  }
});
test('헤더가 없으면(텍스트 전용 fallback) numericZone도 없다 - 합성 좌표를 실제 캔버스로 착각해 크롭하지 않는다', () => {
  const rows = parsePrescriptionText(expected.map(r => `${r.code} ${r.rawName} 1 ${r.frequencyPerDay} ${r.durationDays}`).join('\n'));
  assert.ok(rows.every(r => r.numericZone === null));
});

// Reproduces the actual failure this PR fixes: this exact fixture (missing header, no numeric tokens
// anywhere, unit text broken the same ways) is what real Tesseract (7.0.0, kor+eng, the vendor build
// this repo ships) returned for a rendered version of the test prescription - captured directly from
// that run, not invented. See the PR notes for the full real-OCR trace this was built from.
test('실제 Tesseract 출력 재현: 헤더·숫자열 전체 소실 + 단위 깨짐에서도 4개 약의 숫자를 전부 복구한다', async () => {
  const { recognizePrescription } = await import('../public/prescription-ocr.js');
  const realistic = [
    w('644913501 듀파락-이지시럽/150[/포', 141, 374, 380),
    w('649401610 에도스캡슬/1캡슬', 141, 420, 300),
    w('650202970 애니코프캡슬300079/1캡슬', 141, 466, 340),
    w('642204150 셀벡스캡슬(내복)/1캡슬', 141, 512, 330),
  ]; // no header words, no numeric tokens - matches the real captured OCR output exactly
  const zoneText = ['1 3 10', '1 2 60', '1 2 60', '1 2 60'];
  let cropCalls = 0;
  const canvas = fakeCanvas(1700, 1000);
  const worker = {
    setParameters: async () => {},
    recognize: async (image, options, output) => output?.blocks
      ? { data: { words: realistic } }
      : { data: { text: zoneText[cropCalls++], confidence: 90 } }
  };
  const rows = await recognizePrescription(worker, canvas, new AbortController().signal);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(r => ({ code: r.code, drugName: r.drugName, prescribedUnit: r.prescribedUnit,
    dosePerAdministration: r.dosePerAdministration, frequencyPerDay: r.frequencyPerDay, durationDays: r.durationDays })), [
    { code: '644913501', drugName: '듀파락-이지시럽', prescribedUnit: '포', dosePerAdministration: 1, frequencyPerDay: 3, durationDays: 10 },
    { code: '649401610', drugName: '에도스캡슐', prescribedUnit: '1캡슐', dosePerAdministration: 1, frequencyPerDay: 2, durationDays: 60 },
    { code: '650202970', drugName: '애니코프캡슬300079', prescribedUnit: '1캡슐', dosePerAdministration: 1, frequencyPerDay: 2, durationDays: 60 },
    { code: '642204150', drugName: '셀벡스캡슐(내복)', prescribedUnit: '1캡슐', dosePerAdministration: 1, frequencyPerDay: 2, durationDays: 60 },
  ]);
  assert.ok(rows.every(r => r.needsReview), '단위/이름이 완전히 깨끗하지 않으므로 확인 대상으로는 계속 표시한다');
  assert.equal(cropCalls, 4, '행마다 정확히 한 번씩만 숫자 영역을 크롭한다');
});
