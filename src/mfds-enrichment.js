// Verified official specifications and field mappings: docs/mfds-api.md.
export const SOURCES = {
  permit: { endpoint: 'https://apis.data.go.kr/1471000/DrugPrdtPrmsnInfoService07/getDrugPrdtPrmsnDtlInq06', key: 'serviceKey', id: 'item_seq', responseId: 'ITEM_SEQ' },
  easy: { endpoint: 'https://apis.data.go.kr/1471000/DrbEasyDrugInfoService/getDrbEasyDrugList', key: 'ServiceKey', id: 'itemSeq', responseId: 'itemSeq' }
};
const text = value => String(value ?? '').trim();
export function normalizePermit(row) {
  return {
    id: text(row.ITEM_SEQ), name: text(row.ITEM_NAME), company: text(row.ENTP_NAME),
    ingredients: text(row.MAIN_ITEM_INGR), materials: text(row.MATERIAL_NAME), additives: text(row.INGR_NAME),
    permitDate: text(row.ITEM_PERMIT_DATE), permitKind: text(row.PERMIT_KIND_NAME),
    companyPermitNumber: text(row.ENTP_NO), medicineType: text(row.ETC_OTC_CODE),
    description: text(row.CHART), storage: text(row.STORAGE_METHOD), validity: text(row.VALID_TERM),
    packaging: text(row.PACK_UNIT), manufacturer: text(row.CNSGN_MANUF),
    status: text(row.CANCEL_NAME), cancellationDate: text(row.CANCEL_DATE),
    atcCode: text(row.ATC_CODE), changed: text(row.CHANGE_DATE)
  };
}
export function normalizeEasy(row) {
  return {
    id: text(row.itemSeq), name: text(row.itemName), company: text(row.entpName),
    efficacy: text(row.efcyQesitm), usage: text(row.useMethodQesitm), warning: text(row.atpnWarnQesitm),
    precautions: text(row.atpnQesitm), interactions: text(row.intrcQesitm), sideEffects: text(row.seQesitm),
    storage: text(row.depositMethodQesitm), published: text(row.openDe), updated: text(row.updateDe)
  };
}
async function lookup(kind, id, serviceKey, signal) {
  const source = SOURCES[kind];
  try {
    if (signal.aborted) throw new Error('deadline');
    const url = new URL(source.endpoint);
    url.search = new URLSearchParams({ [source.key]: serviceKey, [source.id]: id, type: 'json', pageNo: '1', numOfRows: '10' });
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) });
    if (!response.ok) throw new Error('upstream');
    const raw = await response.json(), data = raw.response ?? raw;
    if (!['00', '0'].includes(String(data.header?.resultCode))) throw new Error('upstream');
    const total = data.body?.totalCount;
    if (!/^\d+$/.test(String(total))) throw new Error('schema');
    let rows = data.body.items?.item ?? data.body.items ?? [];
    if (rows === '') rows = [];
    if (!Array.isArray(rows)) rows = [rows];
    if (rows.some(row => !row || typeof row !== 'object' || !text(row[source.responseId]))) throw new Error('schema');
    if (Number(total) === 0 && rows.length === 0) return { status: 'not_found', data: null };
    // Never join by similar product names or accept a different item code.
    const matches = rows.filter(row => text(row[source.responseId]) === id);
    if (matches.length !== 1 || Number(total) !== rows.length) return { status: 'unmatched', data: null };
    return { status: 'ok', data: kind === 'permit' ? normalizePermit(matches[0]) : normalizeEasy(matches[0]) };
  } catch {
    // Do not return upstream exceptions: URLs may contain credentials.
    return { status: 'error', data: null };
  }
}
export async function enrichMedicines(items, serviceKey) {
  const signal = AbortSignal.timeout(12000);
  let cursor = 0;
  const output = new Array(items.length);
  // Four products at once; shared deadline prevents a slow source blocking search indefinitely.
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++, item = items[index];
      const [permit, easy] = await Promise.all([lookup('permit', item.id, serviceKey, signal), lookup('easy', item.id, serviceKey, signal)]);
      output[index] = { ...item, permit, easy };
    }
  }));
  return output;
}
