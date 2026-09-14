// Shared synchronous, DOM-free policy for the classic browser app and Node tests.
// Never changes OCR values or conflates MFDS item_seq with an insurance/EDI code.
(() => {
  const nameOf = m => m.name || m.officialProductName || m.itemName || '';
  const formOf = m => m.dosageForm || m.form || m.permit?.data?.dosageForm || '';
  const packageOf = m => m.permit?.data?.packaging || m.packaging || '';
  const dosageFormLabel = m => formOf(m) || String(m.permit?.data?.description || m.description || '').match(/경질캡슐제?|연질캡슐제?|시럽제|현탁제|액제|정제/)?.[0] || '';
  function normalizeMedicineName(value) {
    return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+\d+(?:\.\d+)?(?:캡슐|정|ml\/포)\s*$/, '').replace(/\s+/g, '')
      .replace(/\((?:내복|경구용?|내용|내복용)\)/g, '')
      .replace(/\/(?:\d+(?:\.\d+)?(?:ml|밀리리터)(?:\/(?:포|병))?|\d+(?:\.\d+)?(?:캡슐|정|포|병))$/, '')
      .replace(/마이크로그램/g, 'mcg').replace(/밀리그램/g, 'mg').replace(/밀리리터/g, 'ml')
      .replace(/[^가-힣a-z0-9./%]/g, '');
  }
  function classifyText(text, name = false) {
    const s = String(text || '').toLowerCase().replace(/\s+/g, '');
    if (/연고|크림|점안|점이|주사|좌제|패치|흡입|외용|가글|겔제|관장|세정|점비|질정|질용|구강분무|ointment|injection/.test(s)) return 'other';
    if (/캡슐|capsule|tablet|solid|정제|필름코팅정|장용정|서방정|^정$/.test(s) || (name && /정(?:$|[\d(.])/.test(s))) return 'solid-oral';
    if (/시럽|현탁|내용액|내복액|용액|점적액|액제|liquid|syrup|^액$/.test(s) || (name && /액(?:$|[\d(])/.test(s))) return 'liquid';
    return 'unknown';
  }
  function classifyMedicineForm(m) {
    const official = classifyText(formOf(m)); if (official === 'solid-oral' || official === 'other') return official;
    if (classifyText(nameOf(m), true) === 'other') return 'other';
    if (official === 'liquid') return official;
    const description = classifyText(m.permit?.data?.description || m.description); if (description !== 'unknown') return description;
    const fallback = classifyText(nameOf(m), true); if (fallback !== 'unknown') return fallback;
    // Official identification dimensions/shape are useful for older cached records without form.
    if (m.shape || (Number.isFinite(m.long ?? m.length) && Number.isFinite(m.short ?? m.width))) return 'solid-oral';
    return 'unknown';
  }
  function classifyLiquidPackaging(m) {
    const s = packageOf(m), pouch = /(?:\d\s*포\b|\d\s*포(?=[,×x\s]|$)|\/\s*포|파우치|스틱|알루미늄\s*호일)/i.test(s), bottle = /병|bottle|보틀/i.test(s);
    if (pouch && bottle) return 'unknown';
    if (bottle) return 'bottle'; if (pouch) return 'pouch';
    if (/앰플|바이알|프리필드|syringe/i.test(s)) return 'other';
    if (/파우치|스틱/.test(nameOf(m))) return 'pouch';
    return 'unknown';
  }
  function getMedicineDestination(m) {
    const medicineForm = classifyMedicineForm(m), liquidPackaging = medicineForm === 'liquid' ? classifyLiquidPackaging(m) : 'unknown';
    return { medicineForm, liquidPackaging, screen: { 'solid-oral': 'pill', liquid: 'liquid', other: 'medicine-info', unknown: 'medicine-info' }[medicineForm],
      cta: { 'solid-oral': '실물크기 보기', liquid: '액체약 가이드 보기', other: '의약품 정보 보기', unknown: '제품 유형 확인 필요' }[medicineForm] };
  }
  function officialDoseUnit(m, recognizedUnit) {
    const type = classifyMedicineForm(m), form = formOf(m), name = nameOf(m);
    if (type === 'solid-oral') {
      const hint = classifyText(form) === 'solid-oral' ? form : name;
      if (/캡슐|capsule/i.test(hint)) return '캡슐';
      if (/정|tablet/i.test(hint)) return '정';
    }
    if (type === 'liquid') {
      // A bottle's package size is not the administered volume. Preserve an explicit mL reading.
      if (/^(ml|밀리리터)$/i.test(recognizedUnit || '')) return 'mL';
      if (classifyLiquidPackaging(m) === 'pouch') return '포';
    }
    return recognizedUnit || null;
  }
  const codes = m => [m.insuranceCode, m.productCode, m.permit?.data?.insuranceCode].flatMap(v => String(v || '').match(/(?<!\d)\d{8,9}(?!\d)/g) || []);
  const strengths = s => s.match(/\d+(?:\.\d+)?(?:mg|mcg|g|ml|iu|%)?/g)?.join('|') || '';
  function strongNameMatch(a, b) {
    a = normalizeMedicineName(a); b = normalizeMedicineName(b);
    if (!a || !b || strengths(a) !== strengths(b) || Math.min(a.length, b.length) < 6) return false;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) { const next = [i]; for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = next; }
    return prev[b.length] <= 1 && 1 - prev[b.length] / Math.max(a.length, b.length) >= .9;
  }
  function matchOfficialMedicine(row, candidates, { complete = true } = {}) {
    const unique = [...new Map(candidates.map(m => [String(m.id), m])).values()];
    const codeMatches = row.productCode ? unique.filter(m => codes(m).includes(row.productCode)) : [];
    const target = normalizeMedicineName(row.drugName);
    // A known conflicting insurance code must not be overridden by an exact/fuzzy name.
    const compatible = unique.filter(m => !row.productCode || !codes(m).length || codes(m).includes(row.productCode));
    const exact = target ? compatible.filter(m => normalizeMedicineName(nameOf(m)) === target) : [];
    const strong = compatible.filter(m => strongNameMatch(row.drugName, nameOf(m)));
    if (codeMatches.length === 1) return { status: 'exact-code', selected: codeMatches[0], candidates: unique };
    if (codeMatches.length > 1) return { status: 'needs-confirmation', selected: null, candidates: codeMatches };
    if (exact.length === 1 && complete) return { status: 'exact-name', selected: exact[0], candidates: unique };
    return { status: !unique.length ? 'not-found' : !exact.length && strong.length === 1 ? 'high-confidence' : 'needs-confirmation', selected: null, candidates: unique };
  }
  globalThis.MedicineFlow = Object.freeze({ normalizeMedicineName, classifyMedicineForm, classifyLiquidPackaging, getMedicineDestination, officialDoseUnit, matchOfficialMedicine, strongNameMatch, nameOf, formOf, packageOf, dosageFormLabel });
})();
