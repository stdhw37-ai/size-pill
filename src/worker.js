import { enrichMedicines } from './mfds-enrichment.js';
const ENDPOINT = 'https://apis.data.go.kr/1471000/MdcinGrnIdntfcInfoService03/getMdcinGrnIdntfcInfoList03';
const TTL = 86400;
const CACHE_VERSION = 3;
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
export function dimension(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return n > 0 && n <= 100 ? n : null;
}
export function normalize(item) {
  const text = field => String(item[field] ?? '').trim();
  // Field names verified against the data.go.kr Swagger; see docs/mfds-api.md.
  return {
    id: text('ITEM_SEQ'), name: text('ITEM_NAME'), company: text('ENTP_NAME'),
    shape: text('DRUG_SHAPE'), long: dimension(item.LENG_LONG), short: dimension(item.LENG_SHORT), thick: dimension(item.THICK),
    changed: text('CHANGE_DATE'), imageUrl: imageUrl(item.ITEM_IMAGE),
    colorFront: text('COLOR_CLASS1'), colorBack: text('COLOR_CLASS2'),
    printFront: text('PRINT_FRONT'), printBack: text('PRINT_BACK'),
    lineFront: text('LINE_FRONT'), lineBack: text('LINE_BACK'),
    description: text('CHART'), form: text('FORM_CODE_NAME'),
    className: text('CLASS_NAME'), classCode: text('CLASS_NO'), medicineType: text('ETC_OTC_NAME'),
    englishName: text('ITEM_ENG_NAME'), companyId: text('ENTP_SEQ'),
    permitDate: text('ITEM_PERMIT_DATE'), imageDate: text('IMG_REGIST_TS'),
    markFront: text('MARK_CODE_FRONT_ANAL'), markBack: text('MARK_CODE_BACK_ANAL'),
    markImageFront: imageUrl(item.MARK_CODE_FRONT_IMG), markImageBack: imageUrl(item.MARK_CODE_BACK_IMG),
    markCodeFront: text('MARK_CODE_FRONT'), markCodeBack: text('MARK_CODE_BACK'),
    insuranceCode: text('EDI_CODE'), businessNumber: text('BIZRNO'), standardCode: text('STD_CD'),
    // Preserve range/approximate source values without treating them as exact mm.
    dimensionsRaw: { long: text('LENG_LONG'), short: text('LENG_SHORT'), thick: text('THICK') }
  };
}
export function imageUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return '';
    if (url.hostname !== 'mfds.go.kr' && !url.hostname.endsWith('.mfds.go.kr')) return '';
    url.protocol = 'https:';
    return url.href;
  } catch { return ''; }
}
export async function cacheKey(filters) {
  // Hash prevents PostgREST filter syntax in user input and keeps keys bounded.
  const bytes = new TextEncoder().encode(JSON.stringify(filters));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `mfds-v${CACHE_VERSION}:` + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
function database(env) {
  const secret = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !secret) return null;
  const url = new URL('/rest/v1/medicine_search_cache', env.SUPABASE_URL);
  const headers = { apikey: secret, 'Content-Type': 'application/json' };
  // Legacy service_role JWTs also work, but new sb_secret keys are not JWTs.
  if (!secret.startsWith('sb_secret_')) headers.Authorization = `Bearer ${secret}`;
  return { url, headers };
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (url.pathname !== '/api/medicines') return json({ error: '찾을 수 없는 주소입니다.' }, 404);
    if (request.method !== 'GET') return json({ error: 'GET 요청만 지원합니다.' }, 405);
    const q = (url.searchParams.get('item_name') ?? url.searchParams.get('q') ?? '').trim().normalize('NFC');
    const company = (url.searchParams.get('entp_name') || '').trim().normalize('NFC');
    const itemId = (url.searchParams.get('item_seq') || '').trim();
    const page = Number(url.searchParams.get('pageNo') ?? url.searchParams.get('page') ?? 1);
    const pageSize = Number(url.searchParams.get('numOfRows') ?? 20);
    if ((!q && !company && !itemId) || (q && q.length < 2) || q.length > 80 || company.length > 80 || /[\x00-\x1f\x7f]/.test(q + company) || (itemId && !/^\d{1,20}$/.test(itemId))) return json({ error: '약 이름은 2~80자, 업체명은 80자 이하, 품목일련번호는 숫자로 입력해주세요. 검색 조건이 하나 이상 필요합니다.' }, 400);
    if (!Number.isInteger(page) || page < 1 || page > 100 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 20) return json({ error: '페이지는 1~100, 결과 수는 1~20 사이의 정수여야 합니다.' }, 400);
    if (env.SEARCH_LIMITER) {
      const { success } = await env.SEARCH_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' });
      if (!success) return json({ error: '검색이 너무 잦습니다. 1분 뒤 다시 시도해주세요.' }, 429);
    }
    if (!env.MFDS_SERVICE_KEY) return json({ error: '의약품 검색 연결을 준비 중입니다. 잠시 후 다시 이용해주세요.' }, 503);
    const key = await cacheKey([q, company, itemId, page, pageSize]);
    let db;
    try { db = database(env); } catch { /* Optional cache must not block searches. */ }
    if (db) {
      try {
        db.url.search = new URLSearchParams({ cache_key: `eq.${key}`, expires_at: `gt.${new Date().toISOString()}`, select: 'payload', limit: '1' });
        const cached = await fetch(db.url, { headers: db.headers, signal: AbortSignal.timeout(2000) });
        if (cached.ok) {
          const rows = await cached.json();
          const payload = rows[0]?.payload;
          if (payload?.schemaVersion === CACHE_VERSION && Array.isArray(payload.items) && payload.page === page && payload.pageSize === pageSize && Number.isInteger(payload.total) && payload.total >= 0 && payload.fetchedAt) return json(payload);
        }
      } catch { /* Fetch fresh data on cache failure. */ }
    }
    try {
      let serviceKey = env.MFDS_SERVICE_KEY.trim();
      if (serviceKey.includes('%')) serviceKey = decodeURIComponent(serviceKey);
      const upstream = new URL(ENDPOINT);
      upstream.search = new URLSearchParams({ serviceKey, type: 'json', pageNo: String(page), numOfRows: String(pageSize) });
      if (q) upstream.searchParams.set('item_name', q);
      if (company) upstream.searchParams.set('entp_name', company);
      if (itemId) upstream.searchParams.set('item_seq', itemId);
      const response = await fetch(upstream, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('upstream');
      const raw = await response.json();
      const data = raw.response ?? raw;
      if (!['00', '0'].includes(String(data.header?.resultCode))) throw new Error('upstream');
      const body = data.body;
      if (!body || !/^\d+$/.test(String(body.totalCount)) || !Number.isSafeInteger(Number(body.totalCount))) throw new Error('schema');
      let items = body.items?.item ?? body.items ?? [];
      if (items === '') items = [];
      if (!Array.isArray(items)) items = [items];
      if (items.some(item => !item?.ITEM_SEQ || !item?.ITEM_NAME)) throw new Error('schema');
      if (items.length > pageSize || (Number(body.totalCount) === 0 && items.length)) throw new Error('schema');
      const merged = await enrichMedicines(items.map(normalize), serviceKey);
      const partial = merged.some(item => ['error', 'unmatched'].includes(item.permit.status) || ['error', 'unmatched'].includes(item.easy.status));
      const payload = { schemaVersion: CACHE_VERSION, partial, items: merged, total: Number(body.totalCount), page, pageSize, fetchedAt: new Date().toISOString(), source: '식품의약품안전처 낱알식별·제품 허가정보·e약은요' };
      if (db) {
        db.url.search = '?on_conflict=cache_key';
        ctx.waitUntil(fetch(db.url, { method: 'POST', headers: { ...db.headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ cache_key: key, payload, expires_at: new Date(Date.now() + (partial ? 60 : TTL) * 1000).toISOString() }), signal: AbortSignal.timeout(2000) }).then(r => { if (!r.ok) console.warn('Search cache write unavailable'); }).catch(() => {}));
      }
      return json(payload);
    } catch {
      return json({ error: '식약처 정보를 불러오지 못했습니다. 잠시 후 다시 검색해주세요.' }, 502);
    }
  }
};
