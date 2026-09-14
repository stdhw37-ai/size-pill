# 식약처 낱알식별 API 연결 명세

2026-09-12 [공공데이터포털 공식 페이지](https://www.data.go.kr/data/15057639/openapi.do)에 포함된 `swaggerJson`의 요청변수와 응답 `body.items.item` 속성을 직접 확인했습니다. 아래는 문서에 명시된 필드입니다. 실제 인증키로 받은 운영 응답을 확보한 것은 아닙니다.

## 서버 요청

`GET https://apis.data.go.kr/1471000/MdcinGrnIdntfcInfoService03/getMdcinGrnIdntfcInfoList03`

| 식약처 요청변수 | 앱에서 사용하는 값 |
| --- | --- |
| `serviceKey` | Worker의 `MFDS_SERVICE_KEY`; Decoding/Encoding 키 모두 지원 |
| `type` | 항상 `json` |
| `item_name` | 의약품 이름; 기존 앱 API의 `q`도 호환 |
| `entp_name` | 업체명 (선택) |
| `item_seq` | 품목일련번호 (선택) |
| `pageNo` | 1~100; 기존 `page`도 호환 |
| `numOfRows` | 1~20; 화면에서는 20 |

앱의 `/api/medicines`는 이름·업체·품목번호 중 하나 이상을 요구합니다. 입력한 여러 조건은 함께 전달합니다. 이름은 2~80자, 업체명은 80자 이하, 품목번호는 20자리 이하 숫자입니다.

## 공식 응답 필드와 앱 매핑

| 공식 필드 | 앱 응답 필드 / 용도 |
| --- | --- |
| `ITEM_SEQ`, `ITEM_NAME` | `id`, `name`: 품목번호·제품명 |
| `ENTP_NAME`, `ENTP_SEQ` | `company`, `companyId`: 업체명·업체번호 |
| `ITEM_IMAGE` | `imageUrl`: 목록 썸네일과 선택한 제품 사진 |
| `DRUG_SHAPE` | `shape`: 모양 설명, 기존 원형·타원·장방형 모형 선택 |
| `COLOR_CLASS1`, `COLOR_CLASS2` | `colorFront`, `colorBack`: 앞/뒤 색상 |
| `PRINT_FRONT`, `PRINT_BACK` | `printFront`, `printBack`: 앞/뒤 식별표시 |
| `LINE_FRONT`, `LINE_BACK` | `lineFront`, `lineBack`: 앞/뒤 분할선 |
| `LENG_LONG`, `LENG_SHORT`, `THICK` | `long`, `short`, `thick`: mm 치수와 실물크기 모형 |
| `CHART`, `FORM_CODE_NAME` | `description`, `form`: 성상·제형 |
| `CLASS_NAME`, `CLASS_NO` | `className`, `classCode`: 분류명·번호 |
| `ETC_OTC_NAME` | `medicineType`: 전문/일반 구분 |
| `ITEM_ENG_NAME` | `englishName`: 영문 제품명 |
| `ITEM_PERMIT_DATE`, `CHANGE_DATE`, `IMG_REGIST_TS` | `permitDate`, `changed`, `imageDate`: 원문 날짜 |
| `MARK_CODE_FRONT_ANAL`, `MARK_CODE_BACK_ANAL` | `markFront`, `markBack`: 앞/뒤 마크 설명 |
| `MARK_CODE_FRONT_IMG`, `MARK_CODE_BACK_IMG` | `markImageFront`, `markImageBack`: 마크 이미지 |
| `MARK_CODE_FRONT`, `MARK_CODE_BACK` | `markCodeFront`, `markCodeBack`: 마크 코드 |
| `EDI_CODE`, `STD_CD`, `BIZRNO` | `insuranceCode`, `standardCode`, `businessNumber`: 보험·표준·사업자 코드 |

치수 원문도 `dimensionsRaw`에 유지합니다. 빈 값, 0, 음수, 범위(`3~4`), 근삿값은 정확한 치수로 해석하지 않습니다. 장축·단축이 없으면 앞면, 장축·두께가 없으면 옆면을 숨깁니다. `0 < 치수 <= 100 mm`인 숫자만 렌더링합니다.

제품 사진과 마크는 참조용이며 실물크기로 확대하지 않습니다. `mfds.go.kr` 및 하위 도메인의 이미지 URL만 허용하고 HTTP는 HTTPS로 변경합니다. 다른 호스트·빈 URL·로드 실패는 안내 문구로 대체합니다. 색·각인·분할선은 정보로 표시하며 기존 단순 모형에 실제 외형처럼 그리지 않습니다.

JSON의 최상위 `header/body`와 `response.header/body`를 지원합니다. `items` 배열, `items.item` 단건/배열, 빈 `items`를 처리합니다. `resultCode` 성공 여부와 응답 구조를 확인하며 XML 인증 오류/JSON 오류/타임아웃은 502 응답으로 안내합니다. 원본 오류나 인증키는 브라우저에 전달하지 않습니다.

## 기존 Supabase 캐시

기존 프로젝트 `ibewkuwcdeqxbaqtqjcl`의 `public.medicine_search_cache` 사용. 테이블 생성·스키마 변경·새 프로젝트 생성 없이 `cache_key`, `payload`, `expires_at` 열을 그대로 사용합니다.

- `mfds-v3:<SHA-256>` 키에 이름·업체·품목번호·페이지·결과 수를 모두 반영합니다.
- 이전 버전의 필드가 부족한 캐시는 재사용하지 않습니다. 기존 행 삭제는 필요하지 않습니다.
- 24시간 이내 캐시는 그대로 반환하고, 만료/미적중 때 식약처 조회 후 upsert합니다.
- 캐시 장애는 식약처 직접 조회로 대체합니다. 캐시 쓰기는 Worker의 `waitUntil`에서 처리합니다.
- 서버 키는 `SUPABASE_SECRET_KEY` 또는 `SUPABASE_SERVICE_ROLE_KEY`로 설정합니다. 둘 다 있으면 기존 `SUPABASE_SECRET_KEY`가 우선합니다.
- 실제 Supabase 접속과 정책·열 존재 여부는 인증정보를 설정한 뒤 확인해야 합니다.


## 제품 허가정보 및 e약은요 확장 (2026-09-12)

공공데이터포털 공식 페이지의 제품 허가정보 Swagger와 e약은요 요청/출력 표를 직접 확인했습니다. 실제 인증 요청과는 별개인 명세 확인입니다.

| 출처 | 공식 상세기능 URL | 품목번호 요청변수 | 응답 식별자 |
| --- | --- | --- | --- |
| [제품 허가정보](https://www.data.go.kr/data/15095677/openapi.do) | `https://apis.data.go.kr/1471000/DrugPrdtPrmsnInfoService07/getDrugPrdtPrmsnDtlInq06` | `item_seq` | `ITEM_SEQ` |
| [e약은요](https://www.data.go.kr/data/15075057/openapi.do) | `https://apis.data.go.kr/1471000/DrbEasyDrugInfoService/getDrbEasyDrugList` | `itemSeq` | `itemSeq` |

제품 허가정보 서비스 버전은 07이지만 상세조회 기능명은 06입니다. 임의로 동일 버전으로 바꾸면 안 됩니다. e약은요의 인증 파라미터는 공식 표의 `ServiceKey` 대소문자를 사용합니다. 두 API 모두 기존 `MFDS_SERVICE_KEY` 값을 보내며 `type=json`, `pageNo`, `numOfRows`를 지정합니다. 새 키 환경변수는 없습니다.

### 보완 필드

- 허가정보 `ITEM_NAME`, `ENTP_NAME`: 허가 제품명·업체명.
- `MAIN_ITEM_INGR`, `MATERIAL_NAME`, `INGR_NAME`: 유효성분·원료성분·첨가제.
- `ITEM_PERMIT_DATE`, `PERMIT_KIND_NAME`, `ENTP_NO`: 품목허가일·허가/신고 구분·업체허가번호. `ENTP_NO`를 품목허가번호로 표시하지 않습니다.
- `ETC_OTC_CODE`, `CHART`, `CNSGN_MANUF`: 전문/일반·성상·위탁제조업체.
- `STORAGE_METHOD`, `VALID_TERM`, `PACK_UNIT`: 저장방법·유효기간·포장단위.
- `CANCEL_NAME`, `CANCEL_DATE`, `ATC_CODE`, `CHANGE_DATE`: 상태·취소일·ATC·변경일.
- 이 상세조회 명세에는 별도 제형 필드가 없어 제형은 기존 낱알식별 `FORM_CODE_NAME`을 유지합니다.
- e약은요 `itemName`, `entpName`: 제품명·업체명.
- `efcyQesitm`, `useMethodQesitm`: 효능효과·사용법.
- `atpnWarnQesitm`, `atpnQesitm`: 주의사항 경고·주의사항.
- `intrcQesitm`, `seQesitm`, `depositMethodQesitm`: 상호작용·부작용·보관법.
- `openDe`, `updateDe`: 공개일·수정일.

### 병합과 실패 처리

검색 범위는 기존 낱알식별 API 기준입니다. 각 검색 결과의 ID로 보완 API를 조회하고 동일한 ID가 하나만 확인될 때 병합합니다. 이름만 유사한 제품, 다른 ID, 중복 결과, 결과가 잘린 페이지는 병합하지 않습니다. 낱알식별에 없는 제품을 별도로 통합 검색하는 기능은 포함하지 않습니다.

기존 최상위 치수·이미지·모양을 유지하며 `permit`, `easy`에 각각 `{status, data}`를 추가합니다. 상태는 `ok`, `not_found`, `error`, `unmatched`입니다. e약은요 미등록은 주의사항/부작용이 없다는 뜻이 아닙니다. API 장애는 기본 크기 결과를 실패시키지 않습니다.

한 검색에서 20개 제품까지 처리합니다(낱알식별 1회 + 보완 최대 40회 + 캐시 읽기/쓰기). 제품 4개씩 처리하고 개별 보완 요청은 4초, 전체 보완 단계는 12초 제한입니다. 타임아웃도 `error`로 표시합니다. 캐시 적중 때는 세 API 모두 재호출하지 않습니다.

캐시 스키마는 그대로이며 버전은 3입니다. 정상/미등록 결과는 24시간, 오류/불확실한 병합이 포함된 결과는 60초 캐싱합니다. 기존 버전 행을 삭제하거나 SQL을 다시 실행할 필요는 없습니다.

## 액체약 검색 (2026-09-13)

`GET /api/liquids?item_name=코미시럽&pageNo=1&numOfRows=20`은 낱알식별 대신 기존 제품 허가정보의 `getDrugPrdtPrmsnDtlInq06`을 사용합니다. 공식 포털 Swagger에서 `item_name`, `entp_name`, `item_seq`, `PACK_UNIT`을 재확인했습니다. Worker의 검증·호출 제한·오류 처리·Supabase 캐시 테이블을 공유하며, 캐시 키 입력에 `liquid-v1`을 추가해 알약 캐시와 구분합니다. 기존 캐시 삭제·스키마 변경은 없습니다.

허가정보 검색 페이지에서 시럽·현탁액·내복액·내용액·경구용액·경구액으로 명시된 제품을 클라이언트에서 추립니다. 주사·외용·점안·점이·가글·건조·분말 제품명은 제외합니다. 이름/성상으로 명확하지 않은 제형은 누락될 수 있고, 원 API의 페이지마다 적합한 결과가 없을 수 있어 다음 페이지를 제공합니다. 건조시럽의 조제 후 용량을 추정하지 않습니다.

`PACK_UNIT`에 명시된 mL 값만 용량 선택지로 사용합니다. 복수 포장단위와 `20mL × 30포` 등의 포장 개수가 있으므로 자동 선택하지 않습니다. 사용자 확인 후 계산하며, 함량/성분/제품명에서 총 용량을 추론하지 않습니다. 공식 값이 없으면 분율만 표시하거나 사용자가 포장을 확인해 총 용량을 입력합니다.

2026-09-13 로컬 Worker와 설정된 인증정보를 사용한 실제 연결에서 코미시럽 검색 200 / 1개 / `500mL/병`, 텔미암 검색 200 / 12개를 확인했습니다. 이는 당시 검색 응답 확인이며 전체 의약품의 정확성 또는 가용성 보장이 아닙니다.

## 공식 허가사항 원문(PDF) 링크 (2026-09-14)

제품 허가정보 상세조회(`getDrugPrdtPrmsnDtlInq06`) 실제 응답에 `EE_DOC_ID`(효능효과·용법용량 첨부문서), `UD_DOC_ID`(사용상주의사항 첨부문서), `NB_DOC_ID`(전체 첨부문서 - 가장 포괄적인 "공식 허가사항 원문")가 `HTTPS://NEDRUG.MFDS.GO.KR/PBP/CMN/PDFDOWNLOAD/<품목기준코드>/<EE|UD|NB>` 형태로 들어있는 것을 2026-09-14 실제 인증키 호출로 확인했습니다(예: 에도스캡슐 200402284). `src/mfds-enrichment.js`의 `normalizePermit`이 `officialDocUrl`/`efficacyDocUrl`/`precautionDocUrl`로 매핑하며, `nedrug.mfds.go.kr` 호스트만 허용합니다(다른 필드의 `imageUrl`과 같은 허용목록 방식).

## DUR(의약품안전사용서비스) 품목정보 - 용량주의/투여기간주의 (2026-09-14, 활용신청 승인 후 재확인 완료)

공공데이터포털 [식품의약품안전처_의약품안전사용서비스(DUR)품목정보](https://www.data.go.kr/data/15059486/openapi.do)의 swaggerJson을 직접 확인했습니다: host `apis.data.go.kr/1471000/DURPrdlstInfoService03`, 연결한 두 상세기능은 `getCpctyAtentInfoList03`(용량주의)·`getMdctnPdAtentInfoList03`(투여기간주의)이며 응답 필드는 `INGR_NAME`(DUR성분), `ITEM_SEQ`/`ITEM_NAME`, `MAIN_INGR`, `PROHBT_CONTENT`(금기내용), `REMARK`, `NOTIFICATION_DATE`, `CHANGE_DATE` 등입니다. `src/mfds-dur.js`가 이 필드를 그대로 정규화합니다. 같은 스키마를 쓰는 `getSpcifyAgrdeTabooInfoList03`(특정연령대금기)·`getPwnmTabooInfoList03`(임부금기)도 `DUR_SOURCES`에 구조만 등록해뒀습니다(호출은 안 함). 노인주의·효능군중복주의·서방정분할주의·병용금기는 swagger 확인 결과 응답 스키마가 달라(예: 병용금기는 성분 두 개를 짝지어 비교) 이번에는 연결하지 않고 실제 확인한 경로만 `src/mfds-dur.js` 주석에 남겨뒀습니다.

**최초 시도(활용신청 전)**: 이미 정상 응답하던 동일 키로 이 DUR API를 호출하면 HTTP 403 + `{"OpenAPI_ServiceResponse":{"cmmMsgHeader":{"errMsg":"SERVICE_KEY_IS_NOT_REGISTERED_ERROR","returnReasonCode":"30"}}}` 를 받았습니다 - 키 자체는 유효했지만(낱알식별·제품허가정보·e약은요는 정상) 이 DUR API는 별도 활용신청이 필요했습니다.

**활용신청 완료 후 재확인(2026-09-14, 새 키 발급 없이 같은 `MFDS_SERVICE_KEY` 그대로)**: `SERVICE_KEY_IS_NOT_REGISTERED_ERROR`가 더 이상 발생하지 않고 HTTP 200 + `{"header":{"resultCode":"00","resultMsg":"NORMAL SERVICE."}}`로 정상 응답합니다. `itemSeq` 파라미터(camelCase)로 정확히 필터링되는 것도 실제 품목(예: `ITEM_SEQ=198600630`)으로 검증했습니다 - 필터 없이 조회하면 `getCpctyAtentInfoList03` 하나에만 총 6,618건이 있고, `itemSeq=198600630`으로 필터하면 정확히 그 품목 1건만 돌아옵니다. `PROHBT_CONTENT`/`REMARK`는 오래된 품목은 비어 있고(예: 캅토프릴정, 2013년 고시) 최근 갱신된 품목엔 실제 텍스트가 들어 있습니다(예: 코이베스딜정150/12.5밀리그램 `ITEM_SEQ=200805819`의 `PROHBT_CONTENT`: `"이르베사탄 300mg, 히드로클로로티아지드 25mg"`). `src/worker.js`의 `/api/dur`로 실제 재현: 요청→`worker.fetch()` 직접 호출까지 확인했습니다.

상태는 4가지로 구분합니다(`src/mfds-dur.js`): `available`(정상 응답 + 이 품목에 실제 DUR 데이터 있음), `no-data`(정상 응답이지만 이 품목엔 해당 없음 - 예: 에도스캡슐 `ITEM_SEQ=200402284`는 capacity/period 모두 `no-data`), `pending-or-unavailable`(활용신청이 이 계정에 아직 반영되지 않았거나 이 API를 쓸 수 없음 - 키가 틀렸다고 단정하지 않음), `error`(실제 네트워크/스키마 오류). 앱은 `pending-or-unavailable`을 "DUR 안전사용 정보의 API 이용 승인이 아직 반영되지 않았거나 현재 조회할 수 없습니다."로 안내합니다(`public/app.js`의 `renderDurBlock`).

투여기간주의는 API 응답에 "N일" 같은 구조화된 숫자 필드가 없고 `PROHBT_CONTENT`/`REMARK` 자유텍스트뿐입니다 - `public/dose-calc.js`의 `parseDurPeriodLimitDays`가 "10일 이상 투여하지 않는다"처럼 아주 단순하고 무조건적인 문장에서만 숫자를 뽑고, "~에 한함"/"다만"/"제외" 같은 조건·예외 표현이 섞여 있으면 절대 숫자를 뽑지 않고 원문만 보여줍니다(실제 관찰한 REMARK 예: "항암제 투여로 인한 구역 및 구토의 방지에 쓰는 제품에 한함" - 이런 문장은 숫자 비교 대상이 아닙니다).

## 제품허가정보 부피 단위 원료 - 실제 성분함량 파싱 보완 (2026-09-14)

듀파락시럽(락툴로오즈액, `ITEM_SEQ=201701391`)의 실제 `MATERIAL_NAME`을 확인한 결과: `총량 : 이 약 100mL 중|성분명 : 락툴로오즈액|분량 : 67|단위 : 밀리리터|성분정보 : 락툴로오즈로서 66.7그램|...` - 이 제품은 원료 자체가 농축액이라 `분량`/`단위`가 질량(mg/g)이 아니라 부피(밀리리터)로 기재되어 있습니다. 기존 `public/dose-calc.js`의 `parseIngredients`는 `단위`가 질량 단위일 때만 mg로 환산했기 때문에 이 경우 성분을 통째로 건너뛰어("제품의 성분 함량 정보(공식 허가정보)를 확인하지 못했습니다") 용량 분석이 아예 시작되지 못했습니다.

`성분정보` 자유텍스트 안에 실제 유효성분 질량("락툴로오즈로서 66.7그램")이 별도로 들어있는 것을 확인해, `단위`가 질량으로 환산되지 않을 때만 `성분정보`에서 `([\d.]+)\s*(그램|그람|g|밀리그램|밀리그람|mg|마이크로그램|mcg|µg)` 패턴을 보조로 읽도록 `parseIngredients`를 보완했습니다(제품명으로 추정한 값이 아니라 문서화된 필드 안의 실제 텍스트만 읽음 - 매칭 실패 시 여전히 건너뜀). 결과: 66.7g = 66700mg, 100mL 기준 농도 667mg/mL - `src/worker.js`의 `/api/liquids?item_seq=201701391` → `parseIngredients`/`concentrationsPerMl`까지 실제 API 응답으로 재현해 확인했습니다.

단, 이 제품은 e약은요(`DrbEasyDrugInfoService`)에 등록 자체가 없어(`easy.status: 'not_found'`) 공식 mg/kg 범위 비교는 여전히 "정확한 용량 비교를 위해 추가 정보가 필요합니다"로 남습니다 - 이건 코드 문제가 아니라 이 제품이 해당 데이터셋에 없는 것이고, 이제는 최소한 "성분 함량을 못 찾음"이 아니라 "성분 함량은 확인됨, 공식 사용법 텍스트만 없음"으로 더 정확하게 구분됩니다.
