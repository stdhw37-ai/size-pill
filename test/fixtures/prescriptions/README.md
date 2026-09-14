# Prescription fixture dataset

OCR/vision 알고리즘을 고치기 전에 같은 입력 전체에 대해 측정하기 위한 데이터셋입니다. 앱의 제품 검색·의학적 판단은 평가하지 않습니다.

## 구성과 현재 범위

```text
test/fixtures/prescriptions/
  dataset.json                 # 모든 fixture 등록, 출처·유형·이미지 상태
  labels.schema.json           # 정답 JSON Schema v1
  cases/
    current-reference/         # 제공된 실제 처방전의 4행 정답; 원본 이미지 없음
      labels.json
      ocr.json                 # 사용자가 제공한 텍스트, engine output 아님
    reference-rendered/        # 같은 4행을 새로 그린 합성 표
    borderless/                # 표 선 없음, 코드 없음
    wrapped/                   # 두 줄 약명
    reordered/                 # 투여량 열이 약명보다 먼저 나오는 표
    skewed/                    # 3도 회전
    low-light/                 # 밝기·대비 저하
    mobile-simulated/           # 회전·축소·블러로 촬영 모사 (실제 모바일 사진 아님)
    decimal-liquid/            # 0.5정, 15mL/포
      image.png                # 각 합성 case에 존재
      render.svg               # 재생성 가능한 원본 도형
      labels.json
      ocr.json                 # ideal synthetic tokens; 이미지 변형 이전 좌표
  baselines/
    parser.json
    page-ocr.json
    browser-legacy.json
scripts/prescriptions/
  evaluate.mjs                 # 순수 평가 함수
  dataset.mjs                  # manifest/labels 검증, 경로 격리
  adapters.mjs                 # parser·page OCR·실제 vision API 어댑터
  browser-adapter.mjs          # 앱의 실제 브라우저 extractor 실행
  run.mjs                     # 전체 실행·summary·baseline 비교
  generate-fixtures.py         # 개인정보 없는 합성 도형/PNG 생성
```

현재 9건 중 8건이 합성 이미지이며, 실제 병원/환자 표본을 확보한 데이터셋은 아닙니다. `current-reference`는 정답만 받은 상태를 `status: "awaiting-image", image: null`로 명시합니다. 실제 이미지의 정확도를 합성 이미지 점수나 전사문 파서 점수로 대신하지 않습니다.

유형은 `tags`로 중복 지정하고 `layoutFamily`에는 개인/병원을 식별하지 않는 양식 분류를 기록합니다. 지원 태그: `table`, `borderless`, `wrapped-name`, `with-code`, `without-code`, `skewed`, `low-light`, `mobile-photo`, `decimal-dose`, `liquid`, `reordered-columns`. `source`는 `synthetic`, `deidentified`, `transcribed-reference` 중 하나입니다. 촬영 모사와 실제 촬영은 notes/source로 구분하세요.

## 정답 schema

각 이미지마다 독립적인 `labels.json`을 작성합니다. 모든 필드가 필수이며, 코드가 없거나 실제로 판독할 수 없는 값은 `null`입니다. 숫자를 문자열로 쓰지 않습니다. 이 스키마의 양수 조건은 데이터 형식 규칙이며 의학적 적정성 기준이 아닙니다.

```json
{
  "schemaVersion": 1,
  "medications": [
    {
      "productCode": "644913501",
      "rawName": "듀파락-이지시럽/15mL/포",
      "drugName": "듀파락-이지시럽",
      "dosePerAdministration": 1,
      "doseUnit": "포",
      "frequencyPerDay": 3,
      "durationDays": 10
    }
  ]
}
```

`rawName`은 코드·투여량 열을 제외한 약명과 포장/단위 원문입니다. `drugName`에는 하이픈·괄호·함량을 보존합니다. `doseUnit`은 **투여량 수치의 단위**입니다. `15mL/포`에 투여량이 1이면 `1포`로 표기하므로 `doseUnit: "포"`이며 임의로 15mL로 변환하지 않습니다. mL 자체를 처방하는 표는 `mL`, 0.5정은 `dosePerAdministration: 0.5, doseUnit: "정"`입니다.

## 평가 규칙

- 정답은 평가기에만 전달하며 extractor 입력에는 이미지 경로와 취소 신호만 제공합니다. 예측으로 정답을 자동 생성하지 않습니다.
- 행은 코드 정확일치 또는 약명 일치로 일대일 대응시킵니다. 전역 매칭을 사용하므로 행 순서가 달라도 평가됩니다. 같은 약이 반복되면 등장 순서로 대응하고 **용량·횟수·일수는 매칭 점수에 사용하지 않습니다**.
- 문자열은 Unicode NFC와 바깥쪽 공백만 정리합니다. 내부 공백·구두점·하이픈·괄호는 삭제하지 않습니다. 숫자와 단위·코드는 exact match이며 `"0.5"`와 `0.5`는 다릅니다. `null`과 누락된 필드도 다릅니다.
- 약명의 fuzzy는 긴 이름의 문자 1개 편집 및 유사도 0.9 이상만 허용합니다. 약명 속 숫자·구두점이 달라지면 fuzzy를 적용하지 않습니다. 행 대응에 사용할 수 있지만 **주 지표 drugName/fullRow에는 exact만 사용**하고 `drugNameFuzzy`는 별도 참고 지표로 냅니다.
- `fullRow`는 위 **7개 필드 모두 exact 일치**해야 맞습니다. confidence나 needsReview로 오답을 제외하지 않습니다.
- 각 fixture 분모는 `정답 행 수 + 대응되지 않은 추가 예측 행 수`입니다. 누락은 정답 행 오답, 중복/추가 행은 분모 증가로 반영합니다. 전체 summary는 정답 개수 합계/분모 합계인 micro accuracy입니다. 정답·예측이 모두 없는 집합은 N/A입니다. 코드 없는 행은 코드 `null` 일치 여부를 평가합니다.
- 한 extractor의 오류는 해당 fixture의 빈 예측(오답)으로 집계하고 전체 실행을 계속하며 종료 코드는 1입니다. 이미지 대기 fixture는 이미지 평가에서 제외되지만 coverage/skipped에 명시됩니다. `--require-images`로 미확보 이미지도 실패시킬 수 있습니다.
- JSON 보고서에 필드별 정확도, 누락/추가 행 수, 행별 정오표, 예측, 이미지/OCR 입력 해시, 출처별·유형별·양식별 결과를 저장합니다. `--baseline`은 입력·pipeline·source가 같은지 검증한 뒤 지표 하락을 종료 코드 1로 알립니다. 정답/입력이 달라지면 baseline을 별도 검토 후 갱신하세요.

## 실행

네트워크 없이 빠른 파서/평가기 회귀 검증:

```sh
npm run test:prescriptions
npm run eval:prescriptions -- --mode parser --min-full-row 1 --output /tmp/rx-parser.json
npm run eval:prescriptions -- --mode parser --baseline test/fixtures/prescriptions/baselines/parser.json
```

이 모드의 100%는 이상적인 토큰·전사문을 구조화하는 점수이며 **이미지 OCR 정확도가 아닙니다**.

모든 PNG에 실제 로컬 Tesseract를 적용하는 가벼운 페이지 단위 진단:

```sh
npm run eval:prescriptions -- --mode page-ocr --output /tmp/rx-page-ocr.json
```

설치된 한국어·영어 모델만 사용하며 이미지나 모델을 외부에서 다운로드하지 않습니다. 이 모드는 Tesseract PSM 3 + rotateAuto + 기존 parser를 실행합니다. 앱의 브라우저 전처리·재시도·행 crop·extractor 정규화는 포함하지 않으므로 별도 `page-ocr` 지표입니다.

앱의 실제 브라우저 경로(전처리/재인식/결과 정규화 포함):

```sh
# 선택 도구: 설치되어 있지 않을 때만 설치
npm install --no-save --package-lock=false playwright
npx playwright install chromium
# 다른 터미널에서 앱 실행
npm run dev
# 실제 dev 서버 주소 사용
RX_EVAL_APP_URL=http://127.0.0.1:8787 RX_EVAL_PROVIDER=legacy-ocr npm run eval:prescriptions -- --adapter scripts/prescriptions/browser-adapter.mjs --output /tmp/rx-browser.json
```

기존 별도 Playwright 설치를 재사용하려면 `RX_EVAL_PLAYWRIGHT_MODULE`에 해당 `index.mjs` 경로를 지정할 수 있습니다. `RX_EVAL_PROVIDER`는 `legacy-ocr`(기본), `vision`, `auto`(앱처럼 vision 실패 시 OCR fallback)입니다. 보고서의 `actualSources`로 실제 실행된 경로를 확인하세요. 현재 커밋한 브라우저 baseline은 Chromium + `legacy-ocr`이며 vision baseline이 아닙니다.

현재 서버의 vision extractor를 직접 평가(로컬 fallback 없이, 이미지가 지정한 서버/설정된 provider로 전송됨):

```sh
npm run eval:prescriptions -- --mode vision --api-base http://127.0.0.1:8787 --output /tmp/rx-vision.json
```

실행 전에 서버의 vision provider 설정이 필요합니다. API 키는 기존 서버 설정만 사용하며 labels/manifest/보고서에 쓰지 않습니다. 이번 baseline 측정에서는 외부 vision 서비스를 호출하지 않았습니다.

저장된 전체 결과 재평가와 회귀 비교:

```sh
npm run eval:prescriptions -- --predictions /tmp/rx-browser.json --baseline test/fixtures/prescriptions/baselines/browser-legacy.json
```

외부 pipeline 결과는 다음 형태도 지원합니다. 모든 준비된 fixture ID가 필요하며 빠진 예측은 오류입니다. 보고서를 그대로 `--predictions`로 넣는 것도 가능합니다.

```json
{"schemaVersion":1,"pipeline":"my-vision-v1","fixtures":{"reference-rendered":{"source":"vision","medications":[]}}}
```

별도 pipeline은 `--adapter ./path/to/adapter.mjs`로 연결합니다. `export async function extract({imagePath, signal})`에서 `{medications, source}`를 반환하고, 정리할 자원이 있으면 `export async function close()`를 제공합니다. 어댑터는 `signal`을 준수해야 합니다.

## 새 fixture 추가 / 개인정보 규칙

**개인정보가 포함된 실제 처방전 원본을 이 디렉터리, Git, 로그, 보고서에 넣지 마세요.** 환자 이름·생년월일·주민등록번호·연락처·주소·접수번호·바코드/QR·병원/의사 식별정보·사진 배경·EXIF 위치/기기정보를 포함해 검토해야 합니다. 약품 표만 합성 재제작하는 방법을 권장합니다. 실제 촬영 표본은 원본을 별도 안전한 곳에서 처리하고, 복원 가능한 편집 레이어·메타데이터가 없는 비식별 사본만 수동 검수 후 추가하세요. `privacyReviewed: true`는 검수 기록이지 자동 비식별화 보증이 아닙니다.

1. `cases/<익명-id>/image.png`(또는 JPG/WebP)와 사람이 검수한 `labels.json`을 작성합니다. 알고리즘 예측을 정답으로 복사하지 마세요.
2. `dataset.json.fixtures`에 `id`, `image`, `labels`, `status: "ready"`, `source`, `privacyReviewed: true`, `layoutFamily`, `tags`를 등록합니다. 실제 병원 이름 대신 익명 양식 ID를 씁니다.
3. 선택적으로 개인정보를 제거한 OCR 캡처를 `ocr.json`에 추가하고 manifest의 `ocr`로 연결합니다. `provenance: "engine-capture"`, `words` 또는 `text`를 사용하세요. 수작업 전사문은 `manual-transcription`, 가상 좌표는 `synthetic-tokens`로 구분합니다. 전체 환자 OCR 문장은 저장하지 않습니다.
4. 전체 평가를 다시 실행하고 오류·양식별 지표를 검토합니다. 특정 한 장에 맞춰 threshold나 labels를 변경하지 마세요. 비슷한 양식의 사진만 추가해 평균을 높이지 말고 실제 양식 다양성을 유지하세요.
5. `current-reference`의 비식별 이미지가 확보되면 그 항목의 `image` 경로와 `status`를 갱신합니다. 정답 4행은 이미 등록되어 있습니다.

합성 이미지는 Python 표준 라이브러리 + ImageMagick + NanumGothic 폰트로 재생성합니다. 실행 평가에는 생성 도구가 필요 없습니다.

```sh
python3 scripts/prescriptions/generate-fixtures.py
# 다른 폰트 위치인 경우 RX_FIXTURE_FONT=/path/to/font.ttf 지정
```

합성 case의 labels/OCR/PNG는 재생성 시 덮어씁니다. 수동 추가 case는 별도 ID를 사용하세요. 폰트/렌더러 변경으로 이미지 해시가 바뀌면 baseline도 다시 측정해야 합니다.

## 최초 baseline (2026-09-14)

| 범위 | 코드 | 약명 exact | 1회량 | 횟수 | 일수 | 전체 행 exact |
|---|---:|---:|---:|---:|---:|---:|
| 제공 전사문 → parser (4행) | 100% | 100% | 100% | 100% | 100% | 100% |
| 동일 내용 합성 PNG → 실제 브라우저 legacy OCR (4행) | 100% | 25% | 100% | 100% | 100% | 0% |
| 합성 PNG 전체 → 실제 브라우저 legacy OCR (8건) | 65.22% | 30.43% | 60.87% | 52.17% | 65.22% | 0% |

브라우저 전체는 정답 18행, 누락 3행, 추가 5행이며 분모는 23입니다. `rawName`에 코드/숫자 열이 섞이는 기존 extractor 동작과 약명 OCR 오류 때문에 전체 행 exact가 0%입니다. 낮은 점수를 숨기거나 이 작업에서 알고리즘을 고치지 않았습니다. 상세 예측/정오표는 `baselines/browser-legacy.json`에 있습니다.

**실제 원본 테스트 사진의 baseline은 이미지 미제공으로 N/A입니다.** 합성 표 결과는 원본 사진의 정확도가 아니며, 이 작은 bootstrap 세트의 비율은 실사용 정확도 추정치가 아닙니다. 다음 단계에서 비식별 실제 표본과 실제 모바일 촬영 사례를 보강해야 합니다.
