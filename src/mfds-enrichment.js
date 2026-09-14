// Verified official specifications and field mappings: docs/mfds-api.md.
export const SOURCES = {
  permit: { endpoint: 'https://apis.data.go.kr/1471000/DrugPrdtPrmsnInfoService07/getDrugPrdtPrmsnDtlInq06', key: 'serviceKey', id: 'item_seq', responseId: 'ITEM_SEQ' },
  easy: { endpoint: 'https://apis.data.go.kr/1471000/DrbEasyDrugInfoService/getDrbEasyDrugList', key: 'ServiceKey', id: 'itemSeq', responseId: 'itemSeq' }
};
const text = value => String(value ?? '').trim();
// 공식 허가사항 원문(PDF) 링크 - EE/UD/NB_DOC_ID는 nedrug.mfds.go.kr(의약품안전나라)의 실제 첨부문서
// 다운로드 주소다(요청 3: "공식 허가사항 원문 표시"). 다른 필드처럼 신뢰할 수 있는 도메인만 허용한다 -
// 값 자체는 대문자 스킴/호스트로 오지만 new URL()이 정규화하므로 별도 처리는 필요 없다.
function docUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    if (url.hostname !== 'nedrug.mfds.go.kr') return '';
    return url.href;
  } catch { return ''; }
}
export function normalizePermit(row) {
  return {
    id: text(row.ITEM_SEQ), name: text(row.ITEM_NAME), company: text(row.ENTP_NAME),
    ingredients: text(row.MAIN_ITEM_INGR), materials: text(row.MATERIAL_NAME), additives: text(row.INGR_NAME),
    permitDate: text(row.ITEM_PERMIT_DATE), permitKind: text(row.PERMIT_KIND_NAME),
    companyPermitNumber: text(row.ENTP_NO), medicineType: text(row.ETC_OTC_CODE),
    description: text(row.CHART), storage: text(row.STORAGE_METHOD), validity: text(row.VALID_TERM),
    packaging: text(row.PACK_UNIT), manufacturer: text(row.CNSGN_MANUF),
    status: text(row.CANCEL_NAME), cancellationDate: text(row.CANCEL_DATE),
    atcCode: text(row.ATC_CODE), changed: text(row.CHANGE_DATE),
    // EE: 효능효과/용법용량, UD: 사용상주의사항, NB: 전체 첨부문서(가장 포괄적인 "허가사항 원문").
    efficacyDocUrl: docUrl(row.EE_DOC_ID), precautionDocUrl: docUrl(row.UD_DOC_ID), officialDocUrl: docUrl(row.NB_DOC_ID)
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
export async function lookup(kind, id, serviceKey, signal) {
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
