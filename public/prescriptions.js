// 처방전 분석 결과 저장/조회 - public/auth.js와 같은 방식(SDK 없이 PostgREST에 anon/publishable 키 +
// 로그인한 사용자 자신의 access token만으로 직접 접근, RLS가 본인 행만 허용)이다. 원본 이미지나 OCR 전체
// 문장은 절대 다루지 않는다 - 여기서 주고받는 건 화면에 이미 보이는 최소 구조화 필드뿐이다(요청 1).
// 다시 열 때(app.js의 reopenPrescription)는 이 모듈이 돌려준 item_seq로 기존 /api/medicines·/api/liquids
// 를 다시 조회한다 - Google Vision OCR은 이 모듈 어디에서도 호출하지 않는다.
import { userIdFromAccessToken } from './auth.js';

export async function listPrescriptions(config, session, fetchImpl = fetch) {
  const url = new URL('/rest/v1/prescriptions', config.supabaseUrl);
  url.searchParams.set('select', 'id,label,created_at');
  url.searchParams.set('order', 'created_at.desc');
  url.searchParams.set('limit', '20');
  const response = await fetchImpl(url, { headers: { apikey: config.anonKey, Authorization: `Bearer ${session.accessToken}` } });
  if (!response.ok) throw new Error('저장된 처방전을 불러오지 못했습니다.');
  return response.json();
}

export async function fetchPrescriptionItems(config, session, prescriptionId, fetchImpl = fetch) {
  const url = new URL('/rest/v1/prescription_items', config.supabaseUrl);
  url.searchParams.set('prescription_id', `eq.${prescriptionId}`);
  url.searchParams.set('select', '*');
  url.searchParams.set('order', 'position.asc');
  const response = await fetchImpl(url, { headers: { apikey: config.anonKey, Authorization: `Bearer ${session.accessToken}` } });
  if (!response.ok) throw new Error('처방전 항목을 불러오지 못했습니다.');
  return response.json();
}

// items: [{ rawName, drugName, itemSeq, kind, doseAmount, doseUnit, frequencyPerDay, durationDays, needsReview }]
// - app.js가 rxGroups에서 이 모양으로만 변환해 넘긴다(그 매핑 자체는 여기 없음 - 이 파일은 순수 REST 계층).
export async function savePrescription(config, session, { label, items }, fetchImpl = fetch) {
  const userId = userIdFromAccessToken(session.accessToken);
  if (!userId) throw new Error('로그인 정보를 확인할 수 없습니다.');
  const headers = { apikey: config.anonKey, Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' };
  const prescriptionsUrl = new URL('/rest/v1/prescriptions', config.supabaseUrl);
  const created = await fetchImpl(prescriptionsUrl, {
    method: 'POST', headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify([{ user_id: userId, label: label || null }])
  });
  if (!created.ok) throw new Error('처방전을 저장하지 못했습니다.');
  const [prescription] = await created.json();
  if (items?.length) {
    const itemsUrl = new URL('/rest/v1/prescription_items', config.supabaseUrl);
    const rows = items.map((item, position) => ({
      prescription_id: prescription.id, position,
      raw_name: item.rawName || null, drug_name: item.drugName, item_seq: item.itemSeq || null, kind: item.kind || null,
      dose_amount: item.doseAmount ?? null, dose_unit: item.doseUnit || null,
      frequency_per_day: item.frequencyPerDay ?? null, duration_days: item.durationDays ?? null,
      needs_review: !!item.needsReview
    }));
    const itemsResponse = await fetchImpl(itemsUrl, { method: 'POST', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
    if (!itemsResponse.ok) {
      // 항목 저장이 실패한 처방전 껍데기만 남기지 않는다 - 되돌리고 실패를 알린다.
      await fetchImpl(new URL(`/rest/v1/prescriptions?id=eq.${prescription.id}`, config.supabaseUrl), { method: 'DELETE', headers }).catch(() => {});
      throw new Error('처방전 항목을 저장하지 못했습니다.');
    }
  }
  return prescription;
}

export async function deletePrescription(config, session, prescriptionId, fetchImpl = fetch) {
  const url = new URL(`/rest/v1/prescriptions?id=eq.${prescriptionId}`, config.supabaseUrl);
  const response = await fetchImpl(url, { method: 'DELETE', headers: { apikey: config.anonKey, Authorization: `Bearer ${session.accessToken}` } });
  if (!response.ok) throw new Error('처방전을 삭제하지 못했습니다.');
}
