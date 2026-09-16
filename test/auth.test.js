import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSENT_DOCUMENTS, consentDocumentsReady, hasRequiredConsent, fetchConsent, saveConsent, fetchProviderAvailability,
  OAUTH_PROVIDERS, buildAuthorizeUrl, parseSessionFromHash, isSessionExpired, refreshSession,
  resolveSession, signOut, userIdFromAccessToken, fetchProfile, saveProfile, ageYearsFromBirthDate,
  weightKgFromProfile, dosePatientFromProfile, decideGateScreen, loadConfig, _resetConfigCache
} from '../public/auth.js';

function fakeAccessToken(sub) {
  return `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
}
const CONFIG = { supabaseUrl: 'https://proj.supabase.co', anonKey: 'anon-key-123' };

test('OAUTH_PROVIDERS: Google/Kakao는 활성화되어 있고, Naver는 구조만 있고 비활성 상태다 (요청 2)', () => {
  const byId = Object.fromEntries(OAUTH_PROVIDERS.map(p => [p.id, p]));
  assert.equal(byId.google.enabled, true);
  assert.equal(byId.kakao.enabled, true);
  assert.equal(byId.naver.enabled, false, 'Naver는 UI/구조만 있고 아직 켜지지 않는다');
});

test('buildAuthorizeUrl: provider/redirect_to/apikey를 쿼리로 담고, secret 키는 절대 쓰지 않는다', () => {
  const url = new URL(buildAuthorizeUrl(CONFIG, 'google', 'https://app.example/callback'));
  assert.equal(url.pathname, '/auth/v1/authorize');
  assert.equal(url.searchParams.get('provider'), 'google');
  assert.equal(url.searchParams.get('redirect_to'), 'https://app.example/callback');
  assert.equal(url.searchParams.get('apikey'), CONFIG.anonKey);
});

test('parseSessionFromHash: OAuth 리다이렉트 해시에서 세션을 읽고, 필수 필드가 없으면 null', () => {
  const hash = '#access_token=at1&refresh_token=rt1&expires_in=3600&token_type=bearer';
  const before = Date.now();
  const session = parseSessionFromHash(hash);
  assert.equal(session.accessToken, 'at1'); assert.equal(session.refreshToken, 'rt1');
  assert.ok(session.expiresAt >= before + 3600 * 1000);
  assert.equal(parseSessionFromHash('#error=access_denied'), null);
  assert.equal(parseSessionFromHash(''), null);
});

test('isSessionExpired: 만료/임박 세션은 true, 충분히 남은 세션은 false', () => {
  assert.equal(isSessionExpired(null), true);
  assert.equal(isSessionExpired({ expiresAt: Date.now() - 1000 }), true);
  assert.equal(isSessionExpired({ expiresAt: Date.now() + 5000 }), true, '기본 30초 skew 이내면 만료로 취급');
  assert.equal(isSessionExpired({ expiresAt: Date.now() + 3600_000 }), false);
});

test('refreshSession: refresh_token으로 새 access/refresh token을 받고, 실패하면 null (억지로 세션을 만들지 않는다)', async () => {
  const calls = [];
  const ok = await refreshSession(CONFIG, { refreshToken: 'old-rt' }, async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 });
  });
  assert.equal(ok.accessToken, 'new-at'); assert.equal(ok.refreshToken, 'new-rt');
  assert.ok(calls[0].url.includes('/auth/v1/token'));
  assert.equal(JSON.parse(calls[0].init.body).refresh_token, 'old-rt');
  assert.equal(calls[0].init.headers.apikey, CONFIG.anonKey);

  const failed = await refreshSession(CONFIG, { refreshToken: 'bad' }, async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
  assert.equal(failed, null);
  const networkDown = await refreshSession(CONFIG, { refreshToken: 'x' }, async () => { throw new TypeError('network'); });
  assert.equal(networkDown, null);
});

test('resolveSession: 해시 우선 사용 후 지우고, 없으면 저장된 세션을 쓰며 만료 시에만 refresh한다', async () => {
  const clearedHashes = [];
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };

  // 1) 해시에 세션이 있으면 그걸 쓰고 저장한 뒤 해시를 지운다.
  const fromHash = await resolveSession(CONFIG, {
    hash: '#access_token=at1&refresh_token=rt1&expires_in=3600', storage, fetchImpl: async () => Response.json({}),
    clearHash: () => clearedHashes.push(true)
  });
  assert.equal(fromHash.accessToken, 'at1');
  assert.equal(clearedHashes.length, 1);
  assert.equal(JSON.parse(store.get('sp-auth-session-v1')).accessToken, 'at1');

  // 2) 해시 없고 저장된 세션이 아직 유효하면 그대로 반환 (refresh 호출 없음).
  store.set('sp-auth-session-v1', JSON.stringify({ accessToken: 'at2', refreshToken: 'rt2', expiresAt: Date.now() + 3600_000 }));
  let refreshCalled = false;
  const stillValid = await resolveSession(CONFIG, { hash: '', storage, fetchImpl: async () => { refreshCalled = true; return Response.json({}); } });
  assert.equal(stillValid.accessToken, 'at2'); assert.equal(refreshCalled, false);

  // 3) 만료된 저장 세션은 refresh를 시도하고 성공하면 갱신된 세션을 저장/반환한다.
  store.set('sp-auth-session-v1', JSON.stringify({ accessToken: 'old', refreshToken: 'rt3', expiresAt: Date.now() - 1000 }));
  const refreshed = await resolveSession(CONFIG, { hash: '', storage, fetchImpl: async () => Response.json({ access_token: 'at3', refresh_token: 'rt3b', expires_in: 3600 }) });
  assert.equal(refreshed.accessToken, 'at3');
  assert.equal(JSON.parse(store.get('sp-auth-session-v1')).accessToken, 'at3');

  // 4) refresh마저 실패하면 저장된 세션을 지우고 null - 로그아웃 상태로 안전하게 떨어진다.
  store.set('sp-auth-session-v1', JSON.stringify({ accessToken: 'old2', refreshToken: 'rt4', expiresAt: Date.now() - 1000 }));
  const failedRefresh = await resolveSession(CONFIG, { hash: '', storage, fetchImpl: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }) });
  assert.equal(failedRefresh, null);
  assert.equal(store.has('sp-auth-session-v1'), false);

  // 5) 아무 세션도 없으면 null.
  store.clear();
  assert.equal(await resolveSession(CONFIG, { hash: '', storage, fetchImpl: async () => Response.json({}) }), null);
});

test('signOut: 서버 로그아웃 호출 후 로컬 세션을 지우고, 네트워크 오류가 나도 로컬 세션은 반드시 지운다', async () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
  store.set('sp-auth-session-v1', JSON.stringify({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 1000 }));
  const calls = [];
  await signOut(CONFIG, { accessToken: 'at' }, async (url, init) => { calls.push({ url: String(url), init }); return new Response(null, { status: 204 }); }, storage);
  assert.ok(calls[0].url.includes('/auth/v1/logout'));
  assert.equal(calls[0].init.headers.Authorization, 'Bearer at');
  assert.equal(store.has('sp-auth-session-v1'), false);

  store.set('sp-auth-session-v1', JSON.stringify({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 1000 }));
  await signOut(CONFIG, { accessToken: 'at' }, async () => { throw new TypeError('network down'); }, storage);
  assert.equal(store.has('sp-auth-session-v1'), false, '네트워크 오류가 나도 로그아웃이 "멈춰있지" 않고 로컬 세션은 지운다');
});

test('userIdFromAccessToken: JWT의 sub만 읽고, 잘못된 토큰은 null (신뢰는 RLS가 담당, 여기선 id만 읽는다)', () => {
  assert.equal(userIdFromAccessToken(fakeAccessToken('user-abc')), 'user-abc');
  assert.equal(userIdFromAccessToken('not-a-jwt'), null);
  assert.equal(userIdFromAccessToken(''), null);
  assert.equal(userIdFromAccessToken(undefined), null);
});

test('fetchProfile/saveProfile: 다른 사용자의 프로필을 지정할 방법이 없다 - user_id는 항상 자기 access token의 sub에서만 나온다', async () => {
  const session = { accessToken: fakeAccessToken('me-1') };
  let fetchedUrl;
  const profile = await fetchProfile(CONFIG, session, async url => { fetchedUrl = new URL(url); return Response.json([{ user_id: 'me-1', birth_date: '1994-03-18', sex: 'male', weight_kg: 70 }]); });
  assert.equal(fetchedUrl.searchParams.get('user_id'), 'eq.me-1', 'fetchProfile은 오직 토큰 소유자 자신의 user_id만 조회한다');
  assert.equal(profile.user_id, 'me-1');
  // fetchProfile에는 임의의 다른 user_id를 지정할 파라미터 자체가 없다 (함수 시그니처가 session만 받는다) -
  // 클라이언트 코드 구조상 다른 사용자 프로필을 요청할 방법이 없고, 실제 격리는 Supabase RLS(auth.uid()
  // = user_id, supabase/schema.sql)가 담당한다.
  assert.equal(fetchProfile.length, 2, 'fetchProfile(config, session[, fetchImpl])에는 user_id를 지정할 파라미터가 없다');

  let savedBody, savedUrl, savedHeaders;
  await saveProfile(CONFIG, session, { birthDate: '1994-03-18', sex: 'male', weightKg: 77 }, async (url, init) => {
    savedUrl = new URL(url); savedBody = JSON.parse(init.body); savedHeaders = init.headers;
    return Response.json(savedBody);
  });
  assert.equal(savedBody[0].user_id, 'me-1', 'saveProfile도 항상 토큰 소유자 자신의 user_id로만 쓴다');
  assert.equal(savedHeaders.Authorization, `Bearer ${session.accessToken}`);
  assert.equal(savedHeaders.Prefer, 'resolution=merge-duplicates,return=representation');
  assert.ok(String(savedUrl).includes('/rest/v1/profiles'));

  await assert.rejects(fetchProfile(CONFIG, { accessToken: 'garbage' }, async () => { assert.fail('잘못된 토큰으로 요청하면 안 된다'); }), /로그인 정보/);
});

test('ageYearsFromBirthDate: 만 나이를 생일 기준으로 정확히 계산하고, 미래 날짜·빈 값은 null (나이 자체는 저장하지 않는다, 요청 5)', () => {
  const now = new Date('2026-09-14T00:00:00');
  assert.equal(ageYearsFromBirthDate('1994-03-18', now), 32, '생일이 이미 지났다');
  assert.equal(ageYearsFromBirthDate('1994-09-13', now), 32, '생일이 어제였다');
  assert.equal(ageYearsFromBirthDate('1994-09-15', now), 31, '생일이 아직 안 지났다 - 1살 덜 센다');
  assert.equal(ageYearsFromBirthDate('1994-09-14', now), 32, '생일 당일');
  assert.equal(ageYearsFromBirthDate('2030-01-01', now), null, '미래 날짜는 계산하지 않는다');
  assert.equal(ageYearsFromBirthDate(null, now), null);
  assert.equal(ageYearsFromBirthDate('not-a-date', now), null);
});

test('weightKgFromProfile/dosePatientFromProfile: 체중·나이를 dose analysis가 쓰는 형태로 변환하고, 없는 값은 임의로 채우지 않는다 (요청 9/10)', () => {
  const now = new Date('2026-09-14T00:00:00');
  assert.equal(weightKgFromProfile({ weight_kg: 77 }), 77);
  assert.equal(weightKgFromProfile({ weight_kg: 0 }), null, '0 이하는 유효한 체중이 아니다');
  assert.equal(weightKgFromProfile({ weight_kg: -5 }), null);
  assert.equal(weightKgFromProfile({}), null);
  assert.deepEqual(dosePatientFromProfile({ birth_date: '1994-03-18', weight_kg: 77 }, now), { weightKg: 77, ageYears: 32 });
  assert.deepEqual(dosePatientFromProfile(null, now), { weightKg: null, ageYears: null }, '프로필이 아예 없어도 안전하게 null 쌍을 반환한다');
  assert.deepEqual(dosePatientFromProfile({ weight_kg: 60 }, now), { weightKg: 60, ageYears: null }, '생년월일이 없으면 체중만 전달된다');
});

test('decideGateScreen: 비로그인->login, 로그인+프로필없음->onboarding, 프로필완료->home (요청 17의 시나리오와 1:1 대응)', () => {
  assert.equal(decideGateScreen(null, null), 'login');
  assert.equal(decideGateScreen({ accessToken: 'at' }, null), 'consent-onboarding');
  assert.equal(decideGateScreen({ accessToken: 'at' }, { user_id: 'u1' }), 'home');
});

test('loadConfig: /api/auth/config가 비어있으면(설정 전) null - app.js는 이 신호를 받아도 로그인 화면을 계속 보여준다 (session 없음은 항상 로그인 화면)', async () => {
  _resetConfigCache();
  const configured = await loadConfig(async () => Response.json({ supabaseUrl: 'https://proj.supabase.co', anonKey: 'anon' }));
  assert.deepEqual(configured, { supabaseUrl: 'https://proj.supabase.co', anonKey: 'anon' });
  _resetConfigCache();
  const unconfigured = await loadConfig(async () => Response.json({ supabaseUrl: null, anonKey: null }));
  assert.equal(unconfigured, null);
  _resetConfigCache();
  const networkDown = await loadConfig(async () => { throw new TypeError('offline'); });
  assert.equal(networkDown, null);
  _resetConfigCache();
});

function publishedDocuments(t) {
  const original = structuredClone(CONSENT_DOCUMENTS);
  for (const [key, doc] of Object.entries(CONSENT_DOCUMENTS)) Object.assign(doc, { version: 'test-v1', url: `/test-policies/${key}` });
  t.after(() => { for (const key of Object.keys(original)) Object.assign(CONSENT_DOCUMENTS[key], original[key]); });
}
test('미등록 문서에는 동의할 수 없으며 기존 프로필 사용자는 홈으로 간다', async () => {
  assert.equal(consentDocumentsReady(), false);
  await assert.rejects(saveConsent(CONFIG, { accessToken: 'at' }, { terms: true, privacy: true }, () => assert.fail('미등록 문서는 저장 금지')));
  assert.equal(decideGateScreen({ accessToken: 'at' }, { user_id: 'me' }), 'home');
});
test('약관 동의는 사용자 메타데이터에 문서 버전/URL/시각/선택 거절과 함께 저장하고 다시 읽는다', async t => {
  publishedDocuments(t);
  let stored;
  const fetcher = async (url, init) => {
    assert.equal(new URL(url).pathname, '/auth/v1/user');
    assert.equal(init.headers.Authorization, 'Bearer at');
    if (init.method === 'PUT') stored = JSON.parse(init.body).data.service_consent;
    return Response.json({ user_metadata: { provider_id: 'untouched', service_consent: stored } });
  };
  const consent = await saveConsent(CONFIG, { accessToken: 'at' }, { terms: true, privacy: true, marketing: false }, fetcher);
  assert.equal(consent.marketing.accepted, false);
  assert.equal(consent.terms.version, 'test-v1');
  assert.equal(consent.privacy.url, '/test-policies/privacy');
  assert.ok(Number.isFinite(Date.parse(consent.accepted_at)));
  assert.deepEqual(await fetchConsent(CONFIG, { accessToken: 'at' }, fetcher), consent);
  assert.equal(decideGateScreen({ accessToken: 'at' }, null, consent), 'profile-onboarding');
  assert.equal(hasRequiredConsent({ ...consent, privacy: { accepted: false, version: 'test-v1' } }), false);
  assert.equal(hasRequiredConsent({ ...consent, terms: { accepted: true, version: 'old' } }), false);
});
test('동의 저장/조회 실패와 프로필 조회 실패를 신규 계정으로 간주하지 않는다', async t => {
  publishedDocuments(t);
  const session = { accessToken: fakeAccessToken('me') };
  const failed = async () => Response.json({ message: 'unavailable' }, { status: 503 });
  await assert.rejects(fetchProfile(CONFIG, session, failed));
  await assert.rejects(fetchConsent(CONFIG, session, failed));
  await assert.rejects(saveConsent(CONFIG, session, { terms: true, privacy: true }, failed));
  await assert.rejects(saveConsent(CONFIG, session, { terms: true, privacy: true }, async () => Response.json({ user_metadata: {} })));
  await assert.rejects(saveProfile(CONFIG, session, {}, async () => Response.json([])));
});
test('실제 공급자 활성화 상태를 읽고 Naver authorize 및 추가 scope를 허용하지 않는다', async () => {
  const availability = await fetchProviderAvailability(CONFIG, async (url, init) => {
    assert.equal(new URL(url).pathname, '/auth/v1/settings');
    assert.equal(init.headers.apikey, CONFIG.anonKey);
    return Response.json({ external: { google: true, kakao: false } });
  });
  assert.deepEqual(availability, { google: true, kakao: false });
  assert.throws(() => buildAuthorizeUrl(CONFIG, 'naver', 'https://app.example'));
  assert.equal(new URL(buildAuthorizeUrl(CONFIG, 'google', 'https://app.example')).searchParams.has('scopes'), false);
});
test('OAuth 취소 오류는 해시에서 제거하고 오류로 전달한다', async () => {
  let cleared = false;
  await assert.rejects(resolveSession(CONFIG, { hash: '#error=access_denied', storage: {}, clearHash: () => { cleared = true; } }), /취소/);
  assert.equal(cleared, true);
  assert.equal(parseSessionFromHash('#access_token=a&refresh_token=r'), null);
});
test('로그아웃 서버 실패는 로컬 종료와 구분해서 보고한다', async () => {
  let removed = false;
  const result = await signOut(CONFIG, { accessToken: 'at' }, async () => new Response(null, { status: 503 }), { removeItem() { removed = true; } });
  assert.equal(removed, true);
  assert.equal(result.remoteRevoked, false);
});
