import { computeHomography, applyH } from './homography.js';
import { TABLE_PRESETS, BALL_R, TopView, renderOverlay, rectify, tableCorners, ballName, drawBall } from './table.js';
import { detectBalls, detectCorners, classifyBalls, listModels, DEFAULT_MODEL, GeminiError } from './gemini.js';
import { assignNumbers } from './numbers.js';
import { encodeShare, decodeShare, SHARE_KEYS } from './share.js';
import { kvGet, kvSet, listLayouts, getLayout, putLayout, deleteLayout } from './storage.js';

const $ = (s) => document.querySelector(s);
const view = $('#view');
const vctx = view.getContext('2d');
const topView = new TopView($('#top'));
const video = document.createElement('video');
video.playsInline = true;
video.muted = true;

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: DEFAULT_MODEL,
  table: '9ft',
  customL: 2540,
  customW: 1270,
  refineNumbers: true, // ボールを拡大して番号を再判定 (API 呼び出し +1 回)
  uniqueNumbers: true, // 番号を重複させない
  gridPoint: true, // 仮想台のポイント線
  gridHalf: false, // 仮想台の半ポイント線
};

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
  title: '',
  memo: '',
  armed: null, // パレットで選んだ、次に置くボール番号
};

// ---------- 設定 ----------

async function loadSettings() {
  try {
    Object.assign(state.settings, await kvGet('settings'));
    // 提供終了予定の 2.x 系が保存されていたら既定モデルへ移行
    if (/^gemini-[12]\./.test(state.settings.model)) {
      state.settings.model = DEFAULT_MODEL;
      saveSettings();
    }
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
    title: state.title,
    memo: state.memo,
    table: { key: s.table, length: L, width: W, unit: 'mm' },
    balls: state.balls.map((b) => ({ number: b.n, x: +b.x.toFixed(1), y: +b.y.toFixed(1), ...(b.p != null && { p: b.p }) })),
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
    .map((b) => ({ n: Number.isInteger(b.number) ? b.number : -1, x: +b.x, y: +b.y, ...(Number.isFinite(b.p) && { p: b.p }) }))
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
  setTitle(d.title || '');
  setMemo(d.memo || '');
  state.selected = -1;
  state.detections = [];
  updateH();
  renderBallList();
  updatePalette();
  updateHint();
}

function setTitle(t) {
  state.title = t;
  $('#titleInput').value = t;
}

function setMemo(t) {
  state.memo = t;
  $('#memoInput').value = t;
  if (t) $('#memoInput').closest('details').open = true;
}

// ---------- 元に戻す ----------

const undoStack = [];
function pushUndo(snapshot = JSON.stringify(state.balls)) {
  undoStack.push(snapshot);
  if (undoStack.length > 50) undoStack.shift();
  $('#btnUndo').disabled = false;
}

function undo() {
  const snap = undoStack.pop();
  $('#btnUndo').disabled = !undoStack.length;
  if (!snap) return;
  state.balls = JSON.parse(snap);
  state.selected = -1;
  changed();
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
  const def = state.title || $('#layoutSelect').value || new Date().toLocaleString();
  const name = prompt('配置の名前', def)?.trim();
  if (!name) return;
  setTitle(name);
  saveLayout();
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
  pushUndo();
  applyLayout({ ...l.data, title: name });
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

function setStatus(text, kind = '', link = null) {
  const el = $('#status');
  el.textContent = text;
  el.className = `status ${kind}`;
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = link.text;
    el.append(' ', a);
  }
}

function reportError(e) {
  console.error(e);
  if (!(e instanceof GeminiError)) return setStatus(e.message, 'error');
  // 再試行しても直らないエラーで連続検出を回し続けない
  const stopped = e.fatal && $('#chkAuto').checked;
  if (stopped) $('#chkAuto').checked = false;
  const prefix = stopped ? '連続検出を停止しました。' : '';
  if (e.status === 402) {
    setStatus(`${prefix}Gemini API の支払い設定を確認してください (402: クレジット残高・利用上限)。`, 'error', {
      href: 'https://ai.studio/projects',
      text: 'AI Studio の請求設定を開く',
    });
  } else {
    setStatus(prefix + e.message, 'error');
  }
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
    reportError(e);
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
    const onTable = dets
      .map((d) => ({ d, pos: applyH(state.Hi2t, d.cx, d.cy) }))
      .filter(({ pos: [x, y] }) => x > -margin && y > -margin && x < L + margin && y < W + margin);

    // 1 回目の番号を弱い候補として持ち、拡大判定の結果と合わせて割り当てる
    const cands = onTable.map(({ d }) => (d.n >= 0 ? [{ n: d.n, p: 0.3 * (Number.isFinite(d.confidence) ? d.confidence : 1) }] : []));
    let note = '';
    if (state.settings.refineNumbers && onTable.length) {
      setStatus(`${onTable.length} 個の番号を判定中…`, 'busy');
      try {
        const refined = await classifyBalls({
          apiKey: state.settings.apiKey,
          model: state.settings.model,
          source: frame,
          dets: onTable.map(({ d }) => d),
        });
        refined.forEach((cs, i) => {
          if (cs.length) cands[i] = mergeCandidates(cands[i], cs);
        });
      } catch (e) {
        console.error(e);
        note = ` / 番号の再判定に失敗: ${e.message}`;
      }
    }
    const nums = assignNumbers(cands, state.settings.uniqueNumbers);

    state.detections = dets;
    pushUndo();
    state.balls = onTable.map(({ pos: [x, y] }, i) => ({
      n: nums[i].n,
      p: +nums[i].p.toFixed(2),
      x: clamp(x, BALL_R, L - BALL_R),
      y: clamp(y, BALL_R, W - BALL_R),
    }));
    state.selected = -1;
    state.dirty = true;
    saveLayout();
    renderBallList();
    const unsure = state.balls.filter((b) => b.n < 0 || b.p < 0.5).length;
    return `${state.balls.length} 個のボールを配置 (検出 ${dets.length}${unsure ? `, 要確認 ${unsure}` : ''})${note}`;
  });
}

// 1 回目の候補 (弱い) に拡大判定の候補を加算する
function mergeCandidates(weak, strong) {
  const m = new Map();
  for (const c of [...strong, ...weak]) m.set(c.n, Math.min(1, (m.get(c.n) || 0) + c.p));
  return [...m].map(([n, p]) => ({ n, p }));
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
  const vertical = window.innerHeight > window.innerWidth;
  if (topView.L !== L || topView.W !== W || topView.vertical !== vertical) topView.setTable(L, W, vertical);
  const bg = state.bgWanted ? state.bg : null;
  topView.render({
    balls: state.balls,
    selected: state.selected,
    bg,
    ballAlpha: bg ? +$('#opacity').value : 1,
    grid: { point: state.settings.gridPoint, half: state.settings.gridHalf },
  });
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
      grid: { point: state.settings.gridPoint, half: state.settings.gridHalf },
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
  const { landW, landH } = topView;
  const img = rectify(src, state.Ht2i, topView.extent, landW, landH);
  const c = document.createElement('canvas');
  c.width = landW;
  c.height = landH;
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
    if (b.n < 0 || (b.p != null && b.p < 0.5)) tr.classList.add('uncertain');
    const td0 = document.createElement('td');
    const sel = document.createElement('select');
    ballOptions(sel, b.n);
    sel.onchange = () => {
      pushUndo();
      b.n = +sel.value;
      delete b.p; // 手で直したら確定扱い
      changed();
    };
    td0.append(sel);
    const del = document.createElement('button');
    del.textContent = '削除';
    del.onclick = () => {
      pushUndo();
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
  updatePalette();
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
      pushUndo();
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

// ---------- パレット・仮想台での配置 ----------

function buildPalette() {
  const pal = $('#palette');
  for (let n = 0; n <= 15; n++) {
    const btn = document.createElement('button');
    btn.dataset.n = n;
    btn.title = ballName(n);
    const c = document.createElement('canvas');
    c.width = c.height = 68;
    drawBall(c.getContext('2d'), 34, 34, 30, n);
    btn.append(c);
    btn.onclick = () => {
      const idx = state.balls.findIndex((b) => b.n === n);
      if (idx >= 0) {
        state.selected = idx;
        state.armed = null;
      } else {
        state.armed = state.armed === n ? null : n;
      }
      changed(false);
    };
    pal.append(btn);
  }
}

function updatePalette() {
  const placed = new Set(state.balls.map((b) => b.n));
  for (const btn of $('#palette').children) {
    const n = +btn.dataset.n;
    btn.classList.toggle('placed', placed.has(n));
    btn.classList.toggle('armed', state.armed === n);
  }
  $('#layoutHint').textContent =
    state.armed != null
      ? `${ballName(state.armed)} を置く場所を台の上でタップ`
      : 'ボールを選んで台の上をタップすると配置。ドラッグで移動、台の外へドラッグすると削除。';
}

let topDrag = null;
const topCanvas = topView.canvas;
// 台の外 (クッションから半レール以上外) か
const outsideTable = (x, y) => {
  const { L, W } = tableSize();
  const m = topView.rail / 2;
  return x < -m || y < -m || x > L + m || y > W + m;
};

topCanvas.addEventListener('pointerdown', (e) => {
  const [x, y] = topView.eventToTable(e);
  let best = -1, bd = Infinity;
  state.balls.forEach((b, i) => {
    const d = Math.hypot(b.x - x, b.y - y);
    if (d < bd) (bd = d), (best = i);
  });
  // 実寸のボールは小さいので、つかめる範囲は画面上で最低 22px 相当にする
  const r = topCanvas.getBoundingClientRect();
  const mmPerCssPx = topCanvas.width / r.width / topView.s;
  if (best >= 0 && bd < Math.max(BALL_R * 1.8, 22 * mmPerCssPx)) {
    topDrag = { i: best, dx: state.balls[best].x - x, dy: state.balls[best].y - y, before: JSON.stringify(state.balls), out: false };
    state.selected = best;
    state.armed = null;
    topCanvas.setPointerCapture(e.pointerId);
  } else if (state.armed != null && !outsideTable(x, y)) {
    const { L, W } = tableSize();
    pushUndo();
    state.balls.push({ n: state.armed, x: clamp(x, BALL_R, L - BALL_R), y: clamp(y, BALL_R, W - BALL_R) });
    state.selected = state.balls.length - 1;
    state.armed = null;
    return changed();
  } else {
    state.selected = -1;
  }
  changed(false);
});
topCanvas.addEventListener('pointermove', (e) => {
  if (!topDrag) return;
  const [x, y] = topView.eventToTable(e);
  topDrag.out = outsideTable(x, y);
  moveBall(topDrag.i, x + topDrag.dx, y + topDrag.dy);
});
['pointerup', 'pointercancel'].forEach((t) =>
  topCanvas.addEventListener(t, () => {
    if (!topDrag) return;
    if (topDrag.out) {
      state.balls.splice(topDrag.i, 1);
      state.selected = -1;
    }
    if (JSON.stringify(state.balls) !== topDrag.before) pushUndo(topDrag.before);
    topDrag = null;
    changed();
  })
);

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input,select,textarea,dialog')) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    undo();
    e.preventDefault();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected >= 0) {
    pushUndo();
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
  $('#refineNumbers').checked = s.refineNumbers;
  $('#uniqueNumbers').checked = s.uniqueNumbers;
  dlg.showModal();
  if (s.apiKey && !modelsLoaded) refreshModels(s.apiKey);
}

let modelsLoaded = false;
async function refreshModels(apiKey) {
  const el = $('#modelStatus');
  el.textContent = 'モデル一覧を取得中…';
  try {
    const models = await listModels(apiKey);
    const dl = $('#modelList');
    dl.innerHTML = '';
    for (const m of models) dl.append(new Option(m.label, m.id));
    modelsLoaded = true;
    el.textContent = `${models.length} 件のモデルを取得しました`;
  } catch (e) {
    el.textContent = `モデル一覧を取得できません: ${e.message}`;
  }
}

$('#btnListModels').onclick = () => {
  const key = $('#apiKey').value.trim();
  if (key) refreshModels(key);
  else $('#modelStatus').textContent = '先に API キーを入力してください';
};

dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'ok') return;
  const s = state.settings;
  s.apiKey = $('#apiKey').value.trim();
  s.model = $('#model').value.trim() || DEFAULT_MODEL;
  s.customL = +$('#customL').value || 2540;
  s.customW = +$('#customW').value || 1270;
  s.refineNumbers = $('#refineNumbers').checked;
  s.uniqueNumbers = $('#uniqueNumbers').checked;
  saveSettings();
  updateH();
  setStatus('設定を保存しました');
});

// ---------- 入出力 ----------

function download(data, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60);

function exportJSON() {
  download(layoutData(), `layout-${state.title ? safeName(state.title) : stamp()}.json`);
}

// 名前付きで保存した配置をまとめて書き出す
async function exportAllLayouts() {
  const layouts = await listLayouts();
  if (!layouts.length) return setStatus('保存済みの配置がありません', 'error');
  download({ format: 'ball-projection-layouts', version: 1, exportedAt: new Date().toISOString(), layouts }, `layouts-${stamp()}.json`);
  setStatus(`${layouts.length} 件の配置を書き出しました`);
}

// 1 件の配置 (JSON保存の形式) と、まとめて書き出した形式の両方を受け付ける
async function importJSON(file) {
  try {
    const d = JSON.parse(await file.text());
    if (Array.isArray(d.layouts)) return await importLayouts(d.layouts);
    pushUndo();
    applyLayout(d);
    saveLayout();
    setStatus(`${state.balls.length} 個のボールを読み込みました`);
  } catch (e) {
    setStatus(`JSON を読み込めません: ${e.message}`, 'error');
  }
}

async function importLayouts(items) {
  const valid = items.filter((l) => typeof l?.name === 'string' && l.name && Array.isArray(l.data?.balls));
  if (!valid.length) throw new Error('配置が含まれていません');
  const existing = new Set((await listLayouts()).map((l) => l.name));
  const dups = valid.filter((l) => existing.has(l.name));
  const overwrite = dups.length > 0 && confirm(`${valid.length} 件中 ${dups.length} 件が同名です。上書きしますか？ (キャンセルで同名はスキップ)`);
  let n = 0;
  for (const l of valid) {
    if (existing.has(l.name) && !overwrite) continue;
    await putLayout({ name: l.name, savedAt: Number.isFinite(l.savedAt) ? l.savedAt : Date.now(), data: l.data });
    n++;
  }
  await refreshLayoutList();
  setStatus(`${n} 件の配置を取り込みました${valid.length - n ? ` (${valid.length - n} 件スキップ)` : ''}`);
}

// ---------- URL 共有 ----------

function shareURL() {
  const d = layoutData();
  return `${location.origin}${location.pathname}?${encodeShare(d)}`;
}

async function shareLayout() {
  let title = state.title.trim();
  if (!title) {
    title = prompt('共有するタイトル', $('#layoutSelect').value || '')?.trim();
    if (title == null) return;
    setTitle(title);
    saveLayout();
  }
  const url = shareURL();
  if (navigator.share) {
    try {
      await navigator.share({ title: title || 'Ball Projection', url });
      return setStatus('共有しました');
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    setStatus('共有 URL をコピーしました');
  } catch {
    prompt('共有 URL', url);
  }
}

// 起動時に URL の共有パラメータを読み込む。角 (カメラ依存) は今のまま使う
function loadSharedFromURL() {
  let d;
  try {
    d = decodeShare(location.search);
  } catch (e) {
    return setStatus(`共有 URL を読めません: ${e.message}`, 'error');
  }
  if (!d) return;
  const label = d.title ? `「${d.title}」` : '';
  if (!state.balls.length || confirm(`共有された配置${label}を読み込みますか？ 作業中の配置は置き換わります。`)) {
    pushUndo();
    applyLayout(d);
    saveLayout();
    setStatus(`共有された配置${label}を読み込みました (${state.balls.length} 個)`);
  }
  const q = new URLSearchParams(location.search);
  SHARE_KEYS.forEach((k) => q.delete(k));
  const rest = q.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
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
  buildPalette();
  initTabs();
  $('#titleInput').oninput = () => {
    state.title = $('#titleInput').value;
    saveLayout();
  };
  $('#memoInput').oninput = () => {
    state.memo = $('#memoInput').value;
    saveLayout();
  };
  $('#btnUndo').onclick = undo;
  window.addEventListener('resize', () => (state.dirty = true));

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
  for (const [id, key] of [['#chkGridPoint', 'gridPoint'], ['#chkGridHalf', 'gridHalf']]) {
    $(id).checked = state.settings[key];
    $(id).onchange = () => {
      state.settings[key] = $(id).checked;
      saveSettings();
      state.dirty = true;
    };
  }
  $('#chkBg').onchange = () => {
    state.bgWanted = $('#chkBg').checked;
    state.bg = null;
    state.dirty = true;
  };

  $('#btnDeleteBall').onclick = () => {
    if (state.selected < 0) return;
    pushUndo();
    state.balls.splice(state.selected, 1);
    state.selected = -1;
    changed();
  };
  $('#btnClearBalls').onclick = () => {
    if (!state.balls.length) return;
    pushUndo();
    state.balls = [];
    state.detections = [];
    state.selected = -1;
    changed();
  };
  $('#btnExport').onclick = exportJSON;
  const guard = (fn) => () => fn().catch((e) => setStatus(e.message, 'error'));
  $('#btnSaveLayout').onclick = guard(saveNamedLayout);
  $('#btnExportAll').onclick = guard(exportAllLayouts);
  $('#btnShare').onclick = guard(shareLayout);
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
  updatePalette();
  refreshLayoutList().catch((e) => setStatus(`IndexedDB を使えません: ${e.message}`, 'error'));
  listCameras().catch(() => {});
  renderBallList();
  updateHint();
  if (!state.settings.apiKey) setStatus('右上の「設定」で Gemini API キーを入力してください');
  loadSharedFromURL();
  requestAnimationFrame(render);
}

function initTabs() {
  const show = (name) => {
    for (const b of document.querySelectorAll('.tabs [data-tab]')) b.setAttribute('aria-selected', b.dataset.tab === name);
    for (const p of document.querySelectorAll('.tab-panel')) p.hidden = p.id !== `tab-${name}`;
    state.dirty = true;
  };
  for (const b of document.querySelectorAll('.tabs [data-tab]')) {
    b.onclick = () => {
      show(b.dataset.tab);
      state.settings.tab = b.dataset.tab;
      saveSettings();
    };
  }
  show(state.settings.tab === 'camera' ? 'camera' : 'layout');
}

function confirmReset() {
  return confirm('現在の角をクリアして最初から指定しますか？ (キャンセルで既存の角を調整)');
}

init();
