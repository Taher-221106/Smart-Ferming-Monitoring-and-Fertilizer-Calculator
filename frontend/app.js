'use strict';

const state = {
  fieldId: Number(localStorage.getItem('smartFarmingLastFieldId')) || null,
  grid: null,
  vra: null,
  layer: 'N',
  selectedPoint: 1,
  capture: null,
  captureSequence: 0,
  pendingSample: null
};
const $ = (id) => document.getElementById(id);
const SAMPLE_COUNT = 3;
const CAPTURE_TIMEOUT_MS = 100000;
const POLL_INTERVAL_MS = 2500;

function fmt(value, digits = 2) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('bn-BD', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function fmtCoord(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('bn-BD', { maximumFractionDigits: 2 });
}
function pointId(no) { return `P${String(no).padStart(3, '0')}`; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function dateBn(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('bn-BD', { dateStyle: 'medium', timeStyle: 'medium' }).format(date);
}
function translateClass(value) {
  const map = {
    'Very Low': 'খুব কম', 'Low': 'কম', 'Medium': 'মাঝারি',
    'Optimum': 'উপযুক্ত', 'High': 'বেশি', 'Very High': 'খুব বেশি',
    'No Data': 'তথ্য নেই', 'Unknown': 'অজানা'
  };
  return map[value] || value || '—';
}
async function api(url, options) {
  const response = await fetch(url, options);
  let data;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    let message = 'অনুরোধটি সম্পন্ন হয়নি। আবার চেষ্টা করুন।';
    const detail = data?.detail || data?.error;
    if (detail === 'Field not found') message = 'মাঠটি পাওয়া যায়নি। ইতিহাস থেকে মাঠ খুলুন বা নতুন মাঠ তৈরি করুন।';
    else if (detail === 'No soil samples saved for this field') message = 'এই মাঠে এখনো কোনো নমুনা সংরক্ষণ করা হয়নি।';
    else if (detail) message = detail;
    throw new Error(message);
  }
  return data;
}
function flash(message, type = 'info') {
  const el = $('app-message');
  if (!el) return;
  el.textContent = message;
  el.className = `app-message ${type}`;
  clearTimeout(flash._timer);
  flash._timer = setTimeout(() => { el.classList.add('hidden'); }, 7000);
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showPage(name) {
  document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active', page.id === `page-${name}`));
  document.querySelectorAll('.nav-btn').forEach((button) => button.classList.toggle('active', button.dataset.page === name));
  if (name === 'history') loadHistory();
  if (name === 'vra' && state.fieldId) {
    $('vra-field-id').value = state.fieldId;
    loadVRA();
  }
  if (name === 'calculator' && state.fieldId && !state.grid) restoreLastField();
}
document.querySelectorAll('.nav-btn').forEach((button) => { button.addEventListener('click', () => showPage(button.dataset.page)); });

async function loadLive() {
  try {
    const data = await api('/api/live');
    if (!data.available) {
      $('status-title').textContent = 'সেন্সরের অপেক্ষায়';
      $('status-text').textContent = 'এখনো কোনো পাঠ পাওয়া যায়নি';
      $('status-dot').style.background = '#e7a900';
      ['live-n', 'live-p', 'live-k', 'live-ph', 'live-ec', 'live-moist', 'live-air-temp', 'live-air-hum', 'live-soil-temp', 'live-time', 'class-n', 'class-p', 'class-k'].forEach((id) => { $(id).textContent = '—'; });
      return;
    }
    $('status-title').textContent = 'সরাসরি তথ্য';
    $('status-text').textContent = `সর্বশেষ পাঠ: ${dateBn(data.timestamp)}`;
    $('status-dot').style.background = '#1da864';
    $('live-n').textContent = fmt(data.n_frg, 4);
    $('live-p').textContent = fmt(data.p_frg, 2);
    $('live-k').textContent = fmt(data.k_frg, 4);
    $('live-ph').textContent = fmt(data.ph, 2);
    $('live-ec').textContent = fmt(data.ec, 2);
    $('live-moist').textContent = fmt(data.moisture, 1);
    $('live-air-temp').textContent = `${fmt(data.air_temp, 1)} °C`;
    $('live-air-hum').textContent = `${fmt(data.air_hum, 1)} %`;
    $('live-soil-temp').textContent = `${fmt(data.soil_temp, 1)} °C`;
    $('live-time').textContent = dateBn(data.timestamp);
    $('class-n').textContent = translateClass(data.classes?.N);
    $('class-p').textContent = translateClass(data.classes?.P);
    $('class-k').textContent = translateClass(data.classes?.K);
  } catch (error) {
    $('status-title').textContent = 'সার্ভার সমস্যা';
    $('status-text').textContent = error.message;
    $('status-dot').style.background = '#d64545';
  }
}
$('refresh-live').addEventListener('click', loadLive);
loadLive();
setInterval(loadLive, 10000);

function svgEl(tag, attrs = {}, text = null) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, String(value)));
  if (text !== null) element.textContent = text;
  return element;
}
function drawField(points, field) {
  const svg = $('field-svg');
  if (!svg || !field || !points) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const W = 1000, H = 650;
  const maxPlotW = 800, maxPlotH = 400;
  const scale = Math.min(maxPlotW / Number(field.length_m), maxPlotH / Number(field.width_m));
  const plotW = Number(field.length_m) * scale;
  const plotH = Number(field.width_m) * scale;
  const ox = (W - plotW) / 2;
  const bottom = 500;
  const top = bottom - plotH;
  const x = (point) => ox + (Number(point.x_m) / Number(field.length_m)) * plotW;
  const y = (point) => bottom - (Number(point.y_m) / Number(field.width_m)) * plotH;

  svg.appendChild(svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: '#f1f8f4', rx: 16 }));
  const defs = svgEl('defs');
  const marker = svgEl('marker', { id: 'arrowhead', markerWidth: 7, markerHeight: 7, refX: 3.5, refY: 3.5, orient: 'auto-start-reverse' });
  marker.appendChild(svgEl('path', { d: 'M 0 0 L 7 3.5 L 0 7 z', fill: '#526e61' }));
  defs.appendChild(marker); svg.appendChild(defs);
  svg.appendChild(svgEl('rect', { x: ox, y: top, width: plotW, height: plotH, fill: '#e9f5ee', stroke: '#1c744c', 'stroke-width': 4 }));

  // Distance guides between adjacent points: values are calculated from coordinates.
  const drawnPairs = new Set();
  points.forEach((point) => {
    (point.nearest_points || []).forEach((near) => {
      const other = points.find((candidate) => Number(candidate.point_no) === Number(near.point_no));
      if (!other) return;
      const dx = Math.abs(Number(point.x_m) - Number(other.x_m));
      const dy = Math.abs(Number(point.y_m) - Number(other.y_m));
      if (!(dx < 0.01 || dy < 0.01)) return; // show direct neighbours only, not diagonals
      const key = [Math.min(point.point_no, other.point_no), Math.max(point.point_no, other.point_no)].join('-');
      if (drawnPairs.has(key)) return;
      drawnPairs.add(key);
      svg.appendChild(svgEl('line', { x1: x(point), y1: y(point), x2: x(other), y2: y(other), stroke: '#b97922', 'stroke-width': 2, 'stroke-dasharray': '7 5', opacity: 0.9 }));
      const mx = (x(point) + x(other)) / 2, my = (y(point) + y(other)) / 2;
      svg.appendChild(svgEl('rect', { x: mx - 21, y: my - 13, width: 42, height: 22, rx: 8, fill: '#fffaf0', stroke: '#e6d5b8', 'stroke-width': 1 }));
      svg.appendChild(svgEl('text', { x: mx, y: my + 3, 'text-anchor': 'middle', 'font-size': 12, fill: '#75501d', 'font-weight': 700 }, `${fmtCoord(near.distance_m)} m`));
    });
  });

  // Points are clickable, keyboard accessible, and visually distinguish saved/selected points.
  points.forEach((point) => {
    const selected = Number(point.point_no) === Number(state.selectedPoint);
    const cx = x(point), cy = y(point);
    const group = svgEl('g', { role: 'button', tabindex: 0, 'aria-label': `${pointId(point.point_no)}, X ${fmtCoord(point.x_m)} মিটার, Y ${fmtCoord(point.y_m)} মিটার` });
    group.style.cursor = 'pointer';
    group.appendChild(svgEl('circle', { cx, cy, r: selected ? 17 : 13, fill: selected ? '#bf791b' : (point.saved ? '#23a566' : '#145f42'), stroke: '#ffffff', 'stroke-width': selected ? 5 : 3 }));
    group.appendChild(svgEl('text', { x: cx, y: cy + 4, 'text-anchor': 'middle', 'font-size': 10, fill: '#ffffff', 'font-weight': 800, 'pointer-events': 'none' }, pointId(point.point_no)));
    const title = svgEl('title', {}, `${pointId(point.point_no)} — X ${fmtCoord(point.x_m)} m, Y ${fmtCoord(point.y_m)} m — ${point.saved ? 'সংরক্ষিত' : 'অসংরক্ষিত'}`);
    group.appendChild(title);
    group.addEventListener('click', () => selectPoint(Number(point.point_no)));
    group.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectPoint(Number(point.point_no)); } });
    svg.appendChild(group);
  });

  // Length and width dimension lines.
  svg.appendChild(svgEl('line', { x1: ox, y1: bottom + 48, x2: ox + plotW, y2: bottom + 48, stroke: '#526e61', 'stroke-width': 2, 'marker-start': 'url(#arrowhead)', 'marker-end': 'url(#arrowhead)' }));
  svg.appendChild(svgEl('text', { x: ox + plotW / 2, y: bottom + 38, 'text-anchor': 'middle', 'font-size': 17, fill: '#214e3d', 'font-weight': 800 }, `দৈর্ঘ্য ${fmtCoord(field.length_m)} মিটার`));
  svg.appendChild(svgEl('line', { x1: ox - 42, y1: top, x2: ox - 42, y2: bottom, stroke: '#526e61', 'stroke-width': 2, 'marker-start': 'url(#arrowhead)', 'marker-end': 'url(#arrowhead)' }));
  svg.appendChild(svgEl('text', { x: ox - 66, y: (top + bottom) / 2, 'text-anchor': 'middle', 'font-size': 16, fill: '#214e3d', 'font-weight': 800, transform: `rotate(-90 ${ox - 66} ${(top + bottom) / 2})` }, `প্রস্থ ${fmtCoord(field.width_m)} মিটার`));
  svg.appendChild(svgEl('text', { x: ox + 4, y: bottom + 21, 'font-size': 15, fill: '#0d4d35', 'font-weight': 900 }, 'A (0, 0) — শুরুর কোণ'));
  svg.appendChild(svgEl('text', { x: ox + plotW - 4, y: top - 15, 'text-anchor': 'end', 'font-size': 13, fill: '#506b60' }, 'মাপ: মিটার'));
  renderPointList(points);
}
function renderPointList(points) {
  const list = $('point-list');
  if (!list) return;
  list.innerHTML = points.map((point) => `
    <button class="point-list-item ${Number(point.point_no) === Number(state.selectedPoint) ? 'selected' : ''} ${point.saved ? 'saved' : ''}" data-point="${point.point_no}">
      <strong>${pointId(point.point_no)}</strong>
      <span>X: ${fmtCoord(point.x_m)} মি</span><span>Y: ${fmtCoord(point.y_m)} মি</span>
      <small>${point.saved ? 'তথ্য সংরক্ষিত' : 'তথ্য বাকি'}</small>
    </button>`).join('');
  list.querySelectorAll('[data-point]').forEach((button) => button.addEventListener('click', () => selectPoint(Number(button.dataset.point))));
}

function currentPoint() {
  return (state.grid?.points || []).find((point) => Number(point.point_no) === Number(state.selectedPoint));
}
function clearSampleInputs() {
  [
    'sample-air-temp', 'sample-air-hum', 'sample-soil-temp', 'sample-moist', 'sample-ec', 'sample-ph', 'sample-n', 'sample-p', 'sample-k',
    'sample-n-raw', 'sample-p-raw', 'sample-k-raw', 'sample-n-corrected', 'sample-p-corrected', 'sample-k-corrected'
  ].forEach((id) => { $(id).value = '—'; });
}
function populateSample(sample) {
  const values = sample || {};
  const mapping = {
    'sample-air-temp': ['air_temp', 2], 'sample-air-hum': ['air_hum', 2], 'sample-soil-temp': ['soil_temp', 2],
    'sample-moist': ['moisture', 2], 'sample-ec': ['ec', 2], 'sample-ph': ['ph', 2],
    'sample-n': ['n_frg', 4], 'sample-p': ['p_frg', 2], 'sample-k': ['k_frg', 4],
    'sample-n-raw': ['n_raw', 3], 'sample-p-raw': ['p_raw', 3], 'sample-k-raw': ['k_raw', 3],
    'sample-n-corrected': ['n_corrected', 3], 'sample-p-corrected': ['p_corrected', 3], 'sample-k-corrected': ['k_corrected', 3]
  };
  Object.entries(mapping).forEach(([id, [key, digits]]) => { $(id).value = values[key] === undefined || values[key] === null ? '—' : fmt(values[key], digits); });
}
function updatePointLocation(point) {
  $('point-coordinate').innerHTML = `
    <div><span>দৈর্ঘ্য বরাবর (X)</span><strong>${fmtCoord(point.x_m)} মিটার</strong><small>A কোণ থেকে মাপুন</small></div>
    <div><span>প্রস্থ বরাবর (Y)</span><strong>${fmtCoord(point.y_m)} মিটার</strong><small>A কোণ থেকে মাপুন</small></div>
    <div><span>A কোণ থেকে সরাসরি দূরত্ব</span><strong>${fmtCoord(point.distance_from_origin_m)} মিটার</strong><small>তির্যক দূরত্ব</small></div>
    <div><span>দূরের দৈর্ঘ্যের কিনারা</span><strong>${fmtCoord(point.distance_to_far_length_edge_m)} মিটার</strong><small>শেষ কিনারা পর্যন্ত</small></div>`;
  const nearest = point.nearest_points || [];
  $('point-neighbors').innerHTML = `<strong>কাছের নমুনা পয়েন্ট থেকে দূরত্ব:</strong> ${nearest.length ? nearest.map((item) => `<span class="neighbor-chip">${pointId(item.point_no)} — ${fmtCoord(item.distance_m)} মি</span>`).join('') : 'কোনো পাশের পয়েন্ট নেই'}`;
}
function selectPoint(number) {
  state.captureSequence += 1; // invalidate any polling routine for the previous point
  state.capture = null;
  state.pendingSample = null;
  state.selectedPoint = number;
  const point = currentPoint();
  if (!point) return;
  $('active-point').textContent = pointId(number);
  $('point-status').textContent = point.saved ? 'সংরক্ষিত' : 'অপেক্ষমাণ';
  $('point-status').classList.toggle('badge-saved', Boolean(point.saved));
  $('point-help').textContent = `এই পয়েন্টে যান। A কোণ থেকে X=${fmtCoord(point.x_m)} মি এবং Y=${fmtCoord(point.y_m)} মি মেপে অবস্থান ঠিক করুন।`;
  updatePointLocation(point);
  clearSampleInputs();
  $('capture-point').disabled = true;
  $('start-capture').disabled = false;
  $('start-capture').textContent = 'সেন্সর থেকে ৩টি নতুন পাঠ নিন';
  $('sensor-capture-status').textContent = point.saved ? 'আগের তথ্য দেখানো হচ্ছে। নতুন করে মাপতে চাইলে নতুন পাঠ সংগ্রহ করুন।' : 'এই পয়েন্টে এখনো কোনো তথ্য সংরক্ষণ করা হয়নি।';
  $('reading-window').textContent = point.sample?.captured_at ? `আগে সংরক্ষিত: ${dateBn(point.sample.captured_at)}; পাঠের সংখ্যা: ${fmtCoord(point.sample.reading_count || 1)}` : 'গড় তৈরি হলে পাঠের সময় দেখা যাবে।';
  if (point.sample) populateSample(point.sample);
  else clearSampleInputs();
  drawField(state.grid.points, state.grid.field);
}

async function createField() {
  const length = Number($('field-length').value);
  const width = Number($('field-width').value);
  const spacing = Number($('field-spacing').value);
  if (!$('field-name').value.trim()) return flash('মাঠের নাম লিখুন।', 'error');
  if (!(length > 0 && width > 0 && spacing > 0)) return flash('দৈর্ঘ্য, প্রস্থ ও নমুনার ব্যবধান শূন্যের চেয়ে বেশি হতে হবে।', 'error');
  if (!$('field-crop').value) return flash('আগে ফসল নির্বাচন করুন।', 'error');
  const estimatedPoints = Math.ceil(length / spacing) * Math.ceil(width / spacing);
  if (estimatedPoints > 500) return flash('এই ব্যবধানে ৫০০টির বেশি পয়েন্ট তৈরি হবে। নমুনার ব্যবধান বাড়ান।', 'error');
  const payload = {
    name: $('field-name').value.trim(), length_m: length, width_m: width, spacing_m: spacing,
    crop: $('field-crop').value, variety: $('field-variety').value,
    season: $('field-season').value, yield_goal: $('field-yield').value
  };
  state.capture = null;
  state.captureSequence += 1;
  state.pendingSample = null;
  const button = $('create-field'); button.disabled = true; button.textContent = 'মাঠ তৈরি হচ্ছে…';
  try {
    const result = await api('/api/fields', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    state.fieldId = result.id;
    state.selectedPoint = 1;
    localStorage.setItem('smartFarmingLastFieldId', String(result.id));
    $('vra-field-id').value = result.id;
    await loadGrid();
    flash(`মাঠ তৈরি হয়েছে। মাঠের ID ${fmtCoord(result.id)}। মোট ${fmtCoord(state.grid.points.length, 0)}টি নমুনা পয়েন্ট তৈরি হয়েছে।`, 'success');
  } catch (error) { flash(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = 'মাঠ তৈরি ও নমুনার গ্রিড বানান'; }
}
$('create-field').addEventListener('click', createField);

async function loadGrid() {
  if (!state.fieldId) return;
  const grid = await api(`/api/fields/${state.fieldId}/grid`);
  state.grid = grid;
  $('sampling-wrap').classList.remove('hidden');
  $('grid-summary').textContent = `${fmtCoord(grid.points.length, 0)}টি পয়েন্ট • ${fmtCoord(grid.field.length_m)} × ${fmtCoord(grid.field.width_m)} মিটার • ব্যবধান ${fmtCoord(grid.field.spacing_m)} মিটার • সংরক্ষিত ${fmtCoord(grid.points.filter((p) => p.saved).length, 0)}টি`;
  if (!grid.points.some((point) => Number(point.point_no) === Number(state.selectedPoint))) state.selectedPoint = 1;
  drawField(grid.points, grid.field);
  selectPoint(state.selectedPoint);
}
$('reload-grid').addEventListener('click', async () => { try { await loadGrid(); flash('গ্রিড হালনাগাদ হয়েছে।', 'success'); } catch (error) { flash(error.message, 'error'); } });

async function startSensorCapture() {
  if (state.capture) {
    state.capture = null;
    state.captureSequence += 1;
    $('start-capture').disabled = false;
    $('start-capture').textContent = 'সেন্সর থেকে ৩টি নতুন পাঠ নিন';
    $('sensor-capture-status').textContent = 'পাঠ সংগ্রহ বাতিল করা হয়েছে।';
    return;
  }
  if (!state.fieldId || !state.grid) return flash('আগে মাঠ তৈরি করুন বা ইতিহাস থেকে মাঠ খুলুন।', 'error');
  const point = currentPoint();
  if (!point) return flash('নমুনা পয়েন্ট নির্বাচন করুন।', 'error');

  const token = ++state.captureSequence;
  const capture = { token, fieldId: state.fieldId, pointNo: state.selectedPoint, afterId: null, startedAt: Date.now() };
  state.capture = capture;
  state.pendingSample = null;
  $('capture-point').disabled = true;
  $('start-capture').disabled = false;
  $('start-capture').textContent = 'পাঠ সংগ্রহ বন্ধ করুন';
  $('sensor-capture-status').textContent = 'ESP32-এর সর্বশেষ পাঠ যাচাই করা হচ্ছে…';
  $('reading-window').textContent = 'নতুন তিনটি পাঠ সংগ্রহ করা হচ্ছে।';
  try {
    const latest = await api('/api/live');
    if (state.capture !== capture) return;
    if (!latest.available || !Number.isFinite(Number(latest.id))) {
      state.capture = null;
      $('start-capture').textContent = 'সেন্সর থেকে ৩টি নতুন পাঠ নিন';
      $('sensor-capture-status').textContent = 'সার্ভারে কোনো সেন্সর পাঠ নেই। ESP32 Wi-Fi-তে যুক্ত আছে এবং Cloud upload successful দেখাচ্ছে কি না পরীক্ষা করুন।';
      return;
    }
    capture.afterId = Number(latest.id);
    $('sensor-capture-status').textContent = `সংগ্রহ শুরু হয়েছে। নির্বাচিত ${pointId(capture.pointNo)}-এ সেন্সর স্থির রাখুন; ${SAMPLE_COUNT}টি নতুন পাঠের অপেক্ষা চলছে (0/${SAMPLE_COUNT})।`;
    await pollForCapture(capture);
  } catch (error) {
    if (state.capture === capture) {
      state.capture = null;
      $('start-capture').textContent = 'সেন্সর থেকে ৩টি নতুন পাঠ নিন';
      $('sensor-capture-status').textContent = `সেন্সর API পড়া যায়নি: ${error.message}`;
    }
  }
}
$('start-capture').addEventListener('click', startSensorCapture);

async function pollForCapture(capture) {
  while (state.capture === capture) {
    if (Date.now() - capture.startedAt > CAPTURE_TIMEOUT_MS) {
      state.capture = null;
      $('start-capture').textContent = 'আবার ৩টি নতুন পাঠ নিন';
      $('sensor-capture-status').textContent = 'সময় শেষ: নতুন ৩টি পাঠ পাওয়া যায়নি। ESP32 upload interval, Wi-Fi ও /api/live পরীক্ষা করুন; তারপর আবার চেষ্টা করুন।';
      return;
    }
    try {
      const result = await api(`/api/live/recent?after_id=${encodeURIComponent(capture.afterId)}&limit=${SAMPLE_COUNT}&max_age_sec=120`);
      if (state.capture !== capture) return;
      $('sensor-capture-status').textContent = `নতুন পাঠ পাওয়া গেছে: ${fmtCoord(result.count || 0, 0)}/${SAMPLE_COUNT}। ESP32 থেকে নতুন পাঠ আসা পর্যন্ত সেন্সর একই জায়গায় রাখুন।`;
      if (result.available && result.average) {
        state.pendingSample = {
          fieldId: capture.fieldId, pointNo: capture.pointNo,
          average: result.average, readingCount: result.count,
          firstReadingAt: result.first_reading_at, lastReadingAt: result.last_reading_at,
          readingIds: result.reading_ids || []
        };
        state.capture = null;
        populateSample(result.average);
        $('point-status').textContent = 'গড় প্রস্তুত';
        $('point-status').classList.remove('badge-saved');
        $('sensor-capture-status').textContent = `${fmtCoord(result.count, 0)}টি নতুন পাঠের গড় তৈরি হয়েছে। নিচের মান যাচাই করে সংরক্ষণ বোতাম চাপুন।`;
        $('reading-window').textContent = `পাঠ ${dateBn(result.first_reading_at)} থেকে ${dateBn(result.last_reading_at)} • মোট ${fmtCoord(result.count, 0)}টি পাঠের গড়`;
        $('capture-point').disabled = false;
        $('start-capture').textContent = 'আবার নতুন ৩টি পাঠ নিন';
        drawField(state.grid.points, state.grid.field);
        return;
      }
    } catch (error) {
      if (state.capture !== capture) return;
      $('sensor-capture-status').textContent = `পাঠের অবস্থা যাচাই হচ্ছে। সার্ভার বার্তা: ${error.message}`;
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

$('capture-point').addEventListener('click', async () => {
  const pending = state.pendingSample;
  const point = currentPoint();
  if (!pending || !point || pending.fieldId !== state.fieldId || pending.pointNo !== state.selectedPoint) {
    return flash('এই পয়েন্টের জন্য আগে নতুন ৩টি সেন্সর পাঠ সংগ্রহ করুন।', 'error');
  }
  const a = pending.average;
  const payload = {
    field_id: state.fieldId, point_no: state.selectedPoint, x_m: Number(point.x_m), y_m: Number(point.y_m),
    moisture: a.moisture, ec: a.ec, ph: a.ph,
    n_raw: a.n_raw, p_raw: a.p_raw, k_raw: a.k_raw,
    n_corrected: a.n_corrected, p_corrected: a.p_corrected, k_corrected: a.k_corrected,
    n_frg: a.n_frg, p_frg: a.p_frg, k_frg: a.k_frg,
    air_temp: a.air_temp, air_hum: a.air_hum, soil_temp: a.soil_temp,
    reading_count: pending.readingCount,
    first_reading_at: pending.firstReadingAt,
    last_reading_at: pending.lastReadingAt
  };
  const button = $('capture-point'); button.disabled = true; button.textContent = 'তথ্য সংরক্ষণ হচ্ছে…';
  try {
    await api('/api/samples', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    state.pendingSample = null;
    await loadGrid();
    flash(`${pointId(point.point_no)}-এর ${fmtCoord(pending.readingCount, 0)}টি পাঠের গড় সংরক্ষিত হয়েছে। পরের পয়েন্ট নির্বাচন করুন।`, 'success');
  } catch (error) {
    button.disabled = false;
    flash(error.message, 'error');
  } finally { button.textContent = 'এই পয়েন্টের তথ্য সংরক্ষণ করুন'; }
});

$('run-calculation').addEventListener('click', async () => {
  if (!state.fieldId) return flash('আগে মাঠ তৈরি করুন।', 'error');
  if (!$('field-crop').value) return flash('ফসল নির্বাচন করুন।', 'error');
  if (!state.grid?.points.some((point) => point.saved)) return flash('বিশ্লেষণের আগে অন্তত একটি পয়েন্টের সেন্সর তথ্য সংরক্ষণ করুন।', 'error');
  try {
    const data = await api('/api/fertilizer/calculate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ field_id: state.fieldId, crop: $('field-crop').value, variety: $('field-variety').value, season: $('field-season').value, yield_goal: $('field-yield').value }) });
    $('calc-result').innerHTML = `<strong>গড় মাটির মান</strong><br>N: ${fmt(data.average_frg.N, 4)} (${translateClass(data.classes.N)}) • P: ${fmt(data.average_frg.P, 2)} (${translateClass(data.classes.P)}) • K: ${fmt(data.average_frg.K, 4)} (${translateClass(data.classes.K)})<br><span class="muted">${fmtCoord(data.sample_count, 0)}টি সংরক্ষিত পয়েন্ট। নির্দিষ্ট সারমাত্রার জন্য যাচাইকৃত FRG-2024 ফসলভিত্তিক তালিকা প্রয়োজন।</span>`;
    $('vra-field-id').value = state.fieldId;
    showPage('vra');
    await loadVRA();
  } catch (error) { flash(error.message, 'error'); }
});

async function loadVRA() {
  const id = Number($('vra-field-id').value);
  if (!id) return flash('মাঠের ID লিখুন।', 'error');
  try {
    state.vra = await api(`/api/vra/${id}`);
    drawVRA();
    renderPoints();
    if (!state.vra.samples.length) flash('এই মাঠে এখনো কোনো নমুনা সংরক্ষণ করা হয়নি।', 'info');
  } catch (error) { flash(error.message, 'error'); }
}
$('load-vra').addEventListener('click', loadVRA);
document.querySelectorAll('.chip').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.chip').forEach((item) => item.classList.remove('active'));
  button.classList.add('active'); state.layer = button.dataset.layer; drawVRA();
}));
function colorFor(value, min, max) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'rgba(160,170,165,.30)';
  const t = (Number(value) - min) / (max - min || 1);
  const stops = ['#1d7a52', '#47a36b', '#8bcf8d', '#f0e97c', '#efae5c', '#d94a44'];
  const scaled = Math.max(0, Math.min(stops.length - 1, t * (stops.length - 1)));
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  return stops[index];
}
function drawVRA() {
  const canvas = $('vra-canvas');
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.vra) return;
  const field = state.vra.field;
  if (!state.vra.samples.length) {
    context.fillStyle = '#355b49'; context.font = 'bold 28px "Noto Sans Bengali", sans-serif';
    context.fillText('মানচিত্র দেখতে আগে নমুনা সংরক্ষণ করুন', 55, 85);
    return;
  }
  const values = state.vra.surface.map((point) => point[state.layer]).filter((value) => value !== null && value !== undefined).map(Number);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const cols = 24, rows = 24;
  const cellW = canvas.width / cols, cellH = canvas.height / rows;
  state.vra.surface.forEach((point, index) => {
    const gx = index % cols, gy = Math.floor(index / cols);
    context.fillStyle = colorFor(point[state.layer], min, max);
    context.fillRect(gx * cellW, canvas.height - (gy + 1) * cellH, cellW + 1, cellH + 1);
  });
  context.strokeStyle = '#145f42'; context.lineWidth = 5; context.strokeRect(0, 0, canvas.width, canvas.height);
  state.vra.samples.forEach((sample) => {
    const px = (sample.x_m / field.length_m) * canvas.width;
    const py = canvas.height - (sample.y_m / field.width_m) * canvas.height;
    context.fillStyle = '#fff'; context.beginPath(); context.arc(px, py, 9, 0, Math.PI * 2); context.fill();
    context.strokeStyle = '#0b5b3d'; context.lineWidth = 3; context.stroke();
    context.fillStyle = '#123'; context.font = 'bold 13px sans-serif'; context.fillText(pointId(sample.point_no), px + 12, py + 5);
  });
  context.fillStyle = '#fff'; context.fillRect(12, 12, 250, 52);
  context.fillStyle = '#123'; context.font = 'bold 20px "Noto Sans Bengali", sans-serif';
  const layerNames = { N: 'নাইট্রোজেন', P: 'ফসফরাস', K: 'পটাশিয়াম' };
  context.fillText(`${layerNames[state.layer]} • আনুমানিক মান`, 24, 45);
}
function renderPoints() {
  const container = $('vra-points');
  if (!state.vra) { container.textContent = 'তথ্য নেই'; return; }
  if (!state.vra.samples.length) { container.innerHTML = '<p class="muted">এখনো কোনো নমুনা পয়েন্ট সংরক্ষিত হয়নি।</p>'; return; }
  container.innerHTML = state.vra.samples.map((sample) => `<div class="point-row"><b>${pointId(sample.point_no)}</b><span>N ${fmt(sample.n_frg, 4)}</span><span>P ${fmt(sample.p_frg, 2)}</span><span>K ${fmt(sample.k_frg, 4)}</span><span>${escapeHtml(dateBn(sample.captured_at))}</span><span>X ${fmtCoord(sample.x_m)} মি, Y ${fmtCoord(sample.y_m)} মি</span></div>`).join('');
}

async function loadHistory() {
  try {
    const data = await api('/api/history');
    const container = $('history-list');
    container.innerHTML = data.fields.map((field) => `<div class="history-row">
      <div><strong>${escapeHtml(field.name)}</strong><div class="muted">মাঠ ID ${fmtCoord(field.id, 0)} • ${fmtCoord(field.length_m)} × ${fmtCoord(field.width_m)} মিটার • ফসল: ${escapeHtml(cropName(field.crop))} • সংরক্ষিত পয়েন্ট: ${fmtCoord(field.sample_count, 0)}</div></div>
      <div class="history-actions"><button class="ghost open-field" data-field-id="${field.id}">মাঠ খুলুন</button><a class="ghost report-link" href="/api/report/${field.id}.pdf">প্রতিবেদন (PDF)</a></div>
    </div>`).join('') || '<div class="muted">এখনো কোনো মাঠ তৈরি হয়নি।</div>';
    container.querySelectorAll('.open-field').forEach((button) => button.addEventListener('click', async () => {
      try {
        await restoreField(Number(button.dataset.fieldId));
        showPage('calculator');
        flash('মাঠের তথ্য ও আগের নমুনা লোড হয়েছে।', 'success');
      } catch (error) { flash(error.message, 'error'); }
    }));
  } catch (error) { $('history-list').textContent = error.message; }
}
$('refresh-history').addEventListener('click', loadHistory);
function cropName(value) {
  const map = { Rice: 'ধান', Wheat: 'গম', Maize: 'ভুট্টা', Potato: 'আলু', Tomato: 'টমেটো', Eggplant: 'বেগুন', Chili: 'মরিচ', Mustard: 'সরিষা', Lentil: 'মসুর ডাল', Onion: 'পেঁয়াজ' };
  return map[value] || value || '—';
}

// Crop labels are Bengali while backend keys remain the original stable English values.
const varietyOptions = {
  Rice: ['BRRI dhan28', 'BRRI dhan29', 'BRRI dhan49', 'BRRI dhan52', 'BRRI dhan75'],
  Wheat: ['BARI Gom 26', 'BARI Gom 28', 'BARI Gom 30', 'BARI Gom 32', 'BARI Gom 33'],
  Maize: ['BARI Hybrid Maize 5', 'BARI Hybrid Maize 7', 'BARI Hybrid Maize 9', 'Local Maize', 'Hybrid Maize'],
  Potato: ['Cardinal', 'Diamant', 'Granola', 'Lady Rosetta', 'Local Potato'],
  Tomato: ['BARI Tomato 2', 'BARI Tomato 4', 'BARI Tomato 5', 'BARI Tomato 14', 'Hybrid Tomato'],
  Eggplant: ['BARI Begun 1', 'BARI Begun 2', 'BARI Begun 4', 'BARI Begun 5', 'Local Eggplant'],
  Chili: ['BARI Morich 1', 'BARI Morich 2', 'BARI Morich 3', 'Local Chili', 'Hybrid Chili'],
  Mustard: ['BARI Sarisha 11', 'BARI Sarisha 14', 'BARI Sarisha 15', 'BARI Sarisha 16', 'Local Mustard'],
  Lentil: ['BARI Masur 4', 'BARI Masur 5', 'BARI Masur 6', 'BARI Masur 7', 'Local Lentil'],
  Onion: ['BARI Piaz 1', 'BARI Piaz 3', 'BARI Piaz 4', 'BARI Piaz 5', 'Local Onion']
};
function updateVarietyOptions(crop, selected = '') {
  const select = $('field-variety');
  select.innerHTML = '';
  if (!crop) {
    select.disabled = true;
    select.appendChild(new Option('আগে ফসল নির্বাচন করুন', ''));
    return;
  }
  select.disabled = false;
  select.appendChild(new Option('জাত নির্বাচন করুন', ''));
  (varietyOptions[crop] || []).forEach((variety) => select.appendChild(new Option(variety, variety)));
  if (selected) select.value = selected;
}
$('field-crop').addEventListener('change', () => updateVarietyOptions($('field-crop').value));

async function restoreField(fieldId) {
  const data = await api(`/api/fields/${fieldId}`);
  const field = data.field;
  state.fieldId = Number(field.id);
  state.selectedPoint = 1;
  state.pendingSample = null;
  state.capture = null;
  state.captureSequence += 1;
  state.grid = null;
  localStorage.setItem('smartFarmingLastFieldId', String(field.id));
  $('field-name').value = field.name || '';
  $('field-length').value = field.length_m;
  $('field-width').value = field.width_m;
  $('field-spacing').value = field.spacing_m;
  $('field-crop').value = field.crop || '';
  updateVarietyOptions(field.crop || '', field.variety || '');
  $('field-season').value = field.season || '';
  $('field-yield').value = field.yield_goal || '';
  $('vra-field-id').value = field.id;
  await loadGrid();
}
async function restoreLastField() {
  if (!state.fieldId) return;
  try { await restoreField(state.fieldId); }
  catch (error) {
    localStorage.removeItem('smartFarmingLastFieldId');
    state.fieldId = null;
    state.grid = null;
  }
}
restoreLastField();
