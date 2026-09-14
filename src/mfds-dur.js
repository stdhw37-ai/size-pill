// DUR(의약품안전사용서비스) 품목정보 - 용량주의/투여기간주의. 공공데이터포털(data.go.kr/data/15059486)의
// swaggerJson을 확인해 엔드포인트·응답 필드를 그대로 옮겼다: host
// apis.data.go.kr/1471000/DURPrdlstInfoService03, path getCpctyAtentInfoList03(용량주의)/
// getMdctnPdAtentInfoList03(투여기간주의).
//
// 활용신청 이력(그대로 남겨둠 - 같은 문제가 재발하면 참고):
// - 2026-09-14 최초 연결 시도: 기존 MFDS_SERVICE_KEY(낱알식별/제품허가정보/e약은요에는 이미 등록된 키)로
//   이 DUR API를 호출하면 매 요청 HTTP 403 + `SERVICE_KEY_IS_NOT_REGISTERED_ERROR`(reasonCode 30) -
//   공공데이터포털에서 DUR API는 별도 활용신청이 필요했고 당시 승인 전이었다.
// - 2026-09-14(활용신청 완료 후) 재확인: 새 키 발급 없이 같은 MFDS_SERVICE_KEY로 재호출한 결과 HTTP 200 +
//   `{"header":{"resultCode":"00","resultMsg":"NORMAL SERVICE."}}` - 승인이 반영되었다. itemSeq 없이
//   호출하면 getCpctyAtentInfoList03만 totalCount 6618건이 잡히고, 실제 품목(예: ITEM_SEQ=198600630)으로
//   필터하면 정확히 그 품목 1건만 돌아오는 것도 확인해 파라미터 이름(itemSeq, camelCase)이 맞다는 것도
//   검증했다. PROHBT_CONTENT/REMARK는 오래된 품목은 비어 있고 최근 갱신된 품목에는 실제 텍스트(예:
//   복합제 1일 최대 성분량, 특정 적응증 한정 문구)가 들어있다 - 항상 채워지는 필드가 아니다.
// - 활용신청이 아직 반영되지 않은 계정에서는 지금도 SERVICE_KEY_IS_NOT_REGISTERED_ERROR가 나올 수 있다 -
//   이때 키가 잘못됐다고 단정하지 않고 'pending-or-unavailable'로만 구분해서 반환한다(아래 참고).
export const DUR_SOURCES = {
  capacity: { endpoint: 'https://apis.data.go.kr/1471000/DURPrdlstInfoService03/getCpctyAtentInfoList03', label: '용량주의' },
  period: { endpoint: 'https://apis.data.go.kr/1471000/DURPrdlstInfoService03/getMdctnPdAtentInfoList03', label: '투여기간주의' },
  // 아래 둘은 capacity/period와 동일한 응답 스키마(ITEM_SEQ/PROHBT_CONTENT 등)를 swagger에서 확인했다 -
  // lookupDur()로 그대로 호출 가능하지만, 이번 용량 분석 화면의 핵심(용량주의+투여기간주의)에는 포함하지
  // 않았다(요청 범위) - 필요해지면 lookupDurAll에 추가하기만 하면 된다.
  ageTaboo: { endpoint: 'https://apis.data.go.kr/1471000/DURPrdlstInfoService03/getSpcifyAgrdeTabooInfoList03', label: '특정연령대금기' },
  pregnancyTaboo: { endpoint: 'https://apis.data.go.kr/1471000/DURPrdlstInfoService03/getPwnmTabooInfoList03', label: '임부금기' }
  // 다음 세 endpoint는 swagger 확인 결과 응답 스키마가 다르다(예: getEfcyDplctInfoList03은 ITEM_SEQ가
  // 아니라 DUR_SEQ/EFFECT_NAME 기준, getUsjntTabooInfoList03은 두 성분 쌍을 비교하는 병용금기라 품목
  // 하나만으로 조회할 수 없다) - 아래 normalizeDurItem을 그대로 쓸 수 없어 별도 정규화가 필요하므로
  // 이번에는 연결하지 않고 실제 확인한 경로만 남겨둔다:
  // 노인주의 getOdsnAtentInfoList03, 효능군중복주의 getEfcyDplctInfoList03,
  // 서방정분할주의 getSeobangjeongPartitnAtentInfoList03, 병용금기 getUsjntTabooInfoList03
  // (모두 host는 위와 동일한 DURPrdlstInfoService03)
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
// 상태 4종 (요청 3): 'available'(정상 응답 + 이 품목에 실제 데이터 있음), 'no-data'(정상 응답이지만 이
// 품목엔 해당 DUR 항목 없음 - 데이터가 없다는 것도 유효한 결과), 'pending-or-unavailable'(활용신청 미반영/
// 이 API 자체를 아직 쓸 수 없음 - 장애가 아니라 등록 상태 문제), 'error'(실제 요청/응답 오류).
export async function lookupDur(kind, itemSeq, serviceKey, signal) {
  const source = DUR_SOURCES[kind];
  try {
    if (signal.aborted) throw new Error('deadline');
    const url = new URL(source.endpoint);
    url.search = new URLSearchParams({ serviceKey, itemSeq, type: 'json', pageNo: '1', numOfRows: '20' });
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]) });
    const raw = await response.json().catch(() => null);
    // 공공데이터포털은 서비스키/활용신청 문제를 200이 아니라 이 고정 형태(+ 대개 403)로 알린다 - 응답
    // 스키마 검증(resultCode 등)보다 먼저 확인해서 "장애"가 아니라 "미승인/미반영"임을 구분한다. 키가
    // 틀렸다고 단정하지 않는다 - 다른 MFDS API들은 같은 키로 정상 동작하므로 키 자체의 문제가 아니다.
    if (raw?.OpenAPI_ServiceResponse?.cmmMsgHeader) return { status: 'pending-or-unavailable', data: [] };
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
    // ITEM_SEQ가 실제로 일치하는 행만 남긴다(다른 품목 결과 혼입 방지 - 요청 4의 정확 일치 원칙).
    const matched = rows.filter(row => text(row.ITEM_SEQ) === itemSeq).map(normalizeDurItem);
    return { status: matched.length ? 'available' : 'no-data', data: matched };
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
