// Supabase Auth, hand-rolled against the raw REST/GoTrue API - no @supabase/supabase-js SDK. This
// mirrors src/worker.js's own database(env) helper, which already talks to Supabase purely over
// fetch+apikey/Authorization headers rather than a client library, so the browser side stays
// consistent with that and avoids vendoring a whole SDK for what is a handful of endpoints (see
// docs/prescription-product-flow.md-style comments elsewhere in this app for the same "vendor only
// what's truly needed" stance). The frontend only ever holds the public anon/publishable key and the
// signed-in user's own access token - never a secret/service_role key (see src/worker.js's database()
// for where those live, server-side only).
const SESSION_KEY = 'sp-auth-session-v1';

// All providers share Supabase auth.users.id and the existing profiles model.
export const OAUTH_PROVIDERS = [
  { id: 'google', label: 'Google로 계속하기', enabled: true },
  { id: 'kakao', label: '카카오로 계속하기', enabled: true },
  { id: 'naver', label: '네이버로 계속하기', enabled: false }
];

// Populate only with reviewed, published documents. Missing documents cannot be consented to.
export const CONSENT_DOCUMENTS = {
  terms: { label: '이용약관', version: null, url: null },
  privacy: { label: '개인정보 수집·이용', version: null, url: null },
  marketing: { label: '마케팅 정보 수신', version: null, url: null }
};
export function consentDocumentsReady(marketing = false) {
  return ['terms', 'privacy', ...(marketing ? ['marketing'] : [])].every(key => {
    const doc = CONSENT_DOCUMENTS[key];
    return Boolean(doc.version && doc.url && (doc.url.startsWith('/') || doc.url.startsWith('https://')));
  });
}
export function hasRequiredConsent(consent) {
  return consentDocumentsReady() && ['terms', 'privacy'].every(key =>
    consent?.[key]?.accepted === true && consent[key].version === CONSENT_DOCUMENTS[key].version);
}
export async function fetchConsent(config, session, fetchImpl = fetch) {
  const response = await fetchImpl(new URL('/auth/v1/user', config.supabaseUrl), {
    headers: { apikey: config.anonKey, Authorization: `Bearer ${session.accessToken}` }
  });
  if (!response.ok) throw new Error('동의 내역을 불러오지 못했습니다.');
  return (await response.json()).user_metadata?.service_consent || null;
}
export async function saveConsent(config, session, choices, fetchImpl = fetch) {
  if (!choices.terms || !choices.privacy || !consentDocumentsReady(choices.marketing)) {
    throw new Error('필수 동의와 약관 문서를 확인해주세요.');
  }
  const consent = Object.fromEntries(Object.entries(CONSENT_DOCUMENTS).map(([key, doc]) =>
    [key, { accepted: choices[key] === true, version: doc.version, url: doc.url }]));
  consent.accepted_at = new Date().toISOString();
  const response = await fetchImpl(new URL('/auth/v1/user', config.supabaseUrl), {
    method: 'PUT', headers: { apikey: config.anonKey, Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { service_consent: consent } })
  });
  if (!response.ok) throw new Error('동의 내역을 저장하지 못했습니다.');
  const saved = (await response.json()).user_metadata?.service_consent;
  if (!hasRequiredConsent(saved)) throw new Error('동의 내역 저장을 확인하지 못했습니다.');
  return saved;
}
export async function fetchProviderAvailability(config, fetchImpl = fetch) {
  const response = await fetchImpl(new URL('/auth/v1/settings', config.supabaseUrl), { headers: { apikey: config.anonKey } });
  if (!response.ok) throw new Error('로그인 연결 상태를 확인하지 못했습니다.');
  return (await response.json()).external || {};
}

let cachedConfig;
export async function loadConfig(fetchImpl = fetch) {
  if (cachedConfig) return cachedConfig;
  try {
    const response = await fetchImpl('/api/auth/config');
    if (!response.ok) return null;
    const data = await response.json();
    cachedConfig = data?.supabaseUrl && data?.anonKey ? { supabaseUrl: data.supabaseUrl, anonKey: data.anonKey } : null;
  } catch { cachedConfig = null; }
  return cachedConfig;
}
// Test-only reset - loadConfig() caches the result for the lifetime of the page otherwise.
export function _resetConfigCache() { cachedConfig = undefined; }

export function buildAuthorizeUrl(config, provider, redirectTo) {
  if (!OAUTH_PROVIDERS.some(item => item.id === provider && item.enabled)) throw new Error('지원하지 않는 로그인입니다.');
  const url = new URL('/auth/v1/authorize', config.supabaseUrl);
  url.searchParams.set('provider', provider);
  url.searchParams.set('redirect_to', redirectTo);
  // GoTrue's /authorize is reached via a top-level navigation (window.location), so there is no
  // request to attach an apikey HEADER to - it has to travel as a query param instead.
  url.searchParams.set('apikey', config.anonKey);
  return url.href;
}

// Implicit-flow OAuth redirects back with the session in the URL fragment (#access_token=...&...),
// never in a server-visible query string or a code that needs a second exchange call - simplest hand
// -rollable flow that still keeps tokens off any server log.
export function parseSessionFromHash(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const accessToken = params.get('access_token'), refreshToken = params.get('refresh_token');
  const expiresIn = Number(params.get('expires_in'));
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 };
}

export function readStoredSession(storage = localStorage) {
  try {
    const session = JSON.parse(storage.getItem(SESSION_KEY));
    return session?.accessToken && session?.refreshToken ? session : null;
  } catch { return null; }
}
export function persistSession(session, storage = localStorage) {
  try { storage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* Session just won't survive a reload/private mode. */ }
}
export function clearStoredSession(storage = localStorage) {
  try { storage.removeItem(SESSION_KEY); } catch { /* Nothing to clear if storage is unavailable. */ }
}
export function isSessionExpired(session, skewMs = 30000) {
  return !session || !Number.isFinite(session.expiresAt) || session.expiresAt - skewMs <= Date.now();
}

export async function refreshSession(config, session, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(new URL('/auth/v1/token?grant_type=refresh_token', config.supabaseUrl), {
      method: 'POST', headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refreshToken })
    });
  } catch { return null; }
  if (!response.ok) return null;
  const data = await response.json().catch(() => null);
  if (!data?.access_token || !data?.refresh_token) return null;
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
}

// Resolves whatever session is usable right now: an OAuth-redirect hash first, otherwise the stored
// session (refreshed if it's expired/near-expiry). Always clears the hash from the visible URL once
// read so the tokens don't linger in browser history/back-forward cache.
export async function resolveSession(config, { hash = location.hash, storage = localStorage, fetchImpl = fetch, clearHash = () => history.replaceState(null, '', location.pathname + location.search) } = {}) {
  const error = new URLSearchParams(String(hash || '').replace(/^#/, '')).get('error');
  if (error) { clearHash(); throw new Error('로그인이 취소되었거나 완료되지 않았습니다. 다시 시도해주세요.'); }
  const fromHash = parseSessionFromHash(hash);
  if (fromHash) { persistSession(fromHash, storage); clearHash(); return fromHash; }
  let session = readStoredSession(storage);
  if (!session) return null;
  if (isSessionExpired(session)) {
    if (!config) return null;
    const refreshed = await refreshSession(config, session, fetchImpl);
    if (!refreshed) { clearStoredSession(storage); return null; }
    persistSession(refreshed, storage); session = refreshed;
  }
  return session;
}

export async function signOut(config, session, fetchImpl = fetch, storage = localStorage) {
  // Local sign-out always succeeds; a failed remote revocation is reported separately.
  clearStoredSession(storage);
  if (!config || !session) return { remoteRevoked: !session };
  try {
    const response = await fetchImpl(new URL('/auth/v1/logout', config.supabaseUrl), {
      method: 'POST', headers: { apikey: config.anonKey, Authorization: `Bearer ${session.accessToken}` },
      signal: AbortSignal.timeout(10000)
    });
    return { remoteRevoked: response.ok };
  } catch { return { remoteRevoked: false }; }
}

// The access token is this user's own already-issued JWT - decoding it locally (never trusted for
// authorization, only to read `sub` for building request URLs) saves a round trip vs calling
// /auth/v1/user just to learn the id. RLS on the Supabase side is what actually enforces access.
export function userIdFromAccessToken(accessToken) {
  try {
    const payload = String(accessToken).split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).sub || null;
  } catch { return null; }
}

export async function fetchProfile(config, session, fetchImpl = fetch) {
  const userId = userIdFromAccessToken(session.accessToken);
  if (!userId) throw new Error('로그인 정보를 확인할 수 없습니다.');
  const url = new URL('/rest/v1/profiles', config.supabaseUrl);
  url.searchParams.set('user_id', `eq.${userId}`); url.searchParams.set('select', '*'); url.searchParams.set('limit', '1');
  const response = await fetchImpl(url, { headers: { apikey: config.anonKey, Authorization: `Bearer ${session.accessToken}` } });
  if (!response.ok) throw new Error('프로필을 불러오지 못했습니다.');
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('프로필 응답을 확인할 수 없습니다.');
  return rows[0] || null;
}

export async function saveProfile(config, session, { birthDate, sex, weightKg }, fetchImpl = fetch) {
  const userId = userIdFromAccessToken(session.accessToken);
  if (!userId) throw new Error('로그인 정보를 확인할 수 없습니다.');
  const url = new URL('/rest/v1/profiles', config.supabaseUrl);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { apikey: config.anonKey, Authorization: `Bearer ${session.accessToken}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ user_id: userId, birth_date: birthDate || null, sex: sex || 'prefer_not_to_say', weight_kg: weightKg ?? null }])
  });
  if (!response.ok) throw new Error('프로필을 저장하지 못했습니다.');
  const rows = await response.json();
  if (!Array.isArray(rows) || rows[0]?.user_id !== userId) throw new Error('프로필 저장을 확인하지 못했습니다.');
  return rows[0];
}

// 만 나이(international age) - birth_date만 저장하고 나이 자체는 절대 저장하지 않으며, 볼 때마다 현재
// 날짜 기준으로 계산한다 (요청 5). 미래 날짜/파싱 불가 값은 null - 임의로 보정하지 않는다.
export function ageYearsFromBirthDate(birthDate, now = new Date()) {
  if (!birthDate) return null;
  const dob = new Date(`${birthDate}T00:00:00`);
  if (Number.isNaN(dob.getTime()) || dob > now) return null;
  let age = now.getFullYear() - dob.getFullYear();
  const beforeBirthdayThisYear = now.getMonth() < dob.getMonth() || (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate());
  if (beforeBirthdayThisYear) age--;
  return age >= 0 ? age : null;
}
export function weightKgFromProfile(profile) {
  const n = Number(profile?.weight_kg);
  return Number.isFinite(n) && n > 0 ? n : null;
}
// dose analysis가 바로 쓸 수 있는 {weightKg, ageYears} 형태로 프로필을 변환하는 순수 함수 (요청 9) -
// app.js와 테스트가 똑같은 로직을 보게 하나로 모아둔다.
export function dosePatientFromProfile(profile, now = new Date()) {
  return { weightKg: weightKgFromProfile(profile), ageYears: ageYearsFromBirthDate(profile?.birth_date, now) };
}

// 로그인/온보딩 흐름에서 다음에 보여줄 화면을 결정하는 순수 함수 - app.js의 initAuth()와 테스트가 이
// 하나만 보고 판단하므로 화면 전환 로직이 두 곳에서 따로 갈라지지 않는다 (요청 17의 시나리오들과 직접 대응).
export function decideGateScreen(session, profile, consent = null) {
  if (!session) return 'login';
  if (!profile) return hasRequiredConsent(consent) ? 'profile-onboarding' : 'consent-onboarding';
  return 'home';
}
