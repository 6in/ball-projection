import { computeHomography, applyH } from './homography.js';
import { TABLE_PRESETS, BALL_R, TopView, renderOverlay, rectify, tableCorners, ballName } from './table.js';
import { detectBalls, detectCorners } from './gemini.js';
import { kvGet, kvSet, listLayouts, getLayout, putLayout, deleteLayout } from './storage.js';

const $ = (s) => document.querySelector(s);
const view = $('#view');
const vctx = view.getContext('2d');
const topView = new TopView($('#top'));
const video = document.createElement('video');
video.playsInline = true;
video.muted = true;

const DEFAULT_SETTINGS = { apiKey: '', model: 'gemini-2.5-flash', table: '9ft', customL: 2540, customW: 1270 };

const state = {
  settings: { ...DEFAULT_SETTINGS },
  mode: null, // 'live' | 'still'
  stream: null,
  still: document.createElement('canvas'),
  corners: [], // 画像座標。corners[i] が tableCorners[i] に対応
  balls: [], // { n, x, y } (mm)
  detections: [], // 直近の検出結果 (画像座標)
  selected: -1,
  editCorners: false,
  Hi2t: null,
  Ht2i: null,
  bg: null,
  bgAt: 0,
  busy: false,
  dirty: true,
};

// ---------- 設定 ----------

async function loadSettings() {
  try {
    Object.assign(state.settings, await kvGet('settings'));
  } catch (e) {
    setStatus(`設定を読み込めません: ${e.message}`, 'error');
  }
}

function saveSettings() {
  kvSet('settings', { ...state.settings }).catch((e) => setStatus(`設定を保存できません: ${e.message}`, 'error'));
}

function tableSize() {
  const s = state.settings;
  if (s.table === 'custom') return { L: +s.customL || 2540, W: +s.customW || 1270 };
  const p = TABLE_PRESETS[s.table] || TABLE_PRESETS['9ft'];
  return { L: p.length, W: p.width };
}

// 配置データ (JSON 保存・IndexedDB 共通の形式)
function layoutData() {
  const { L, W } = tableSize();
  const s = state.settings;
  return {
    table: { key: s.table, length: L, width: W, unit: 'mm' },
    balls: state.balls.map((b) => ({ number: b.n, x: +b.x.toFixed(1), y: +b.y.toFixed(1) })),
    corners: state.corners,
    imageSize: state.mode ? [view.width, view.height] : state.pendingSize || [view.width, view.height],
  };
}

function applyLayout(d) {
  if (!Array.isArray(d?.balls)) throw new Error('balls がありません');
  const t = d.table;
  if (t && TABLE_PRESETS[t.key]) {
    state.settings.table = t.key;
    if (t.key === 'custom') Object.assign(state.settings, { customL: t.length, customW: t.width });
    $('#tableSize').value = t.key;
    saveSettings();
  }
  state.balls = d.balls
    .map((b) => ({ n: Number.isInteger(b.number) ? b.number : -1, x: +b.x, y: +b.y }))
    .filter((b) => Number.isFinite(b.x) && Number.isFinite(b.y));
  if (Array.isArray(d.corners) && d.corners.length <= 4 && Array.isArray(d.imageSize)) {
    const [pw, ph] = d.imageSize;
    if (state.mode) {
      state.corners = d.corners.map(([x, y]) => [(x * view.width) / pw, (y * view.height) / ph]);
    } else {
      // 画像が未読込なら、読込時に setMediaSize で拡縮する
      state.corners = d.corners.map((p) => [...p]);
      state.pendingSize = [pw, ph];
    }
  }
  state.selected = -1;
  state.detections = [];
  updateH();
  renderBallList();
  updateHint();
}

// 作業中の配置を自動保存
let saveTimer;
function saveLayout() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    kvSet('current', layoutData()).catch((e) => setStatus(`配置を保存できません: ${e.message}`, 'error'));
  }, 300);
}

async function loadLayout() {
  try {
    const d = await kvGet('current');
    if (d) applyLayout(d);
  } catch (e) {
    console.warn(e);
  }
}

// 名前付き保存
async function refreshLayoutList(selectName) {
  const sel = $('#layoutSelect');
  const list = await listLayouts();
  sel.innerHTML = '';
  sel.add(new Option(list.length ? '保存済みの配置…' : '保存済みの配置なし', ''));
  for (const l of list) {
    const d = new Date(l.savedAt);
    sel.add(new Option(`${l.name} (${l.data.balls.length}個, ${d.toLocaleString()})`, l.name));
  }
  sel.value = selectName && list.some((l) => l.name === selectName) ? selectName : '';
}

async function saveNamedLayout() {
  const def = $('#layoutSelect').value || new Date().toLocaleString();
  const name = prompt('配置の名前', def)?.trim();
  if (!name) return;
  if ((await getLayout(name)) && name !== $('#layoutSelect').value && !confirm(`「${name}」を上書きしますか？`)) return;
  await putLayout({ name, savedAt: Date.now(), data: layoutData() });
  await refreshLayoutList(name);
  setStatus(`「${name}」を保存しました`);
}

async function loadNamedLayout() {
  const name = $('#layoutSelect').value;
  if (!name) return;
  const l = await getLayout(name);
  if (!l) return setStatus('配置が見つかりません', 'error');
  applyLayout(l.data);
  saveLayout();
  setStatus(`「${name}」を読み込みました`);
}

async function deleteNamedLayout() {
  const name = $('#layoutSelect').value;
  if (!name || !confirm(`「${name}」を削除しますか？`)) return;
  await deleteLayout(name);
  await refreshLayoutList();
  setStatus(`「${name}」を削除しました`);
}

// ---------- ステータス ----------

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${kind}`;
}

function updateHint() {
  let t;
  if (!state.mode) t = 'カメラを開始するか画像を開いてください。';
  else if (state.editCorners && state.corners.length < 4)
    t = `プレイエリアの角 (クッションのノーズ線の交点) をクリック: ${state.corners.length + 1} / 4 点目`;
  else if (state.editCorners) t = '角の丸をドラッグして微調整。1→2 が長辺になっていなければ「角の割当を回転」。';
  else if (state.corners.length < 4) t = '「角を指定」で台の4隅を指定するか「AIで角検出」を押してください。';
  else t = 'ボールはカメラ画像上 / 仮想台上どちらでもドラッグで修正できます。';
  $('#hint').textContent = t;
}

// ---------- 射影 ----------

function updateH() {
  if (state.corners.length === 4) {
    const { L, W } = tableSize();
    const tc = tableCorners(L, W);
    state.Hi2t = computeHomography(state.corners, tc);
    state.Ht2i = computeHomography(tc, state.corners);
  } else {
    state.Hi2t = state.Ht2i = null;
  }
  state.bg = null;
  state.dirty = true;
}

// 4点を時計回りに並べ、画像上で長く見える辺を 1→2 (長辺) に割り当てる
function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let start = 0;
  sorted.forEach((p, i) => {
    if (p[0] + p[1] < sorted[start][0] + sorted[start][1]) start = i;
  });
  const o = [...sorted.slice(start), ...sorted.slice(0, start)];
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  if (d(o[1], o[2]) + d(o[3], o[0]) > d(o[0], o[1]) + d(o[2], o[3])) o.push(o.shift());
  return o;
}

// ---------- メディア ----------

function setMediaSize(w, h) {
  if (view.width === w && view.height === h) return;
  const [pw, ph] = state.pendingSize || [view.width, view.height];
  if (state.corners.length && pw && ph && (pw !== w || ph !== h)) {
    state.corners = state.corners.map(([x, y]) => [(x * w) / pw, (y * h) / ph]);
  }
  state.pendingSize = null;
  view.width = w;
  view.height = h;
  updateH();
}

async function listCameras() {
  const sel = $('#cameraSelect');
  const devices = (await navigator.mediaDevices?.enumerateDevices?.()) || [];
  const cams = devices.filter((d) => d.kind === 'videoinput');
  const cur = sel.value;
  sel.innerHTML = '';
  const auto = new Option('カメラ: 自動 (背面優先)', '');
  sel.add(auto);
  cams.forEach((c, i) => sel.add(new Option(c.label || `カメラ ${i + 1}`, c.deviceId)));
  sel.value = cams.some((c) => c.deviceId === cur) ? cur : '';
}

async function startCamera() {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('このブラウザ/接続ではカメラを使えません (HTTPS か localhost が必要です)', 'error');
    return;
  }
  const deviceId = $('#cameraSelect').value;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: 'environment' } }),
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
  } catch (e) {
    setStatus(`カメラを開始できません: ${e.message}`, 'error');
    return;
  }
  video.srcObject = state.stream;
  await video.play();
  setMediaSize(video.videoWidth, video.videoHeight);
  state.mode = 'live';
  $('#btnCamera').textContent = 'カメラ停止';
  $('#btnFreeze').disabled = false;
  $('#btnFreeze').textContent = '静止';
  $('#placeholder').hidden = true;
  setStatus(`カメラ ${video.videoWidth}×${video.videoHeight}`);
  listCameras();
  updateHint();
}

function stopCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  video.srcObject = null;
  $('#btnCamera').textContent = 'カメラ開始';
  $('#btnFreeze').disabled = true;
  if (state.mode === 'live') state.mode = null;
  $('#placeholder').hidden = !!state.mode;
  updateHint();
}

function toggleFreeze() {
  if (state.mode === 'live') {
    copyToStill(video, video.videoWidth, video.videoHeight);
    state.mode = 'still';
    $('#btnFreeze').textContent = '再開';
  } else if (state.stream) {
    state.mode = 'live';
    $('#btnFreeze').textContent = '静止';
  }
  state.bg = null;
  state.dirty = true;
}

function copyToStill(src, w, h) {
  state.still.width = w;
  state.still.height = h;
  state.still.getContext('2d').drawImage(src, 0, 0, w, h);
}

function openImage(file) {
  const img = new Image();
  img.onload = () => {
    stopCamera();
    copyToStill(img, img.naturalWidth, img.naturalHeight);
    URL.revokeObjectURL(img.src);
    setMediaSize(img.naturalWidth, img.naturalHeight);
    state.mode = 'still';
    state.detections = [];
    state.bg = null;
    state.dirty = true;
    $('#placeholder').hidden = true;
    setStatus(`画像 ${img.naturalWidth}×${img.naturalHeight}`);
    updateHint();
  };
  img.onerror = () => setStatus('画像を読み込めません', 'error');
  img.src = URL.createObjectURL(file);
}

// 現在のフレーム (元解像度)
function currentFrame() {
  if (state.mode === 'live') {
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    return c;
  }
  return state.mode === 'still' ? state.still : null;
}

// ---------- AI ----------

function requireKey() {
  if (state.settings.apiKey) return true;
  setStatus('Gemini API キーを設定してください', 'error');
  openSettings();
  return false;
}

async function withBusy(label, fn) {
  if (state.busy) return;
  state.busy = true;
  document.querySelectorAll('#btnDetect, #btnAutoCorners').forEach((b) => (b.disabled = true));
  setStatus(label, 'busy');
  const t0 = performance.now();
  try {
    const msg = await fn();
    setStatus(`${msg} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    console.error(e);
    setStatus(e.message, 'error');
  } finally {
    state.busy = false;
    document.querySelectorAll('#btnDetect, #btnAutoCorners').forEach((b) => (b.disabled = false));
  }
}

async function runAutoCorners(frame = currentFrame()) {
  const pts = await detectCorners({ apiKey: state.settings.apiKey, model: state.settings.model, source: frame });
  state.corners = orderCorners(pts);
  updateH();
  saveLayout();
  updateHint();
}

function runDetect() {
  if (!state.mode) return setStatus('画像がありません', 'error');
  if (!requireKey()) return;
  const frame = currentFrame();
  return withBusy('ボール検出中…', async () => {
    if (state.corners.length !== 4) {
      setStatus('角が未設定のため AI で角検出中…', 'busy');
      await runAutoCorners(frame);
    }
    // 台の外接矩形 + 余白に切り出して解像度を稼ぐ
    const xs = state.corners.map((p) => p[0]), ys = state.corners.map((p) => p[1]);
    const mx = (Math.max(...xs) - Math.min(...xs)) * 0.06, my = (Math.max(...ys) - Math.min(...ys)) * 0.06;
    const x0 = Math.max(0, Math.min(...xs) - mx), y0 = Math.max(0, Math.min(...ys) - my);
    const x1 = Math.min(frame.width, Math.max(...xs) + mx), y1 = Math.min(frame.height, Math.max(...ys) + my);
    const dets = await detectBalls({
      apiKey: state.settings.apiKey,
      model: state.settings.model,
      source: frame,
      crop: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    });
    const { L, W } = tableSize();
    const margin = BALL_R * 3;
    state.detections = dets;
    state.balls = dets
      .map((d) => {
        const [x, y] = applyH(state.Hi2t, d.cx, d.cy);
        return { n: d.n, x, y };
      })
      .filter((b) => b.x > -margin && b.y > -margin && b.x < L + margin && b.y < W + margin)
      .map((b) => ({ ...b, x: clamp(b.x, BALL_R, L - BALL_R), y: clamp(b.y, BALL_R, W - BALL_R) }));
    state.selected = -1;
    state.dirty = true;
    saveLayout();
    renderBallList();
    return `${state.balls.length} 個のボールを配置 (検出 ${dets.length})`;
  });
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- 描画 ----------

function render(now) {
  requestAnimationFrame(render);
  const live = state.mode === 'live' && video.readyState >= 2;
  if (!live && !state.dirty) return;

  if (state.mode) {
    vctx.drawImage(live ? video : state.still, 0, 0, view.width, view.height);
    drawCameraOverlay();
  }

  if (state.bgWanted && state.Ht2i && state.mode && (!state.bg || (live && now - state.bgAt > 300))) {
    state.bg = buildBackground();
    state.bgAt = now;
  }
  const { L, W } = tableSize();
  if (topView.L !== L || topView.W !== W) topView.setTable(L, W);
  const bg = state.bgWanted ? state.bg : null;
  topView.render({ balls: state.balls, selected: state.selected, bg, ballAlpha: bg ? +$('#opacity').value : 1 });
  state.dirty = false;
}

function drawCameraOverlay() {
  const { L, W } = tableSize();
  if (state.Ht2i) {
    renderOverlay(vctx, state.Ht2i, L, W, state.balls, {
      opacity: +$('#opacity').value,
      showTable: $('#chkTable').checked,
      showBalls: $('#chkBalls').checked,
      showLabels: $('#chkLabels').checked,
      selected: state.selected,
    });
  }
  const lw = Math.max(1.5, view.width / 700);
  if ($('#chkBoxes').checked) {
    vctx.save();
    vctx.strokeStyle = '#ff3df2';
    vctx.lineWidth = lw;
    for (const d of state.detections) vctx.strokeRect(d.box.x0, d.box.y0, d.box.x1 - d.box.x0, d.box.y1 - d.box.y0);
    vctx.restore();
  }
  if (state.editCorners || state.corners.length < 4) {
    const r = hitTolerance() * 0.6;
    vctx.save();
    vctx.strokeStyle = '#ffd400';
    vctx.lineWidth = lw;
    vctx.beginPath();
    state.corners.forEach(([x, y], i) => (i ? vctx.lineTo(x, y) : vctx.moveTo(x, y)));
    if (state.corners.length === 4) vctx.closePath();
    vctx.stroke();
    state.corners.forEach(([x, y], i) => {
      vctx.beginPath();
      vctx.arc(x, y, r, 0, Math.PI * 2);
      vctx.fillStyle = 'rgba(255,212,0,.35)';
      vctx.fill();
      vctx.stroke();
      vctx.fillStyle = '#ffd400';
      vctx.font = `bold ${r * 1.4}px system-ui, sans-serif`;
      vctx.textAlign = 'left';
      vctx.textBaseline = 'bottom';
      vctx.fillText(String(i + 1), x + r, y - r * 0.3);
    });
    vctx.restore();
  }
}

function buildBackground() {
  const frame = state.mode === 'live' ? currentFrame() : state.still;
  const src = frame.getContext('2d').getImageData(0, 0, frame.width, frame.height);
  const tc = topView.canvas;
  const img = rectify(src, state.Ht2i, topView.extent, tc.width, tc.height);
  const c = document.createElement('canvas');
  c.width = tc.width;
  c.height = tc.height;
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

// ---------- ボール一覧 ----------

function ballOptions(sel, value) {
  sel.innerHTML = '';
  for (let n = 0; n <= 15; n++) sel.add(new Option(ballName(n), n));
  sel.add(new Option('?', -1));
  sel.value = value;
}

function renderBallList() {
  const tb = $('#ballList');
  tb.innerHTML = '';
  const counts = {};
  state.balls.forEach((b) => (counts[b.n] = (counts[b.n] || 0) + 1));
  state.balls.forEach((b, i) => {
    const tr = document.createElement('tr');
    if (i === state.selected) tr.className = 'selected';
    if (b.n >= 0 && counts[b.n] > 1) tr.classList.add('dup');
    const td0 = document.createElement('td');
    const sel = document.createElement('select');
    ballOptions(sel, b.n);
    sel.onchange = () => {
      b.n = +sel.value;
      changed();
    };
    td0.append(sel);
    const del = document.createElement('button');
    del.textContent = '削除';
    del.onclick = () => {
      state.balls.splice(i, 1);
      state.selected = -1;
      changed();
    };
    const td3 = document.createElement('td');
    td3.append(del);
    tr.append(td0, cell(b.x), cell(b.y), td3);
    tr.onclick = (e) => {
      if (e.target.closest('select,button')) return;
      state.selected = i;
      changed(false);
    };
    tb.append(tr);
  });
}

function cell(v) {
  const td = document.createElement('td');
  td.className = 'num';
  td.textContent = Math.round(v);
  return td;
}

function changed(persist = true) {
  state.dirty = true;
  renderBallList();
  if (persist) saveLayout();
}

// ---------- ポインタ操作 ----------

function hitTolerance() {
  const r = view.getBoundingClientRect();
  return 18 * (r.width ? view.width / r.width : 1);
}

function viewPoint(e) {
  const r = view.getBoundingClientRect();
  return [((e.clientX - r.left) * view.width) / r.width, ((e.clientY - r.top) * view.height) / r.height];
}

let drag = null;

view.addEventListener('pointerdown', (e) => {
  if (!state.mode) return;
  const p = viewPoint(e);
  const tol = hitTolerance();
  const near = (pts) => {
    let best = -1, bd = Infinity;
    pts.forEach((q, i) => {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) (bd = d), (best = i);
    });
    return { i: best, d: bd };
  };
  if (state.editCorners) {
    const h = near(state.corners);
    if (h.i >= 0 && h.d < tol) drag = { kind: 'corner', i: h.i };
    else if (state.corners.length < 4) {
      state.corners.push(p);
      if (state.corners.length === 4) state.corners = orderCorners(state.corners);
      updateH();
      saveLayout();
      updateHint();
    }
  } else if (state.Ht2i && state.balls.length) {
    const h = near(state.balls.map((b) => applyH(state.Ht2i, b.x, b.y)));
    if (h.d < tol * 1.5) {
      drag = { kind: 'ball', i: h.i };
      state.selected = h.i;
      changed(false);
    }
  }
  if (drag) view.setPointerCapture(e.pointerId);
});

view.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = viewPoint(e);
  if (drag.kind === 'corner') {
    state.corners[drag.i] = p;
    updateH();
  } else {
    const [x, y] = applyH(state.Hi2t, p[0], p[1]);
    moveBall(drag.i, x, y);
  }
});

['pointerup', 'pointercancel'].forEach((t) =>
  view.addEventListener(t, () => {
    if (drag) saveLayout(), renderBallList();
    drag = null;
  })
);

function moveBall(i, x, y) {
  const { L, W } = tableSize();
  state.balls[i].x = clamp(x, BALL_R, L - BALL_R);
  state.balls[i].y = clamp(y, BALL_R, W - BALL_R);
  state.dirty = true;
}

let topDrag = null;
const topCanvas = topView.canvas;
topCanvas.addEventListener('pointerdown', (e) => {
  const [x, y] = topView.eventToTable(e);
  let best = -1, bd = Infinity;
  state.balls.forEach((b, i) => {
    const d = Math.hypot(b.x - x, b.y - y);
    if (d < bd) (bd = d), (best = i);
  });
  if (best >= 0 && bd < BALL_R * 1.8) {
    topDrag = { i: best, dx: state.balls[best].x - x, dy: state.balls[best].y - y };
    state.selected = best;
    topCanvas.setPointerCapture(e.pointerId);
  } else {
    state.selected = -1;
  }
  changed(false);
});
topCanvas.addEventListener('pointermove', (e) => {
  if (!topDrag) return;
  const [x, y] = topView.eventToTable(e);
  moveBall(topDrag.i, x + topDrag.dx, y + topDrag.dy);
});
['pointerup', 'pointercancel'].forEach((t) =>
  topCanvas.addEventListener(t, () => {
    if (topDrag) changed();
    topDrag = null;
  })
);

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input,select,textarea,dialog')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected >= 0) {
    state.balls.splice(state.selected, 1);
    state.selected = -1;
    changed();
    e.preventDefault();
  }
});

// ---------- 設定ダイアログ ----------

const dlg = $('#settingsDialog');

function openSettings() {
  const s = state.settings;
  $('#apiKey').value = s.apiKey;
  $('#model').value = s.model;
  $('#customL').value = s.customL;
  $('#customW').value = s.customW;
  dlg.showModal();
}

dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'ok') return;
  const s = state.settings;
  s.apiKey = $('#apiKey').value.trim();
  s.model = $('#model').value.trim() || 'gemini-2.5-flash';
  s.customL = +$('#customL').value || 2540;
  s.customW = +$('#customW').value || 1270;
  saveSettings();
  updateH();
  setStatus('設定を保存しました');
});

// ---------- 入出力 ----------

function exportJSON() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(layoutData(), null, 2)], { type: 'application/json' }));
  a.download = `layout-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importJSON(file) {
  try {
    applyLayout(JSON.parse(await file.text()));
    saveLayout();
    setStatus(`${state.balls.length} 個のボールを読み込みました`);
  } catch (e) {
    setStatus(`JSON を読み込めません: ${e.message}`, 'error');
  }
}

// ---------- 初期化 ----------

async function init() {
  await loadSettings();

  const ts = $('#tableSize');
  for (const [k, p] of Object.entries(TABLE_PRESETS)) ts.add(new Option(p.label, k));
  ts.value = state.settings.table;
  ts.onchange = () => {
    state.settings.table = ts.value;
    saveSettings();
    updateH();
  };
  ballOptions($('#addBallSelect'), 0);

  $('#btnSettings').onclick = openSettings;
  $('#btnCamera').onclick = () => (state.stream ? stopCamera() : startCamera());
  $('#cameraSelect').onchange = () => state.stream && startCamera();
  $('#btnFreeze').onclick = toggleFreeze;
  $('#fileInput').onchange = (e) => e.target.files[0] && openImage(e.target.files[0]);

  $('#btnEditCorners').onclick = () => {
    state.editCorners = !state.editCorners;
    if (state.editCorners && state.corners.length === 4 && confirmReset()) state.corners = [];
    $('#btnEditCorners').classList.toggle('active', state.editCorners);
    $('#btnEditCorners').textContent = state.editCorners ? '角の指定を終了' : '角を指定';
    view.classList.toggle('editing', state.editCorners);
    updateH();
    updateHint();
  };
  $('#btnRotate').onclick = () => {
    if (state.corners.length !== 4) return;
    state.corners.push(state.corners.shift());
    updateH();
    saveLayout();
  };
  $('#btnClearCorners').onclick = () => {
    state.corners = [];
    updateH();
    saveLayout();
    updateHint();
  };
  $('#btnAutoCorners').onclick = () => {
    if (!state.mode || !requireKey()) return;
    withBusy('角を検出中…', async () => {
      await runAutoCorners();
      return '角を検出しました。ずれていれば「角を指定」で調整してください';
    });
  };
  $('#btnDetect').onclick = runDetect;

  for (const id of ['#opacity', '#chkTable', '#chkBalls', '#chkLabels', '#chkBoxes'])
    $(id).addEventListener('input', () => (state.dirty = true));
  $('#chkBg').onchange = () => {
    state.bgWanted = $('#chkBg').checked;
    state.bg = null;
    state.dirty = true;
  };

  $('#btnAddBall').onclick = () => {
    const { L, W } = tableSize();
    const n = +$('#addBallSelect').value;
    state.balls.push({ n, x: L / 2 + (Math.random() - 0.5) * 100, y: W / 2 + (Math.random() - 0.5) * 100 });
    state.selected = state.balls.length - 1;
    changed();
  };
  $('#btnDeleteBall').onclick = () => {
    if (state.selected < 0) return;
    state.balls.splice(state.selected, 1);
    state.selected = -1;
    changed();
  };
  $('#btnClearBalls').onclick = () => {
    state.balls = [];
    state.detections = [];
    state.selected = -1;
    changed();
  };
  $('#btnExport').onclick = exportJSON;
  const guard = (fn) => () => fn().catch((e) => setStatus(e.message, 'error'));
  $('#btnSaveLayout').onclick = guard(saveNamedLayout);
  $('#btnLoadLayout').onclick = guard(loadNamedLayout);
  $('#btnDeleteLayout').onclick = guard(deleteNamedLayout);
  $('#importInput').onchange = (e) => {
    if (e.target.files[0]) importJSON(e.target.files[0]);
    e.target.value = '';
  };

  setInterval(() => {
    if ($('#chkAuto').checked && state.mode === 'live' && !state.busy && state.settings.apiKey) {
      const iv = Math.max(2, +$('#autoInterval').value || 5) * 1000;
      if (!state.lastAuto || performance.now() - state.lastAuto > iv) {
        state.lastAuto = performance.now();
        runDetect();
      }
    }
  }, 500);

  await loadLayout();
  refreshLayoutList().catch((e) => setStatus(`IndexedDB を使えません: ${e.message}`, 'error'));
  listCameras().catch(() => {});
  renderBallList();
  updateHint();
  if (!state.settings.apiKey) setStatus('右上の「設定」で Gemini API キーを入力してください');
  requestAnimationFrame(render);
}

function confirmReset() {
  return confirm('現在の角をクリアして最初から指定しますか？ (キャンセルで既存の角を調整)');
}

init();
