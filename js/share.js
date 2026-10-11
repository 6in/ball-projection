// URL クエリでの配置共有
//   ?v=1&title=<タイトル>&table=9ft|2540x1270&balls=<番号>_<x>_<y>.<番号>_<x>_<y>...
// 座標は mm の整数。区切りに "_" と "." を使うのは URLSearchParams がエスケープしない文字だから。
// カメラの角座標は撮影環境ごとに違うので含めない。

import { TABLE_PRESETS } from './table.js';

export function encodeShare({ title, table, balls }) {
  const q = new URLSearchParams();
  q.set('v', '1');
  if (title) q.set('title', title);
  q.set('table', table.key !== 'custom' && TABLE_PRESETS[table.key] ? table.key : `${Math.round(table.length)}x${Math.round(table.width)}`);
  q.set('balls', balls.map((b) => `${b.number}_${Math.round(b.x)}_${Math.round(b.y)}`).join('.'));
  return q.toString();
}

// 共有パラメータがなければ null
export function decodeShare(search) {
  const q = new URLSearchParams(search);
  if (!q.has('balls')) return null;
  const t = q.get('table') || '9ft';
  let table;
  if (TABLE_PRESETS[t] && t !== 'custom') {
    table = { key: t, length: TABLE_PRESETS[t].length, width: TABLE_PRESETS[t].width };
  } else {
    const m = /^(\d+)x(\d+)$/.exec(t);
    if (!m) throw new Error(`table が不正です: ${t}`);
    table = { key: 'custom', length: +m[1], width: +m[2] };
  }
  const balls = (q.get('balls') || '')
    .split('.')
    .filter(Boolean)
    .map((s) => {
      const [n, x, y] = s.split('_').map(Number);
      return { number: Number.isInteger(n) && n >= -1 && n <= 15 ? n : -1, x, y };
    })
    .filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y));
  return { title: q.get('title') || '', table, balls };
}

export const SHARE_KEYS = ['v', 'title', 'table', 'balls'];
