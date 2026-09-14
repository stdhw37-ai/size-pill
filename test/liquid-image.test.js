import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { liquidImage, packageImageFromPage } from '../src/liquid-image.js';
import { imageUrl } from '../src/worker.js';
const original = globalThis.fetch; afterEach(() => { globalThis.fetch = original; });
const page = (id, image='') => `<th scope="row">품목기준코드</th><td>${id}</td><div class="pc-img">${image}</div>`;
const env = { MFDS_SERVICE_KEY:'private-key' }, req = id => new Request('https://app.example/api/liquid-image?item_seq='+id);
test('공식 포장 사진은 상세 페이지의 정확한 품목코드로만 연결한다', async () => {
  const data = 'data:image/jpeg;base64,/9j/AAAA';
  globalThis.fetch = async url => { assert.equal(String(url),'https://nedrug.mfds.go.kr/pbp/CCBBB01/getItemDetail?itemSeq=123'); return new Response(page('123',`<img src="${data}" alt="시험시럽 포장/용기정보">`)); };
  const result = await liquidImage(req('123'),env,imageUrl); const body=await result.json(); assert.equal(body.id,'123'); assert.equal(body.imageData,data); assert.ok(!JSON.stringify(body).includes('private-key'));
  assert.throws(()=>packageImageFromPage(page('124'), '123', imageUrl));
  assert.throws(()=>packageImageFromPage(page('123','<img src="https://evil.example/photo.png" alt="시럽 포장/용기정보">'),'123',imageUrl));
});
test('주석의 사진을 사용하지 않고 e약은요도 품목코드가 일치해야 한다', async () => {
  let calls=0;
  globalThis.fetch = async () => ++calls===1 ? new Response(page('123','<!-- <img src="data:image/jpeg;base64,/9j/AAAA" alt="시럽 포장/용기정보"> -->')) : Response.json({header:{resultCode:'00'},body:{totalCount:1,items:[{itemSeq:'999',itemImage:'https://nedrug.mfds.go.kr/wrong.jpg'}]}});
  assert.equal((await liquidImage(req('123'),env,imageUrl)).status,502);
});
test('e약은요 이미지는 클라이언트 캔버스 접근(포 자동 추출)이 가능하도록 서버에서 내려받아 base64로 내장한다', async () => {
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    if (calls === 1) return new Response(page('123')); // no pc-img match on the detail page
    if (calls === 2) return Response.json({ header: { resultCode: '00' }, body: { totalCount: 1, items: [{ itemSeq: '123', itemImage: 'https://nedrug.mfds.go.kr/photo.jpg' }] } });
    assert.equal(String(url), 'https://nedrug.mfds.go.kr/photo.jpg');
    return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'image/jpeg' } });
  };
  const body = await (await liquidImage(req('123'), env, imageUrl)).json();
  assert.equal(body.status, 'ok'); assert.equal(body.imageUrl, '');
  assert.equal(body.imageData, 'data:image/jpeg;base64,' + Buffer.from([1, 2, 3, 4]).toString('base64'));
});
test('내장 시도가 실패해도 원래 이미지 주소로 성능이 저하될 뿐 실패하지 않는다', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return new Response(page('123'));
    if (calls === 2) return Response.json({ header: { resultCode: '00' }, body: { totalCount: 1, items: [{ itemSeq: '123', itemImage: 'https://nedrug.mfds.go.kr/photo.jpg' }] } });
    return new Response('fail', { status: 500 });
  };
  const body = await (await liquidImage(req('123'), env, imageUrl)).json();
  assert.equal(body.status, 'ok'); assert.equal(body.imageUrl, 'https://nedrug.mfds.go.kr/photo.jpg'); assert.equal(body.imageData, undefined);
});
test('공식 미제공과 일시적 실패를 분리한다', async () => {
  let calls=0;
  globalThis.fetch = async () => ++calls===1 ? new Response(page('123')) : Response.json({header:{resultCode:'00'},body:{totalCount:0,items:[]}});
  assert.equal((await (await liquidImage(req('123'),env,imageUrl)).json()).status,'not_found');
  globalThis.fetch = async () => { throw new Error('private-key'); };
  const response=await liquidImage(req('123'),env,imageUrl);assert.equal(response.status,502);assert.ok(!(await response.text()).includes('private-key'));
});
