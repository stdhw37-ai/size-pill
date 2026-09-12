# 알약 실물크기 검색 앱

기존 HTML에 의약품 이름 검색을 추가했습니다. 제품을 선택하면 식약처 공개 치수로 앞면·옆면 모형을 표시합니다. 제품 사진, 색상, 앞뒤 식별표시, 분할선, 제형·성상과 추가 품목 정보를 확인할 수 있고 업체명·품목번호로 검색 범위를 좁힐 수 있습니다. 처음에는 직접 입력 예시이며 실제 제품 데이터가 아닙니다. 실제 크기 비교에는 기기별 화면 보정이 필요합니다.

## 구성

- `index.html`, `public/app.js`: 검색, 제조사·함량 확인, 제품 선택, 치수 표시, 화면 보정. 기존 액체 측정 화면 유지.
- `src/worker.js`: Cloudflare Worker가 식약처 API를 호출. 인증키는 서버에만 저장.
- `supabase/schema.sql`: 선택적 검색 결과 캐시. 검색어·페이지별 24시간 유효. 로그인/검색 이력 기능은 없음.
- Supabase 장애 시 식약처를 직접 조회합니다. 치수가 없거나 범위로 제공되면 추정하지 않고 해당 방향의 모형을 숨깁니다. 특수 모양·색·각인은 재현하지 않습니다.
- IP별 분당 30회 검색 제한. Cloudflare 분산 제한 특성상 엄밀한 전역 제한은 아닙니다.

## 계정 준비

1. [식약처 의약품 낱알식별 정보](https://www.data.go.kr/data/15057639/openapi.do) 활용신청 후 일반 인증키(Decoding)를 발급받습니다.
2. 기존 Supabase 프로젝트 `ibewkuwcdeqxbaqtqjcl`의 `public.medicine_search_cache`를 그대로 사용합니다. 이미 생성한 테이블에 SQL을 다시 실행할 필요는 없습니다. `supabase/schema.sql`은 기존 구조 참고용입니다.
3. 기존 Supabase 프로젝트 URL과 서버용 Secret key(`sb_secret_…`)를 준비합니다. 기존 `service_role` JWT도 지원합니다. 공개용 publishable/anon 키는 이 서버 캐시에 사용할 수 없습니다.
4. 배포할 Cloudflare 계정으로 로그인합니다.

## 로컬 실행

```bash
npm ci
cp .dev.vars.example .dev.vars
# .dev.vars 파일에 실제 키와 URL 입력 (Git에서 제외됨)
npm run dev
```

터미널의 로컬 주소(기본 `http://localhost:8787`)로 접속합니다. HTML 파일만 직접 열면 검색 서버를 사용할 수 없습니다. Supabase 없이 먼저 확인하려면 `.dev.vars`에서 `SUPABASE_SECRET_KEY`와 `SUPABASE_SERVICE_ROLE_KEY`를 모두 빈 값으로 둡니다.

```bash
npm test
npm run check
```

서버·병합 테스트 19개와 Happy DOM 기반 UI 테스트 6개가 가짜 API 응답으로 필드 매핑, 업체/품목 검색, 페이지 요청, 캐시 적중·장애·버전, 키 보호, 이미지 실패, 치수 누락, 화면 보정, 카메라 요청을 확인합니다. DOM 테스트는 실제 브라우저의 레이아웃이나 카메라 하드웨어를 검증하지 않습니다. 실제 인증키를 사용한 통합 검증과 휴대폰 크기 확인은 아래 절차로 수행하세요.

## Cloudflare 공개 배포

```bash
npx wrangler login
npx wrangler secret put MFDS_SERVICE_KEY
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
# sb_secret_ 키를 쓴다면 대신: npx wrangler secret put SUPABASE_SECRET_KEY
npm run deploy
```

각 `secret put` 명령의 입력창에 해당 값을 입력합니다. Supabase를 생략한다면 관련 두 명령도 생략합니다. 신규 Worker 생성 안내가 나오면 `size-pill` 이름으로 생성합니다. 배포가 끝나면 표시되는 `https://size-pill.<계정 서브도메인>.workers.dev` 주소를 공유할 수 있습니다. 실제 URL은 배포 결과를 확인하세요. `.dev.vars` 값은 배포 시 자동 전송되지 않습니다.

Cloudflare의 Git 빌드를 사용할 경우 빌드 명령은 `npm run build`, 배포 명령은 `npx wrangler deploy`입니다. 런타임 비밀값은 Worker 설정에 등록해야 합니다. HTML과 Worker를 함께 배포하는 Workers Static Assets 방식입니다.

## 공개 전 확인

- 실제 제품 검색 → 제조사·함량 확인 → 선택 → 원본의 장축·단축·두께와 대조.
- 치수가 없는 제품에서 이전 제품 모형이나 임의 치수가 표시되지 않는지 확인.
- 휴대폰과 PC에서 카드의 짧은 변 53.98 mm를 기준선에 맞추고 저장. 자로 모형을 검증. 화면 확대나 모니터 변경 시 다시 보정.
- Supabase 캐시 행이 생성되고 같은 검색에서 재사용되는지 확인. 만료 행은 재검색 때 덮어쓰지만, 다시 검색하지 않은 만료 행은 남으므로 필요 시 SQL의 정리 쿼리를 주기적으로 실행.
- 공공데이터포털 할당량 및 Cloudflare/Supabase 사용량 확인.

## 공식 명세

2026-09-12 공공데이터포털 페이지에 포함된 Swagger에서 확인한 주소:
`https://apis.data.go.kr/1471000/MdcinGrnIdntfcInfoService03/getMdcinGrnIdntfcInfoList03`

요청: `serviceKey`, `item_name`, `entp_name`, `item_seq`, `pageNo`, `numOfRows`, `type=json`.
치수: `LENG_LONG`, `LENG_SHORT`, `THICK`. 품목 식별: `ITEM_SEQ`.

- [식약처 API 및 활용신청](https://www.data.go.kr/data/15057639/openapi.do)
- [Cloudflare Static Assets 설정](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Supabase 서버 키](https://supabase.com/docs/guides/api/creating-routes)
- [Supabase API 접근 제어](https://supabase.com/docs/guides/api/securing-your-api)

약 식별·복용 판단용 서비스가 아니라 공개 치수의 비교 보조 도구입니다. 화면 보정은 물리적 디스플레이의 정확도를 자동 보장하지 않습니다.


## 이번 연동 테스트 순서

1. `.dev.vars.example`을 `.dev.vars`로 복사합니다. `MFDS_SERVICE_KEY`에 식약처 키를, `SUPABASE_SERVICE_ROLE_KEY`에 기존 프로젝트의 service_role 키를 입력합니다. `SUPABASE_URL`에는 기존 프로젝트 주소가 들어 있습니다. `sb_secret_` 키를 사용하는 경우 `SUPABASE_SECRET_KEY`에 넣고 다른 키는 비워둡니다. `.dev.vars`는 Git에 포함되지 않습니다.
2. `npm ci`, `npm test`, `npm run check`, `npm run dev`를 실행합니다. 로컬 주소에서 실제 약 이름을 검색하고 제품 사진·제품명·제조사·품목번호·식별정보를 확인합니다.
3. 업체명 필터를 추가해 검색하고 다음/이전 페이지에서도 조건이 유지되는지 확인합니다. 이름을 비우고 검색 결과의 품목일련번호만 넣어 해당 제품을 찾습니다.
4. 제품을 선택하고 공개된 장축·단축이 입력칸과 앞면 모형에 반영되는지 확인합니다. 옆면에는 두께가 사용됩니다. 치수가 누락된 방향은 모형이 숨겨져야 합니다. 이미지 오류는 안내 문구로 바뀝니다.
5. Supabase Table Editor의 `medicine_search_cache`에 `mfds-v3:` 행이 생성되는지 확인합니다. 동일 조건으로 재검색하면 `payload.fetchedAt`이 유지됩니다. 테스트 행의 `expires_at`을 과거로 바꾸고 재검색하면 조회시간과 만료시간이 갱신됩니다.
6. 카드 짧은 변으로 화면을 보정하고 자로 모형 크기를 확인합니다. 수동 입력·앞/옆면 전환·액체 용량 탭·카메라 권한 허용/거절도 확인합니다. 카메라는 localhost 또는 HTTPS에서 테스트합니다.
7. 브라우저 Network에서 검색 요청이 `/api/medicines`로 가고 `serviceKey` 또는 Supabase 서버 키가 없는지 확인합니다. 사진은 식약처 이미지 주소로 별도 요청됩니다.

공식 필드명과 캐시 동작은 [연동 명세](docs/mfds-api.md)에 정리했습니다. 현재까지 실제 식약처 인증키나 Supabase 서버 키를 설정하지 않았으므로 운영 데이터 조회·캐시 저장·공개 배포는 미검증 상태입니다.


## 세 API 병합 확인

기존 `MFDS_SERVICE_KEY` 하나를 사용합니다. `.dev.vars`와 Supabase 테이블을 새로 만들 필요가 없습니다. `npm test`, `npm run check` 후 `npm run dev`를 실행하고 제품을 선택하세요.

- **성분·허가정보**에서 유효성분, 원료, 허가일, 허가 상태를 확인합니다.
- **복약정보(e약은요)**에서 효능·사용법·경고·주의사항·상호작용·부작용·보관법을 확인합니다.
- e약은요 미등록 제품은 제공 정보 없음으로, API 장애는 조회 실패로 구분됩니다. 크기 모형은 계속 사용할 수 있습니다.
- 캐시 `payload.items`에 `permit`과 `easy`가 저장되고 각각 `status`가 있는지 확인합니다. 같은 검색에서는 `fetchedAt`이 유지됩니다.
- 부분 실패일 때 `payload.partial=true`이며 60초 후 재검색 시 다시 조회합니다. 정상 결과의 캐시는 24시간입니다.

병합은 품목번호 정확 일치만 허용하며, 검색 대상 자체는 낱알식별 등록 제품입니다. 요청량 관리를 위해 `numOfRows`는 최대 20입니다. [공식 URL·필드 및 병합 정책](docs/mfds-api.md)을 참고하세요.

## 모바일 앱 (Capacitor)

`android/`, `ios/`는 Capacitor로 생성한 네이티브 프로젝트입니다. 웹(`dist/`)을 그대로 감싸며, MFDS/Supabase 인증키는 앱에 포함되지 않고 계속 Cloudflare Worker 서버에만 있습니다 — 네이티브 앱은 배포된 Worker를 `public/app.js`의 `NATIVE_API_BASE`로 지정한 HTTPS 주소로 호출할 뿐입니다.

**출시 전 필수 작업**
1. `capacitor.config.json`의 `appId`(현재 `com.example.sizepill` 임시값)를 실제 값으로 변경.
2. `public/app.js`의 `NATIVE_API_BASE`를 실제 배포한 Worker 주소(`npm run deploy` 결과 URL)로 변경.
3. `public/icons/`, `resources/icon.png`, `resources/splash.png`는 임시 플레이스홀더 — 실제 아이콘으로 교체 후 `npx capacitor-assets generate`로 각 플랫폼 규격 생성.
4. `index.html` 하단 개인정보처리방침/이용약관 링크(`#privacyLink`, `#termsLink`)를 실제 게시된 URL로 교체.

**Android 빌드**
```bash
npm run cap:sync           # dist 빌드 후 android/ios에 복사
npm run cap:open:android   # Android Studio에서 android/ 열기
```
Android Studio에서 Build → Generate Signed Bundle/APK로 AAB를 만들거나, CLI로 `cd android && ./gradlew bundleRelease`.

**iOS 빌드** (macOS + Xcode 필요 — 이 저장소는 Linux 환경이라 프로젝트 구조만 생성·검증했고 실제 빌드는 확인하지 못했습니다)
```bash
npm run cap:sync
npm run cap:open:ios       # Xcode에서 ios/App/App.xcworkspace 열기
```
Xcode에서 Signing & Capabilities에 Team을 지정하고 Product → Archive로 App Store Connect 업로드.

카메라 권한은 `android/app/src/main/AndroidManifest.xml`(`CAMERA`)과 `ios/App/App/Info.plist`(`NSCameraUsageDescription`)에 이미 선언되어 있습니다.
