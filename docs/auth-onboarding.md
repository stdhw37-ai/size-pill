# 로그인 / 최초 가입 변경 기록

## 범위

로그인 화면, 최초 동의 단계, 기존 프로필 입력 화면의 온보딩 모드만 변경했다. 처방전/용량/시럽/검색/보관함 동작, Supabase project, DB schema, Worker API, env는 변경하지 않았다. 작업 시작 시 이미 존재하던 index.html/public/app.js/public/ui.css/src/worker.js/test/worker.test.js의 변경은 보존했다.

## 현재 실행 흐름

- 기존 Supabase GoTrue REST 인증, implicit OAuth callback, 토큰 저장/갱신 구조를 재사용한다. 별도 ID/PW 계정이나 provider별 profile은 없다.
- OAuth 성공 시 Supabase가 auth.users 사용자와 auth.identities를 생성하거나 기존 사용자로 인증한다.
- profiles를 사용자 JWT의 sub = user_id로 조회한다. 프로필이 있으면 바로 홈으로 간다.
- 프로필이 없으면 auth user_metadata.service_consent를 읽는다. 필수 동의가 없으면 Step 1, 유효한 필수 동의가 저장되어 있으면 Step 2를 이어간다.
- Step 1 저장 성공 후 기존 profile form을 연다. 선택 입력인 생년월일/성별/체중을 기존 profiles에 저장한 뒤 홈으로 간다. 프로필 편집 화면은 기존 동작을 유지한다.
- 조회 실패는 신규 사용자가 아니다. 오류/재시도로 남기며 프로필이나 동의를 새로 덮어쓰지 않는다. 로그아웃 중 완료되는 저장 요청도 홈으로 재진입시키지 않는다.
- OAuth에서 별도 scope를 추가하지 않는다. 실제 Google authorize 응답의 scope는 `email profile`이었다. 생년월일/성별/체중을 provider 정보에서 자동 복사하지 않는다.

## 약관 문서와 저장

기존 개인정보처리방침/이용약관 링크는 준비 중 alert뿐이며 확정 문서가 없다. 실제 내용 없이 동의를 받았다고 기록하지 않는다. `public/auth.js`의 CONSENT_DOCUMENTS에는 reviewed URL/version이 등록되어야 한다. 현재 null이므로 신규 사용자는 Step 1에서 안내를 보고 멈춘다. 기존 profile 사용자의 재로그인은 영향을 받지 않는다. 마케팅 문서만 없으면 해당 선택 항목을 비활성화하고 필수 문서만으로 진행할 수 있다.

저장 형식은 `PUT /auth/v1/user`의 `data.service_consent`:

```json
{
  "terms": { "accepted": true, "version": "<문서 버전>", "url": "<문서 URL>" },
  "privacy": { "accepted": true, "version": "<문서 버전>", "url": "<문서 URL>" },
  "marketing": { "accepted": false, "version": "<문서 버전 또는 null>", "url": "<문서 URL 또는 null>" },
  "accepted_at": "<클라이언트 ISO 시각>"
}
```

기존 DB/API 구조를 변경하지 않기 위한 사용자 단위 저장이다. user_metadata는 사용자가 수정 가능하며 시각도 클라이언트 기준이므로, 변조 불가능한 감사 원장이나 서버 권한 검사에 사용하면 안 된다. 현재 DB는 동의를 profile insert의 서버 제약으로 강제하지 않는다. 운영에서 신뢰 가능한 동의 증빙이 필요하면 별도의 서버 기록/서버 시각/문서 버전 보존이 후속 작업이다. 기존 사용자의 과거 동의 내역은 추정하거나 소급 생성하지 않았다.

## 계정 연결과 데이터

Supabase 공식 문서: https://supabase.com/docs/guides/auth/auth-identity-linking

Supabase는 이메일 검증을 포함한 자체 identity linking과 로그인한 사용자의 명시적 manual linking을 지원한다. 이 앱은 자체 이메일 비교/자동 병합을 추가하지 않는다. manual linking UI는 없고 해당 프로젝트의 manual linking 설정은 확인되지 않았다. 이메일이 다른 계정을 같은 사람이라고 자동 식별할 수는 없다. 향후 현재 사용자 세션에서 다른 provider를 인증하는 계정 연결 기능을 추가할 수 있도록 user_id 모델을 유지했다.

로컬 schema.sql 기준:
- profiles.user_id → auth.users.id, PK 및 본인 RLS.
- prescriptions.user_id → auth.users.id, 본인 RLS.
- prescription_items → prescriptions.id, 부모 소유자 검사.
- 내 약 보관함(savedMedicinesV1)과 최근 검색은 기기 localStorage이다. 현재 계정별 클라우드 저장/동기화 기능이 아니다. 이번 범위에서는 이동·병합·삭제하지 않았다.

운영 DB의 실제 RLS/trigger 전체와 admin linking 설정은 관리 권한으로 검증하지 않았다. provider에 관계없이 user_id가 같으면 같은 서버 데이터를 보지만, 모든 Google/Kakao 계정이 자동으로 한 계정에 합쳐진다고 보장하지 않는다.

## 로그아웃 / 탈퇴

로그아웃은 로컬 세션을 즉시 제거하고 Supabase `/auth/v1/logout`을 호출한다. 서버 실패/네트워크 오류/시간 초과는 서버 종료 미확인으로 표시한다. 공급자 계정에서 로그아웃하거나 연결을 해제하는 기능은 아니다. 발급된 access JWT의 만료 전 유효성과 세션 갱신 토큰 폐기는 별개다.

회원탈퇴 UI/API는 구현되어 있지 않다. 로컬 SQL의 auth.users 삭제 cascade는 profiles/prescriptions/prescription_items로 이어지지만 실제 탈퇴 실행/재인증/보존 정책/감사 처리/기기 저장약 처리/공급자 토큰 revoke 또는 Kakao unlink는 구현되어 있지 않다. 서비스 계정 삭제, Supabase identity unlink, Google/Kakao의 provider 연결 해제는 구분해야 한다. 이번에 삭제 기능이나 destructive 호출은 추가하지 않았다.

## 실제 연결 검증 (2026-09-16)

기존 .dev.vars의 URL/public key를 이용한 읽기 전용 확인. 키/토큰/사용자 데이터는 기록하지 않았다.
- Supabase `/auth/v1/settings`: Google true, Kakao false, Naver 없음.
- Google `/auth/v1/authorize`: 302 → accounts.google.com, scope email profile.
- Kakao `/auth/v1/authorize`: 400, provider is not enabled. 앱은 공식 디자인을 유지하며 연결 준비 중으로 비활성화한다.
- Naver는 코드상 비활성, 준비 중. 실제 인증 핸들러 없음.
- Google 사용자 인증 완료/콜백/실제 계정 생성까지는 사전 인증된 테스트 세션 또는 사용자 인증이 없어 확인하지 못했다. 브라우저에서 인증 페이지 진입까지만 실제 확인하고, 신규/기존 사용자 이후 흐름은 모의 응답으로 별도 검증한다.

## 정리한 코드

사용하지 않는 `.home-hero` 기본/desktop CSS와 기존 #loginProviders의 일반 버튼/48px/opacity 스타일을 제거했다. 기존 텍스트 전용 버튼 생성기를 공식 에셋·공급자 상태 기반 생성기로 교체했다. 프로필 조회 실패를 null로 삼아 신규 가입으로 보내던 catch를 제거했다. auth/signup과 무관한 handler/CSS는 정리하지 않았다.

## 최종 검증 결과

- `npm run build`: 성공.
- `npm test`: 329 passed, 0 failed, 0 skipped.
- 인증/UI 집중 실행: 102 passed.
- `git diff --check`: 통과.
- Chromium 390px: 공식 이미지 정상 로드, 버튼 56px 및 지정 색상, 실행 오류 없음.
- 320/390/768px: 로그인 가로 overflow 없음.
- 실제 Google 계정 입력 화면(`/v3/signin/identifier`, “Email or phone”) 도달 확인. 사용자 인증 완료는 미검증.
- 모의 OAuth 세션: 필수 동의, 마케팅 거절, 동의 저장 실패/재시도, 새로고침 재개, 프로필 저장 실패/재시도, 기존 사용자 홈 진입, 프로필 조회 실패 시 온보딩 차단, 로그아웃 검증.
- 스크린샷/요약: `artifacts/auth-flow/`. 동의/프로필 스크린샷은 확정 문서를 가정한 테스트 fixture이며 운영 약관 등록을 의미하지 않는다.

변경 파일: index.html, public/app.js, public/auth.js, public/ui.css, test/auth.test.js, test/ui.test.js, public/brand/*, docs/auth-onboarding.md, artifacts/auth-flow/*.
