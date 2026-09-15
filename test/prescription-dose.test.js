import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseDailyRegimen,analyzePrescriptionDaily,dailyRangePosition} from '../public/prescription-dose.js';
const actual = JSON.parse(await readFile(new URL('./fixtures/prescriptions/daily-official.json',import.meta.url)));
const row = {dosePerAdministration:1,doseUnit:'캡슐',frequencyPerDay:2,durationDays:60};
const calculate = (item = actual.item, prescription = row, options = {}) => analyzePrescriptionDaily({item,row:prescription,ageYears:32,kind:'pill',...options});
const solid = usage => ({name:'시험약',permit:{data:{materials:'총량 : 1캡슐 중|성분명 : 시험성분|분량 : 300|단위 : 밀리그램'}},easy:{data:{usage}}});

test('실제 MFDS 에도스 응답: 300mg/회 × 2~3회 = 600~900mg/일, 처방은 600mg/일',()=>{
 const result=calculate();const c=result.comparisons[0];
 assert.equal(actual.item.id,'200402284');assert.deepEqual(result.official.perDose,{min:300,max:300});assert.deepEqual(result.official.frequency,{min:2,max:3});
 assert.equal(c.current,600);assert.deepEqual(c.reference,{min:600,max:900});assert.equal(c.position.fraction,0);
 assert.ok(result.original.includes('10일'));assert.equal(c.reference.max,900,'복용기간 숫자는 용량에 섞이지 않는다');
});

test('실제 위치: 600/675/750/825/900 → 0/25/50/75/100%',()=>{
 for(const [current,percent] of [[600,0],[675,25],[750,50],[825,75],[900,100]]){
  const p=dailyRangePosition(current,600,900);assert.equal(p.fraction,percent/100);assert.equal(p.markerPercent,percent);assert.equal(p.status,'within');
 }
 assert.equal(dailyRangePosition(450,600,900).status,'below');assert.equal(dailyRangePosition(450,600,900).fraction,-.5);
 assert.ok(dailyRangePosition(450,600,900).rangeStartPercent>0);
 assert.equal(dailyRangePosition(1200,600,900).status,'above');assert.ok(dailyRangePosition(1200,600,900).rangeEndPercent<100);
 assert.equal(dailyRangePosition(600,600,600).fraction,null);assert.equal(dailyRangePosition(null,600,900),null);assert.equal(dailyRangePosition(600,900,600),null);
});

test('1회량 범위와 하루 횟수 범위를 각각 곱한다; 하루 1회도 정상 파싱',()=>{
 assert.deepEqual(calculate(solid('성인 : 1회 200~300mg을 1일 2~3회 복용')).comparisons[0].reference,{min:400,max:900});
 assert.deepEqual(calculate(solid('성인 : 1회 300mg을 1일 1회 복용')).comparisons[0].reference,{min:300,max:300});
 assert.deepEqual(calculate(solid('성인 : 1일 2회, 1회 300mg을 복용')).comparisons[0].reference,{min:600,max:600});
});

test('체중 기준은 실제 환자 체중이 있을 때만 계산',()=>{
 const text='1회 5~10mg/kg을 1일 2~3회 복용';
 assert.equal(parseDailyRegimen(text).status,'unstructured');
 assert.deepEqual(calculate(solid(text),row,{weightKg:20}).comparisons[0].reference,{min:200,max:600});
});

test('성인/소아 조건을 합치지 않고 선택; 미상 연령·비해당 연령은 비교 보류',()=>{
 const text='성인 : 1회 300mg을 1일 2회 복용\n\n소아 : 1회 100mg을 1일 3회 복용';
 assert.deepEqual(calculate(solid(text)).comparisons[0].reference,{min:600,max:600});
 for(const ageYears of [null,undefined,10,18]) assert.equal(parseDailyRegimen(text,{ageYears}).status,'unstructured');
 assert.deepEqual(parseDailyRegimen('만 12세 이상: 1회 100mg을 1일 2회 복용',{ageYears:15}).perDose,{min:100,max:100});
 assert.equal(parseDailyRegimen('만 12세 이상: 1회 100mg을 1일 2회 복용',{ageYears:10}).status,'unstructured');
});

for(const text of [
 '성인 : 초기 1회 300mg을 1일 2회 복용. 유지 150mg.',
 '성인 : 1회 300mg을 1일 2회 복용합니다.\n\n유지량은 150mg입니다.',
 '성인 : 필요시 1회 300mg을 1일 2회 복용',
 '성인 : 1회 300mg을 1일 최대 3회 복용',
 '성인 : 1회 300mg을 1일 2회 또는 3회 복용',
 '성인 : 질환A는 1회 300mg을 1일 2회, 질환B는 1회 100mg을 1일 4회 복용',
 '성인 : 1회 300mg을 복용. 소아 : 1일 2회 복용',
 '성인 : 1회 300mg을 1일 2회 복용.\n\n1일 900mg까지 복용',
 '성인 : 1회 300mg을 8시간마다 1일 2회 복용',
 '성인 : 1일 최대 900mg 복용',
 '성인 : 1회 300~200mg을 1일 2회 복용',
 '성인 : 1회 300mg을 1일 2~1회 복용'
]) test('모호한 공식 문구는 자동 비교하지 않는다: '+text.slice(0,42),()=>{
 const result=calculate(solid(text));assert.equal(result.official.status,'unstructured');assert.equal(result.comparisons[0].current,600);assert.equal(result.comparisons[0].reference,null);
});

test('공식 정보 없음과 자동 구조화 불가를 구분하며 처방 총량을 보존',()=>{
 const missing=calculate(solid(''));const unstructured=calculate(solid('상태에 따라 투여량을 조절합니다.'));
 assert.equal(missing.official.status,'missing');assert.equal(unstructured.official.status,'unstructured');assert.equal(missing.comparisons[0].current,600);assert.equal(unstructured.comparisons[0].current,600);
});

test('시럽/포: 공식 농도와 명시된 mL/포만 사용하고 모호한 포장량은 계산하지 않는다',()=>{
 const item={permit:{data:{packaging:'15mL/포',materials:'총량 : 이 약 100밀리리터 중|성분명 : 시험성분|분량 : 1000|단위 : 밀리그램'}},easy:{data:{usage:'성인 : 1회 10~15mL를 1일 2~3회 복용'}}};
 const result=calculate(item,{...row,doseUnit:'포'}, {kind:'liquid'});
 assert.equal(result.comparisons[0].current,300);assert.deepEqual(result.comparisons[0].reference,{min:200,max:450});
 item.permit.data.packaging='15mL/포, 30mL/포';assert.equal(calculate(item,{...row,doseUnit:'포'},{kind:'liquid'}).comparisons[0].current,null);
});

test('복합제는 성분별로만 계산하고 단일 공식 mg 범위를 모든 성분에 적용하지 않는다',()=>{
 const item=solid('성인 : 1회 300mg을 1일 2회 복용');item.permit.data.materials+=';총량 : 1캡슐 중|성분명 : 다른성분|분량 : 20|단위 : 밀리그램';
 const result=calculate(item);assert.deepEqual(result.comparisons.map(c=>c.current),[600,40]);assert.ok(result.comparisons.every(c=>c.reference===null));
});

test('제품 함량의 총량 기준을 확인하며 100g나 다른 단위를 1캡슐로 가정하지 않는다',()=>{
 const item=solid('상태에 따라 조절');item.permit.data.materials='총량 : 100그램 중|성분명 : 시험성분|분량 : 300|단위 : 밀리그램';
 assert.equal(calculate(item).comparisons[0].current,null);
 item.permit.data.materials='총량 : 2캡슐 중|성분명 : 시험성분|분량 : 600|단위 : 밀리그램';
 assert.equal(calculate(item).comparisons[0].current,600);
 for(const p of [null,{...row,dosePerAdministration:-1},{...row,frequencyPerDay:0},{...row,frequencyPerDay:1.5},{...row,doseUnit:'mL'}]) assert.equal(calculate(item,p).comparisons[0].current,null);
});

for(const text of ['1회 300mg/m2를 1일 2회 복용','1회 300mg/day를 1일 2회 복용','1회 300mg을 1일 2회 복용\n\n최고 1000mg까지 투여','1회 300mg을 1일 2회 복용\n\n증상에 따라 증감']) test('단위·추가 조건을 잘라 무조건 용량으로 취급하지 않는다: '+text,()=>{
 assert.equal(parseDailyRegimen(text,{ageYears:32}).status,'unstructured');
});
