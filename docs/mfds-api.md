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
