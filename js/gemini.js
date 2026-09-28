// Gemini API (REST) をブラウザから直接呼ぶ

export const DEFAULT_MODEL = 'gemini-3.8-flash';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const endpoint = (model) => `${API}/models/${encodeURIComponent(model)}:generateContent`;

const BALL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    balls: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          number: { type: 'INTEGER', description: '0 = cue ball, 1-15 = object ball number, -1 = unknown' },
          pattern: { type: 'STRING', enum: ['cue', 'solid', 'stripe', 'unknown'] },
          color: { type: 'STRING' },
          box_2d: {
            type: 'ARRAY',
            items: { type: 'INTEGER' },
            description: '[ymin, xmin, ymax, xmax] normalized to 0-1000',
          },
          confidence: { type: 'NUMBER' },
        },
        required: ['number', 'box_2d'],
      },
    },
  },
  required: ['balls'],
};

const BALL_PROMPT = `This image shows a pool (pocket billiards) table.
Detect every billiard ball resting on the playing surface. Ignore balls inside pockets, in ball returns, in racks, or held in hands.
For each ball return:
- box_2d: tight bounding box [ymin, xmin, ymax, xmax] normalized to 0-1000.
- number: 0 for the white cue ball, otherwise the ball number 1-15. Standard colors:
  1 yellow, 2 blue, 3 red, 4 purple, 5 orange, 6 green, 7 maroon/brown, 8 black (solids),
  9 yellow, 10 blue, 11 red, 12 purple, 13 orange, 14 green, 15 maroon (stripes, white with a colored band).
  If the printed number is not readable, infer it from color and solid/stripe. Use -1 only if it cannot be inferred.
- pattern, color, confidence (0-1).
Do not report the same ball twice.`;

const CORNER_SCHEMA = {
  type: 'OBJECT',
  properties: {
    corners: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          point: { type: 'ARRAY', items: { type: 'INTEGER' }, description: '[y, x] normalized to 0-1000' },
        },
        required: ['point'],
      },
    },
  },
  required: ['corners'],
};

const CORNER_PROMPT = `This image shows a pool (pocket billiards) table.
Locate the four corners of the playing surface, defined by the inner edges (noses) of the cushions.
At the corner pockets the cushion is cut away, so use the intersection of the two extended cushion nose lines.
Return exactly 4 points as [y, x] normalized to 0-1000.`;

async function call({ apiKey, model, image, prompt, schema, signal, parts }) {
  const res = await fetch(endpoint(model), {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: parts || [imagePart(image), { text: prompt }],
        },
      ],
      generationConfig: { responseMimeType: 'application/json', responseSchema: schema },
    }),
  });
  const json = await readJSON(res);
  const cand = json.candidates?.[0];
  const text = (cand?.content?.parts || [])
    .filter((p) => !p.thought)
    .map((p) => p.text || '')
    .join('');
  if (!text) throw new Error(`Gemini の応答が空です (${json.promptFeedback?.blockReason || cand?.finishReason || 'unknown'})`);
  return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
}

export class GeminiError extends Error {
  constructor(status, message) {
    super(`Gemini API ${status}: ${message}`);
    this.status = status;
  }
  // 再試行しても直らないエラー (キー不正・クレジット切れ・権限・モデル不在など)
  get fatal() {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

async function readJSON(res) {
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error?.message || msg;
    } catch {}
    throw new GeminiError(res.status, msg);
  }
  return res.json();
}

// generateContent に対応する Gemini モデル (新しい順)
export async function listModels(apiKey) {
  const models = [];
  let pageToken = '';
  do {
    const url = `${API}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const json = await readJSON(await fetch(url, { headers: { 'x-goog-api-key': apiKey } }));
    models.push(...(json.models || []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /^models\/gemini-/.test(m.name))
    .map((m) => ({ id: m.name.slice('models/'.length), label: m.displayName || '' }))
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
}

const imagePart = (image) => ({ inline_data: { mime_type: image.mimeType, data: image.data } });

// crop 範囲を最大 maxSide px に縮小して JPEG base64 にする
function encode(source, crop, maxSide = 1600, upscale = false) {
  const k = upscale ? maxSide / Math.max(crop.w, crop.h) : Math.min(1, maxSide / Math.max(crop.w, crop.h));
  const c = document.createElement('canvas');
  c.width = Math.round(crop.w * k);
  c.height = Math.round(crop.h * k);
  c.getContext('2d').drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, c.width, c.height);
  return { mimeType: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.9).split(',')[1] };
}

const fullCrop = (source) => ({ x: 0, y: 0, w: source.width, h: source.height });

// 戻り値: 画像ピクセル座標の検出結果
export async function detectBalls({ apiKey, model, source, crop = fullCrop(source), signal }) {
  const r = await call({ apiKey, model, image: encode(source, crop), prompt: BALL_PROMPT, schema: BALL_SCHEMA, signal });
  return (r.balls || [])
    .filter((b) => Array.isArray(b.box_2d) && b.box_2d.length === 4)
    .map((b) => {
      const [y0, x0, y1, x1] = b.box_2d;
      const box = {
        x0: crop.x + (x0 / 1000) * crop.w,
        y0: crop.y + (y0 / 1000) * crop.h,
        x1: crop.x + (x1 / 1000) * crop.w,
        y1: crop.y + (y1 / 1000) * crop.h,
      };
      const n = Number.isInteger(b.number) && b.number >= 0 && b.number <= 15 ? b.number : -1;
      return { n, box, cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, confidence: b.confidence };
    });
}

export async function detectCorners({ apiKey, model, source, signal }) {
  const r = await call({ apiKey, model, image: encode(source, fullCrop(source)), prompt: CORNER_PROMPT, schema: CORNER_SCHEMA, signal });
  const pts = (r.corners || [])
    .filter((c) => Array.isArray(c.point) && c.point.length === 2)
    .map(({ point: [y, x] }) => [(x / 1000) * source.width, (y / 1000) * source.height]);
  if (pts.length !== 4) throw new Error(`角を 4 点検出できませんでした (${pts.length} 点)`);
  return pts;
}

const CLASSIFY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    balls: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: { type: 'INTEGER' },
          pattern: { type: 'STRING', enum: ['cue', 'solid', 'stripe', 'unknown'] },
          color: { type: 'STRING' },
          number_visible: { type: 'BOOLEAN', description: 'true if the printed number itself is readable' },
          candidates: {
            type: 'ARRAY',
            description: 'Up to 3 most likely ball numbers, most likely first',
            items: {
              type: 'OBJECT',
              properties: {
                number: { type: 'INTEGER', description: '0 = cue ball, 1-15 = object ball' },
                probability: { type: 'NUMBER', description: '0-1' },
              },
              required: ['number', 'probability'],
            },
          },
        },
        required: ['index', 'candidates'],
      },
    },
  },
  required: ['balls'],
};

const CLASSIFY_PROMPT = (count) => `Each image above is a close-up crop of one pool (pocket billiards) ball, labeled "Ball <index>". There are ${count} balls.
Identify the ball number for each crop. Reference (standard set):
- 0: cue ball, plain white, no number.
- Solids (fully colored with a small white circle holding the number): 1 yellow, 2 blue, 3 red, 4 purple, 5 orange, 6 green, 7 maroon/dark brown, 8 black.
- Stripes (white ball with a wide colored band): 9 yellow, 10 blue, 11 red, 12 purple, 13 orange, 14 green, 15 maroon.
Tips: first decide solid vs stripe (is there white visible outside the number circle?), then the hue. Red (3/11) vs orange (5/13) vs maroon (7/15) are easily confused; compare saturation and darkness. Purple (4/12) can look dark blue. Read the printed digits when visible.
Each number appears at most once in a set, but judge each crop on its own evidence.
Return up to 3 candidates per ball with calibrated probabilities.`;

// 各ボールを拡大して切り出し、番号の候補を確率付きで返す
export async function classifyBalls({ apiKey, model, source, dets, signal, cropSize = 192 }) {
  const parts = [];
  dets.forEach((d, i) => {
    const s = Math.max(d.box.x1 - d.box.x0, d.box.y1 - d.box.y0) * 1.5;
    const crop = { x: d.cx - s / 2, y: d.cy - s / 2, w: s, h: s };
    parts.push({ text: `Ball ${i}:` }, imagePart(encode(source, crop, cropSize, true)));
  });
  parts.push({ text: CLASSIFY_PROMPT(dets.length) });
  const r = await call({ apiKey, model, parts, schema: CLASSIFY_SCHEMA, signal });
  const out = dets.map(() => []);
  for (const b of r.balls || []) {
    if (!Number.isInteger(b.index) || !out[b.index]) continue;
    out[b.index] = (b.candidates || [])
      .filter((c) => Number.isInteger(c.number) && c.number >= 0 && c.number <= 15)
      .map((c) => ({ n: c.number, p: clamp01(+c.probability) }));
  }
  return out;
}

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
