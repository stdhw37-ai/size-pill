// DUR(의약품안전사용서비스) 품목정보 - 용량주의/투여기간주의. 공공데이터포털(data.go.kr/data/15059486)의
// swaggerJson을 2026-09-14에 직접 확인해 엔드포인트·응답 필드를 그대로 옮겼다:
// host apis.data.go.kr/1471000/DURPrdlstInfoService03, path getCpctyAtentInfoList03(용량주의)/
// getMdctnPdAtentInfoList03(투여기간주의). 이 swagger는 요청 파라미터를 문서화하지 않아 이름은 같은
// 계열 API(e약은요 DrbEasyDrugInfoService)의 camelCase 관례를 따라 itemSeq로 연결했다 - 아래 실제 확인
// 결과 때문에 이 값 자체를 운영 트래픽으로 검증하지는 못했다.
//
// 실제 연결 확인(2026-09-14, 기존 MFDS_SERVICE_KEY 그대로, 새 키 발급 없음): 이미 사용 중인 낱알식별/
// 제품허가정보/e약은요는 정상 응답하는 동일 키로 이 DUR API를 호출하면 매 요청 HTTP 403 +
// `{"OpenAPI_ServiceResponse":{"cmmMsgHeader":{"errMsg":"SERVICE_KEY_IS_NOT_REGISTERED_ERROR","returnReasonCode":"30"}}}`
// 를 받았다 - 공공데이터포털에서 이 API는 개별 활용신청이 별도로 필요한데 아직 승인되어 있지 않다는
// 뜻이다(다른 DUR 하위 API도 동일). 그래서 이 파일은 "새 키를 전제하지 않고" 나머지 API와 동일한 방식
// 으로 실제 연결 코드를 준비해 두되, 이 특정 오류(계정 등록 문제)는 절대 'error'(일시적 장애)로 위장
// 하지 않고 'unavailable'로 명확히 구분해 반환한다 - 호출부가 "DUR 연동이 아직 승인되지 않았다"와
// "지금 이 요청이 실패했다"를 서로 다른 안내 문구로 보여줄 수 있게 하기 위해서다.
export const DUR_SOURCES = {
  capacity: { endpoint: 'https://apis.data.go.kr/1471000/DURPrdlstInfoService03/getCpctyAtentInfoList03', label: '용량주의' },
  period: { endpoint: 'https://apis.data.go.kr/1471000/DURPrdlstInfoService03/getMdctnPdAtentInfoList03', label: '투여기간주의' }
};
const text = value => String(value ?? '').trim();
function normalizeDurItem(row) {
  return {
    ingredientName: text(row.INGR_NAME), ingredientCode: text(row.INGR_CODE), mixType: text(row.MIX_TYPE),
    itemSeq: text(row.ITEM_SEQ), itemName: text(row.ITEM_NAME), company: text(row.ENTP_NAME),
    mainIngredient: text(row.MAIN_INGR), content: text(row.PROHBT_CONTENT), remark: text(row.REMARK),
    notificationDate: text(row.NOTIFICATION_DATE), changed: text(row.CHANGE_DATE)
  };
}
export async function lookupDur(kind, itemSeq, serviceKey, signal) {
  const source = DUR_SOURCES[kind];
  try {
    if (signal.aborted) throw new Error('deadline');
    const url = new URL(source.endpoint);
    url.search = new URLSearchParams({ serviceKey, itemSeq, type: 'json', pageNo: '1', numOfRows: '20' });
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) });
    const raw = await response.json().catch(() => null);
    // 공공데이터포털은 서비스키/활용신청 문제를 200이 아니라 이 고정 형태(+ 대개 403)로 알린다 - 응답
    // 스키마 검증(resultCode 등)보다 먼저 확인해서 "장애"가 아니라 "미등록"임을 구분한다.
    if (raw?.OpenAPI_ServiceResponse?.cmmMsgHeader) return { status: 'unavailable', data: [] };
    if (!response.ok) throw new Error('upstream');
    const data = raw?.response ?? raw;
    if (!['00', '0'].includes(String(data?.header?.resultCode))) throw new Error('upstream');
    const total = data.body?.totalCount;
    if (!/^\d+$/.test(String(total))) throw new Error('schema');
    let rows = data.body.items?.item ?? data.body.items ?? [];
    if (rows === '') rows = [];
    if (!Array.isArray(rows)) rows = [rows];
    if (rows.some(row => !row || typeof row !== 'object')) throw new Error('schema');
    // 이 API는 permit/easy와 달리 한 품목에 여러 성분/문구가 있을 수 있어 "정확히 1건"을 요구하지 않고,
    // ITEM_SEQ가 실제로 일치하는 행만 남긴다(다른 품목 결과 혼입 방지).
    return { status: 'ok', data: rows.filter(row => text(row.ITEM_SEQ) === itemSeq).map(normalizeDurItem) };
  } catch {
    // 원본 예외를 그대로 반환하지 않는다: URL에 인증키가 포함될 수 있다.
    return { status: 'error', data: [] };
  }
}
export async function lookupDurAll(itemSeq, serviceKey, signal) {
  const [capacity, period] = await Promise.all([
    lookupDur('capacity', itemSeq, serviceKey, signal), lookupDur('period', itemSeq, serviceKey, signal)
  ]);
  return { capacity, period };
}
