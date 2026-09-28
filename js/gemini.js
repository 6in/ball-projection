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

async function call({ apiKey, model, image, prompt, schema, signal }) {
  const res = await fetch(endpoint(model), {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ inline_data: { mime_type: image.mimeType, data: image.data } }, { text: prompt }],
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

async function readJSON(res) {
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error?.message || msg;
    } catch {}
    throw new Error(`Gemini API ${res.status}: ${msg}`);
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

// crop 範囲を最大 maxSide px に縮小して JPEG base64 にする
function encode(source, crop, maxSide = 1600) {
  const k = Math.min(1, maxSide / Math.max(crop.w, crop.h));
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
