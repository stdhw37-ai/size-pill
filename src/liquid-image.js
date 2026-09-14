// Dedicated read-only image lookup; existing medicine/cache pipelines are unchanged.
const ENDPOINT = 'https://apis.data.go.kr/1471000/DrbEasyDrugInfoService/getDrbEasyDrugList';

// Client-side pouch/bottle auto-crop reads pixel data via canvas, which a cross-origin image URL
// taints unless the remote host sends CORS headers (nedrug.mfds.go.kr does not). Fetching the photo
// here and inlining it as a same-origin data URI keeps canvas access working regardless.
async function embedImage(url, validateUrl) {
  const safeUrl = validateUrl(url);
  if (!safeUrl) return null;
  try {
    const response = await fetch(safeUrl, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const mime = /image\/(?:jpeg|png|webp)/.exec(response.headers.get('content-type') || '')?.[0];
    if (!mime) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 3000000) return null;
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    return `data:${mime};base64,${btoa(binary)}`;
  } catch { return null; }
}

export function packageImageFromPage(html, id, validateUrl) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '');
  const code = clean.match(/<th\b[^>]*>\s*품목기준코드\s*<\/th>\s*<td\b[^>]*>\s*(\d+)\s*<\/td>/i)?.[1];
  if (code !== id) throw new Error('identity');
  const area = clean.match(/<div\b[^>]*class="pc-img"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
  if (area === undefined) throw new Error('layout');
  const images = [...area.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]).filter(tag => /alt="[^"]*포장\/용기정보[^"]*"/.test(tag));
  if (!images.length) return null;
  if (images.length !== 1) throw new Error('ambiguous');
  const src = images[0].match(/\bsrc="([^"]+)"/)?.[1] || '';
  if (/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(src) && src.length <= 3000000) return { imageData: src, imageUrl: '' };
  const url = validateUrl(new URL(src, 'https://nedrug.mfds.go.kr').href);
  if (!url) throw new Error('image');
  return { imageUrl: url };
}

export async function liquidImage(request, env, validateUrl) {
  const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  if (request.method !== 'GET') return json({ error: 'GET 요청만 지원합니다.' }, 405);
  const id = new URL(request.url).searchParams.get('item_seq') || '';
  if (!/^\d{1,20}$/.test(id)) return json({ error: '올바른 품목기준코드가 필요합니다.' }, 400);
  if (!env.MFDS_SERVICE_KEY) return json({ error: '공식 이미지 검색 연결을 준비 중입니다.' }, 503);
  if (env.SEARCH_LIMITER && !(await env.SEARCH_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' })).success) return json({ error: '검색이 너무 잦습니다. 잠시 후 다시 시도해주세요.' }, 429);
  try {
    const sourceUrl = 'https://nedrug.mfds.go.kr/pbp/CCBBB01/getItemDetail?itemSeq=' + id;
    const page = await fetch(sourceUrl, { signal: AbortSignal.timeout(15000) });
    if (!page.ok) throw new Error('page');
    const html = await page.text(); if (html.length > 4000000) throw new Error('size');
    const packageImage = packageImageFromPage(html, id, validateUrl);
    if (packageImage) {
      const embedded = packageImage.imageData ? null : await embedImage(packageImage.imageUrl, validateUrl);
      return json({ status: 'ok', id, ...packageImage, ...(embedded ? { imageData: embedded, imageUrl: '' } : {}), source: '식약처 의약품안전나라 · 포장/용기정보', sourceUrl });
    }
    let key = env.MFDS_SERVICE_KEY.trim(); if (key.includes('%')) key = decodeURIComponent(key);
    const url = new URL(ENDPOINT); url.search = new URLSearchParams({ ServiceKey: key, itemSeq: id, type: 'json', pageNo: '1', numOfRows: '10' });
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error();
    const raw = await response.json(), data = raw.response ?? raw;
    if (!['00', '0'].includes(String(data.header?.resultCode)) || !/^\d+$/.test(String(data.body?.totalCount))) throw new Error();
    let rows = data.body.items?.item ?? data.body.items ?? []; if (rows === '') rows = []; if (!Array.isArray(rows)) rows = [rows];
    if (Number(data.body.totalCount) === 0 && rows.length === 0) return json({ status: 'not_found', id, imageUrl: '' });
    // A name-similar product or an ambiguous response must never supply the selected photo.
    if (rows.length !== 1 || Number(data.body.totalCount) !== 1 || String(rows[0].itemSeq) !== id) return json({ error: '품목기준코드가 일치하는 이미지를 확인하지 못했습니다.' }, 502);
    const row = rows[0], imageUrl = validateUrl(row.itemImage);
    if (row.itemImage && !imageUrl) return json({ error: '공식 이미지 주소를 확인하지 못했습니다.' }, 502);
    const embedded = imageUrl ? await embedImage(imageUrl, validateUrl) : null;
    return json({ status: imageUrl ? 'ok' : 'not_found', id, name: String(row.itemName || ''), company: String(row.entpName || ''), ...(embedded ? { imageData: embedded, imageUrl: '' } : { imageUrl }), source: '식약처 e약은요 · itemImage', sourceUrl: 'https://www.data.go.kr/data/15075057/openapi.do' });
  } catch { return json({ error: '공식 이미지를 조회하지 못했습니다. 다시 시도해주세요.' }, 502); }
}
