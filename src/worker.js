import { liquidImage } from './liquid-image.js';
import { enrichMedicines, normalizePermit, lookup, SOURCES } from './mfds-enrichment.js';
import { extractPrescriptionVision, ProviderNotConfiguredError, VisionProviderError, resolveProviderName } from './prescription-vision.js';
import { lookupDurAll } from './mfds-dur.js';
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
// Vision extraction primary path (see public/prescription-extractor.js for the client-side fallback
// orchestration - item 2/3/4 of the request). The image never touches Supabase or any log: it is read
// once into memory here, handed to the provider over HTTPS, and both the buffer and the provider's
// response go out of scope when this function returns - nothing about this request is persisted
// anywhere (item 8). PRESCRIPTION_VISION_LIMITER is a separate, stricter budget from SEARCH_LIMITER
// since each call can cost real money against a paid vision API, unlike a cached MFDS lookup.
async function prescriptionExtract(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST 요청만 지원합니다.' }, 405);
  if (env.PRESCRIPTION_VISION_LIMITER) {
    const { success } = await env.PRESCRIPTION_VISION_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' });
    if (!success) return json({ error: '분석 요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.' }, 429);
  }
  // Whether a provider is actually configured is decided in ONE place - extractPrescriptionVision
  // itself (it knows each provider's own key env var and the GOOGLE_VISION_API_KEY-implies-google
  // default). A duplicate gate here previously required BOTH PRESCRIPTION_VISION_PROVIDER and
  // PRESCRIPTION_VISION_API_KEY to be set, so setting only GOOGLE_VISION_API_KEY (this app's actual
  // .dev.vars) always 501'd before the request ever reached that logic - this was the real cause of
  // "vision route never called".
  const hasGoogleVisionKey = !!env.GOOGLE_VISION_API_KEY;
  let form;
  try { form = await request.formData(); } catch { return json({ error: '이미지를 읽지 못했습니다.' }, 400); }
  const image = form.get('image');
  if (!(image instanceof File) && !(image instanceof Blob)) return json({ error: '이미지 파일이 필요합니다.' }, 400);
  if (!image.type?.startsWith('image/')) return json({ error: '이미지 파일만 지원합니다.' }, 400);
  if (image.size > 20 * 1024 * 1024) return json({ error: '20MB 이하의 이미지만 지원합니다.' }, 400);
  try {
    const buffer = await image.arrayBuffer();
    const { provider, medications } = await extractPrescriptionVision(env, buffer, image.type, AbortSignal.timeout(30000));
    // Dev-only structured diagnostic (item 9) - never the image, base64, or full OCR text; only the
    // already-structured, already-validated fields.
    console.log(JSON.stringify({
      provider, googleVisionStatus: 200, hasGoogleVisionKey, medicationCount: medications.length,
      structuredMedications: medications.map(m => ({ drugName: m.drugName, dosePerAdministration: m.dosePerAdministration, frequencyPerDay: m.frequencyPerDay, durationDays: m.durationDays }))
    }));
    return json({ schemaVersion: 1, source: 'vision', provider, medications });
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) {
      console.log(JSON.stringify({ provider: null, googleVisionStatus: null, hasGoogleVisionKey, medicationCount: 0 }));
      return json({ error: 'vision_not_configured', provider: null }, 501);
    }
    const provider = resolveProviderName(env) || null;
    const status = error instanceof VisionProviderError ? error.status : null;
    console.log(JSON.stringify({ provider, googleVisionStatus: status, hasGoogleVisionKey, medicationCount: 0, error: error?.message }));
    // The provider's own message IS surfaced (item 5: "Google Vision 호출 실패: [status] [message]") -
    // it's an API-level status/reason text, never the key, image, base64, or full OCR text.
    return json({ error: '처방전 이미지를 분석하지 못했습니다.', provider, providerStatus: status, providerMessage: error instanceof VisionProviderError ? error.providerMessage : undefined }, 502);
  }
}
// Browser login needs the project URL plus a key it's SAFE to expose (anon/publishable, protected by
// RLS) - never the SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY that database() above uses, which
// stay server-only. Same dual-naming pattern as database(): a new-style publishable key if set,
// otherwise the legacy anon JWT. Returns nulls (not an error) when neither is configured, so the
// frontend can fail open (skip the login gate) instead of bricking dev/self-hosted setups that
// haven't set this up yet - see public/auth.js's loadConfig().
function authConfig(env) {
  const anonKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || null;
  const supabaseUrl = env.SUPABASE_URL || null;
  return json({ supabaseUrl: supabaseUrl && anonKey ? supabaseUrl : null, anonKey: supabaseUrl && anonKey ? anonKey : null });
}
// DUR(의약품안전사용서비스) 용량주의/투여기간주의 - 성분/함량(permit)·사용법(easy)과 별개의 독립 출처라
// 자체 엔드포인트로 온디맨드 조회한다(용량 분석 패널을 열 때만 - src/mfds-dur.js 참고). 서비스키는 여기서만
// 붙고 절대 브라우저로 전달되지 않는다. 'unavailable'은 현재 이 계정 키가 이 API 자체에 등록되지 않아서
// 생기는 상태로, 장애('error')와 구분해 그대로 전달한다 - 클라이언트가 서로 다른 문구를 보여줄 수 있도록.
async function durLookup(request, env) {
  if (request.method !== 'GET') return json({ error: 'GET 요청만 지원합니다.' }, 405);
  const url = new URL(request.url);
  const itemSeq = (url.searchParams.get('item_seq') || '').trim();
  if (!/^\d{1,20}$/.test(itemSeq)) return json({ error: '품목기준코드가 필요합니다.' }, 400);
  if (!env.MFDS_SERVICE_KEY) return json({ error: 'DUR 연결을 준비 중입니다.' }, 503);
  if (env.SEARCH_LIMITER) {
    const { success } = await env.SEARCH_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' });
    if (!success) return json({ error: '검색이 너무 잦습니다. 1분 뒤 다시 시도해주세요.' }, 429);
  }
  let serviceKey = env.MFDS_SERVICE_KEY.trim();
  if (serviceKey.includes('%')) serviceKey = decodeURIComponent(serviceKey);
  const { capacity, period } = await lookupDurAll(itemSeq, serviceKey, AbortSignal.timeout(8000));
  return json({ itemSeq, capacity, period, source: '식품의약품안전처 의약품안전사용서비스(DUR)' });
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (url.pathname === '/api/auth/config') return authConfig(env);
    if (url.pathname === '/api/liquid-image') return liquidImage(request, env, imageUrl);
    if (url.pathname === '/api/prescription/extract') return prescriptionExtract(request, env);
    if (url.pathname === '/api/dur') return durLookup(request, env);
    const liquid = url.pathname === '/api/liquids';
    if (!liquid && url.pathname !== '/api/medicines') return json({ error: '찾을 수 없는 주소입니다.' }, 404);
    if (request.method !== 'GET') return json({ error: 'GET 요청만 지원합니다.' }, 405);
    const q = (url.searchParams.get('item_name') ?? url.searchParams.get('q') ?? '').trim().normalize('NFC');
    const company = (url.searchParams.get('entp_name') || '').trim().normalize('NFC');
    const itemId = (url.searchParams.get('item_seq') || '').trim();
    // 검색 목록(light=1)은 목록 표시에 필요한 낱알식별 데이터만 반환한다 - 항목마다 허가정보·e약은요를
    // 추가 조회하지 않는다(아래 enrichMedicines 참고). 기본값(light 미지정)은 기존 호출자(처방전 제품
    // 매칭, "약 직접 추가" 등)와 완전히 동일하게 동작한다 - 하위 호환을 위해 opt-in으로만 둔다.
    const light = url.searchParams.get('light') === '1';
    const page = Number(url.searchParams.get('pageNo') ?? url.searchParams.get('page') ?? 1);
    const pageSize = Number(url.searchParams.get('numOfRows') ?? 20);
    // 품목기준코드(ITEM_SEQ)는 항상 숫자만은 아니다 - 실제 제품허가정보(액상 등) 데이터셋에는
    // "M105518"처럼 문자 접두가 붙은 값도 있다. 숫자만 허용하던 이전 검증은 이런 제품의 단일 조회
    // (item_seq 기반 재조회 - 용량 확인의 공식 용법·용량 fetch가 여기 의존한다)를 매번 400으로
    // 막아 "공식 정보를 불러오지 못했어요"로 잘못 보이게 했다 - 실제로는 데이터가 있는데 우리 쪽
    // 입력 검증이 막은 것이었다.
    if ((!q && !company && !itemId) || (q && q.length < 2) || q.length > 80 || company.length > 80 || /[\x00-\x1f\x7f]/.test(q + company) || (itemId && !/^[A-Za-z0-9]{1,20}$/.test(itemId))) return json({ error: '약 이름은 2~80자, 업체명은 80자 이하, 품목일련번호는 영문·숫자로 입력해주세요. 검색 조건이 하나 이상 필요합니다.' }, 400);
    if (!Number.isInteger(page) || page < 1 || page > 100 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 20) return json({ error: '페이지는 1~100, 결과 수는 1~20 사이의 정수여야 합니다.' }, 400);
    if (env.SEARCH_LIMITER) {
      const { success } = await env.SEARCH_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' });
      if (!success) return json({ error: '검색이 너무 잦습니다. 1분 뒤 다시 시도해주세요.' }, 429);
    }
    // Temporary, development-only diagnostics: never log the key, URL query, or response body.
    const searchDebug = ['127.0.0.1', 'localhost'].includes(url.hostname) || url.hostname.endsWith('.app.github.dev');
    const diagnostic = { query: q, apiKey: env.MFDS_SERVICE_KEY ? 'present' : 'missing', light,
      endpoint: liquid ? SOURCES.permit.endpoint : ENDPOINT, upstreamStatus: null, contentType: null,
      responseParse: 'not_started', rawItems: null, normalizedItems: null, returnedItems: 0, error: null };
    const logSearch = () => { if (searchDebug) console.log('[medicine-search]', JSON.stringify(diagnostic)); };
    if (!env.MFDS_SERVICE_KEY) { diagnostic.error = 'MissingApiKey'; logSearch(); return json({ error: '의약품 검색 연결을 준비 중입니다. 잠시 후 다시 이용해주세요.' }, 503); }

    const key = await cacheKey(liquid ? ['liquid-v1', q, company, itemId, page, pageSize] : [q, company, itemId, page, pageSize, light ? 'light' : 'full']);
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
      const upstream = new URL(liquid ? SOURCES.permit.endpoint : ENDPOINT);
      upstream.search = new URLSearchParams({ serviceKey, type: 'json', pageNo: String(page), numOfRows: String(pageSize) });
      if (q) upstream.searchParams.set('item_name', q);
      if (company) upstream.searchParams.set('entp_name', company);
      if (itemId) upstream.searchParams.set('item_seq', itemId);
      const response = await fetch(upstream, { signal: AbortSignal.timeout(10000) });
      diagnostic.upstreamStatus = response.status; diagnostic.contentType = response.headers.get('content-type');
      if (!response.ok) throw new Error('upstream');
      diagnostic.responseParse = 'failure';
      const raw = await response.json();
      diagnostic.responseParse = 'success';
      const data = raw.response ?? raw;
      if (!['00', '0'].includes(String(data.header?.resultCode))) throw new Error('upstream');
      const body = data.body;
      if (!body || !/^\d+$/.test(String(body.totalCount)) || !Number.isSafeInteger(Number(body.totalCount))) throw new Error('schema');
      let items = body.items?.item ?? body.items ?? [];
      if (items === '') items = [];
      if (!Array.isArray(items)) items = [items];
      diagnostic.rawItems = items.length;
      if (items.some(item => !item?.ITEM_SEQ || !item?.ITEM_NAME)) throw new Error('schema');
      if (items.length > pageSize || (Number(body.totalCount) === 0 && items.length)) throw new Error('schema');
      let merged;
      if (liquid) {
        merged = items.map(row => ({ ...normalize(row), permit: { status: 'ok', data: normalizePermit(row) }, easy: { status: 'not_requested', data: null } }));
        // 복약정보(e약은요)는 품목일련번호 기반이라 낱알식별 미등재 액상 제형에도 그대로 동작한다. 이름 검색
        // 결과(최대 20개)까지 매번 조회하면 느려지므로, 처방 용량 분석 등 특정 제품 1건을 확인할 때만(item_seq
        // 지정 시) 가져온다 - 목록 조회 성능은 그대로 유지된다.
        if (itemId && merged.length === 1) merged[0].easy = await lookup('easy', itemId, serviceKey, AbortSignal.timeout(6000));
      } else {
        const normalized = items.map(normalize);
        // 낱알식별 이름 검색(최대 20개)마다 항목당 허가정보+e약은요를 전부 추가 조회하면(item당 2회,
        // 최대 40회) 검색이 느려지고 식약처 API 호출 한도를 목록 조회만으로 소진해 이후 검색까지
        // 실패하게 만든다 - 실제 병목이었다. light=1이면 목록에 필요한 데이터(이름/제조사/모양/치수 등,
        // 이미 normalize()가 채운다)만 반환하고, 상세는 사용자가 실제로 제품을 선택했을 때
        // item_seq 단일 조회로 지연 로딩한다(프런트엔드 ensureMedicineDetail).
        merged = light ? normalized.map(item => ({ ...item, permit: { status: 'not_requested', data: null }, easy: { status: 'not_requested', data: null } }))
          : await enrichMedicines(normalized, serviceKey);
      }
      diagnostic.normalizedItems = merged.length;
      const partial = merged.some(item => ['error', 'unmatched'].includes(item.permit.status) || ['error', 'unmatched'].includes(item.easy.status));
      const payload = { schemaVersion: CACHE_VERSION, partial, items: merged, total: Number(body.totalCount), page, pageSize, fetchedAt: new Date().toISOString(), source: liquid ? '식품의약품안전처 제품 허가정보' : '식품의약품안전처 낱알식별·제품 허가정보·e약은요' };
      if (db) {
        db.url.search = '?on_conflict=cache_key';
        ctx.waitUntil(fetch(db.url, { method: 'POST', headers: { ...db.headers, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ cache_key: key, payload, expires_at: new Date(Date.now() + (partial ? 60 : TTL) * 1000).toISOString() }), signal: AbortSignal.timeout(2000) }).then(r => { if (!r.ok) console.warn('Search cache write unavailable'); }).catch(() => {}));
      }
      diagnostic.returnedItems = payload.items.length; logSearch();
      return json(payload);
    } catch (error) {
      diagnostic.error = error?.name || 'UnknownError';
      if (['upstream', 'schema'].includes(error?.message)) diagnostic.error += ':' + error.message;
      logSearch();
      return json({ error: '식약처 정보를 불러오지 못했습니다. 잠시 후 다시 검색해주세요.' }, 502);
    }
  }
};
