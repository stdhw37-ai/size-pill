// Server-side prescription vision extraction - the PRIMARY path (see docs at the top of
// public/prescription-extractor.js for the on-device OCR fallback). This file never runs in the
// browser: the provider API key lives only in Worker env vars and is read/used here, so it can never
// leak to the client bundle - see item 4/10 of the request ("API key를 frontend에 절대 노출하면 안 됨").
import { clampMedication, parsedRowToRaw } from '../public/prescription-schema.js';
import { parsePrescriptionWords } from '../public/prescription-parser.js';

export class ProviderNotConfiguredError extends Error {}
// Carries the upstream HTTP status + a short provider message so the Worker/client can show
// "Google Vision 호출 실패: [status] [message]" (item 5/6) without ever echoing the API key or the
// provider's full raw response.
export class VisionProviderError extends Error {
  constructor(message, { status, providerMessage } = {}) {
    super(message);
    this.status = status; this.providerMessage = providerMessage;
  }
}

const PROMPT = `다음은 한국 처방전(조제내역)의 의약품 표 사진입니다. 표의 각 행을 읽어 아래 JSON 스키마로만 답하세요.

각 행에서:
- productCode: 약 이름 앞의 8~9자리 보험/처방 코드 숫자 (없으면 null)
- rawName: 원문 그대로의 약 이름+단위 문자열
- drugName: 코드와 단위를 제외한 약 이름만 (하이픈·괄호·함량은 이름에 포함)
- strengthOrPackage: 처방 단위 원문 (예: "15mL/포", "1캡슐")
- doseUnit: 위 단위에서 개수/용량 단위만 (예: "포", "캡슐", "정", "mL")
- dosePerAdministration: 1회 투여량 숫자
- frequencyPerDay: 1일 투여횟수 숫자
- durationDays: 총 투약일수 숫자
- confidence: 각 필드를 0~1 사이로 얼마나 확신하는지 (productCode, drugName, dose, frequency, duration)

중요:
- 표의 각 열(약 이름 / 1회 투여량 / 1일 투여횟수 / 총 투약일수)을 서로 절대 섞지 마세요. 한 숫자가 다른 열의 숫자와 합쳐지거나(예: "1", "3", "10"을 "19110"으로 합치는 것) 이름 글자와 섞이면 안 됩니다.
- 읽을 수 없거나 확실하지 않은 값은 추측하지 말고 null로 반환하세요. 빈 칸을 채우려고 임의의 숫자를 만들지 마세요.
- 환자 이름·주민등록번호·생년월일·주소·병원명 등 개인정보/식별정보는 절대 출력하지 마세요 - 오직 의약품 행 정보만 반환합니다.`;

const RECORD_TOOL = {
  name: 'record_prescription_medications',
  description: '처방전 표에서 읽은 의약품 행 목록을 구조화된 형태로 기록합니다.',
  input_schema: {
    type: 'object',
    properties: {
      medications: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            productCode: { type: ['string', 'null'] },
            rawName: { type: 'string' },
            drugName: { type: 'string' },
            strengthOrPackage: { type: ['string', 'null'] },
            doseUnit: { type: ['string', 'null'] },
            dosePerAdministration: { type: ['number', 'null'] },
            frequencyPerDay: { type: ['number', 'null'] },
            durationDays: { type: ['number', 'null'] },
            confidence: {
              type: 'object',
              properties: {
                productCode: { type: 'number' }, drugName: { type: 'number' },
                dose: { type: 'number' }, frequency: { type: 'number' }, duration: { type: 'number' }
              }
            }
          },
          required: ['rawName', 'drugName']
        }
      }
    },
    required: ['medications']
  }
};

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch { /* fall through to bracket-scan below */ }
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch { /* give up - caller treats as empty */ } }
  return null;
}

async function callAnthropicVision(env, base64, mimeType, signal) {
  const model = env.PRESCRIPTION_VISION_MODEL || 'claude-sonnet-5';
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': env.PRESCRIPTION_VISION_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: 4096,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: PROMPT }
      ] }],
      tools: [RECORD_TOOL], tool_choice: { type: 'tool', name: RECORD_TOOL.name }
    })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new VisionProviderError('anthropic upstream error', { status: response.status, providerMessage: body?.error?.message });
  }
  const data = await response.json();
  const use = data.content?.find(block => block.type === 'tool_use');
  return use?.input?.medications ?? [];
}

async function callOpenAIVision(env, base64, mimeType, signal) {
  const model = env.PRESCRIPTION_VISION_MODEL || 'gpt-4o';
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.PRESCRIPTION_VISION_API_KEY}` },
    body: JSON.stringify({
      model, response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: [
        { type: 'text', text: `${PROMPT}\n\n다음 JSON 형식으로만, 다른 설명 없이 답하세요: {"medications": [...]}` },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
      ] }]
    })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new VisionProviderError('openai upstream error', { status: response.status, providerMessage: body?.error?.message });
  }
  const data = await response.json();
  const parsed = parseJsonLoose(data.choices?.[0]?.message?.content);
  return parsed?.medications ?? [];
}

// Pure OCR (not a multimodal LLM), so this stays in a genuinely different shape from the two callers
// above: read words+boxes off the actual pixels, then hand them to the SAME structured parser the
// legacy on-device path already uses (public/prescription-parser.js, unmodified - see item "새로운
// OCR 로직을 만들거나 Tesseract parser를 수정하지 말고"). Google Vision's own row/column layout is not
// used; parsePrescriptionWords()'s bbox-based table reconstruction is engine-agnostic and already
// does that job from word positions alone, exactly as it does for Tesseract's word list.
const MERGE_ARTIFACT_RATIO = 1.8; // a "word" taller than this many times the median is a layout glitch

function googleVisionWords(response) {
  const page = response.fullTextAnnotation?.pages?.[0];
  const words = [];
  for (const block of page?.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const word of paragraph.words || []) {
        const vertices = word.boundingBox?.vertices || [];
        const xs = vertices.map(v => v.x || 0), ys = vertices.map(v => v.y || 0);
        if (!xs.length) continue;
        const text = (word.symbols || []).map(s => s.text).join('');
        if (!text.trim()) continue;
        words.push({ text, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), confidence: (word.confidence ?? .9) * 100 });
      }
    }
  }
  if (!words.length) return words;
  const heights = [...words.map(w => w.y1 - w.y0)].sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] || 1;
  // Vision occasionally merges a whole stacked numeric COLUMN (several rows tall) into one spurious
  // "word" spanning all of them (verified against a real response - a genuine table with a normal
  // single-line "10"/"60" in each row ALSO produced one extra multi-row-tall garbage token covering
  // the same column). Anything far taller than a normal single line is that artifact, not real text.
  return words.filter(w => (w.y1 - w.y0) <= medianHeight * MERGE_ARTIFACT_RATIO);
}

async function callGoogleVision(env, base64, mimeType, signal) {
  const key = env.GOOGLE_VISION_API_KEY || env.PRESCRIPTION_VISION_API_KEY;
  const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${key}`, {
    method: 'POST', signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [{ image: { content: base64 }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }] })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new VisionProviderError('google vision upstream error', { status: response.status, providerMessage: body?.error?.message });
  }
  const data = await response.json();
  const result = data.responses?.[0];
  if (result?.error) throw new VisionProviderError('google vision api error', { status: 200, providerMessage: result.error.message });
  const words = googleVisionWords(result || {});
  const rows = parsePrescriptionWords(words);
  return rows.map(parsedRowToRaw);
}

// Adding a provider only ever means one function here plus one line in each of these two maps -
// nothing about the Worker endpoint, the client, or the schema needs to know which provider is active
// (item 4). PROVIDER_KEY_ENV names each provider's OWN dedicated key var (checked first) - google
// specifically uses GOOGLE_VISION_API_KEY, not the generic PRESCRIPTION_VISION_API_KEY, since that is
// the name this app's own .dev.vars already uses for it.
const PROVIDERS = { anthropic: callAnthropicVision, openai: callOpenAIVision, google: callGoogleVision };
const PROVIDER_KEY_ENV = { google: 'GOOGLE_VISION_API_KEY' };

// If PRESCRIPTION_VISION_PROVIDER isn't set but a provider-specific key IS (e.g. only
// GOOGLE_VISION_API_KEY was configured, this app's actual .dev.vars), default to that provider rather
// than requiring both vars set in lockstep - a key with no explicit provider selector is itself an
// unambiguous signal. Exported so src/worker.js can log/report the same resolved name on a failure
// path, where extractPrescriptionVision has already thrown before returning it another way.
export function resolveProviderName(env) {
  return (env.PRESCRIPTION_VISION_PROVIDER || '').trim().toLowerCase() || (env.GOOGLE_VISION_API_KEY ? 'google' : '');
}

// PRESCRIPTION_VISION_PROVIDER/*_API_KEY are read only here, never forwarded to the client. No image
// bytes, provider response, or extracted text are logged anywhere in this path - the caller
// (src/worker.js) discards the request body once this returns (item 8).
export async function extractPrescriptionVision(env, imageBuffer, mimeType, signal) {
  const providerName = resolveProviderName(env);
  const call = PROVIDERS[providerName];
  const key = env[PROVIDER_KEY_ENV[providerName] || 'PRESCRIPTION_VISION_API_KEY'];
  if (!call || !key) throw new ProviderNotConfiguredError('vision_not_configured');
  const base64 = bufferToBase64(imageBuffer);
  const rawMedications = await call(env, base64, mimeType, signal);
  if (!Array.isArray(rawMedications)) throw new Error('malformed provider response');
  return { provider: providerName, medications: rawMedications.map(clampMedication) };
}

function bufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}
