'use strict';

const state = {
  fieldId: Number(localStorage.getItem('smartFarmingLastFieldId')) || null,
  grid: null,
  vra: null,
  layer: 'Urea',
  selectedPoint: 1,
  frgProfiles: [],
  recommendation: null,
  latestLive: null,
  latestLiveReceivedAt: 0,
  selectedPointBaselineId: null,
  baselinePending: true,
  savedSinceSelection: false,
  pendingSample: null
};
const $ = (id) => document.getElementById(id);
const LIVE_POLL_INTERVAL_MS = 5000;
const LIVE_MAX_AGE_MS = 60000;

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
    state.latestLiveReceivedAt = Date.now();
    if (!data.available || !Number.isFinite(Number(data.id))) {
      state.latestLive = null;
      $('status-title').textContent = 'সেন্সরের অপেক্ষায়';
      $('status-text').textContent = 'এখনো কোনো পাঠ পাওয়া যায়নি';
      $('status-dot').style.background = '#e7a900';
      ['live-n', 'live-p', 'live-k', 'live-ph', 'live-ec', 'live-moist', 'live-air-temp', 'live-air-hum', 'live-soil-temp', 'live-time', 'class-n', 'class-p', 'class-k'].forEach((id) => { $(id).textContent = '—'; });
      updateSelectedPointLive(null);
      return;
    }
    state.latestLive = data;
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
    updateSelectedPointLive(data);
  } catch (error) {
    $('status-title').textContent = 'সার্ভার সমস্যা';
    $('status-text').textContent = error.message;
    $('status-dot').style.background = '#d64545';
    updateSelectedPointLive(state.latestLive);
  }
}
$('refresh-live').addEventListener('click', loadLive);
loadLive();
setInterval(loadLive, LIVE_POLL_INTERVAL_MS);

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

  // Use a generous viewBox so IDs, coordinate labels and dimensions remain legible.
  const W = 1120, H = 800;
  const maxPlotW = 820, maxPlotH = 450;
  const length = Number(field.length_m), width = Number(field.width_m);
  const scale = Math.min(maxPlotW / length, maxPlotH / width);
  const plotW = length * scale;
  const plotH = width * scale;
  const ox = (W - plotW) / 2;
  const bottom = 625;
  const top = bottom - plotH;
  const x = (point) => ox + (Number(point.x_m) / length) * plotW;
  const y = (point) => bottom - (Number(point.y_m) / width) * plotH;
  const spacing = Number(field.spacing_m);

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.appendChild(svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: '#f1f8f4', rx: 18 }));
  svg.appendChild(svgEl('text', { x: W / 2, y: 42, 'text-anchor': 'middle', 'font-size': 23, fill: '#174735', 'font-weight': 800 }, 'মাঠের নমুনা পয়েন্ট ও দূরত্ব'));

  const defs = svgEl('defs');
  const marker = svgEl('marker', { id: 'sf-arrowhead', markerWidth: 8, markerHeight: 8, refX: 4, refY: 4, orient: 'auto-start-reverse' });
  marker.appendChild(svgEl('path', { d: 'M 0 0 L 8 4 L 0 8 z', fill: '#526e61' }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  // Field boundary and light grid axes at each actual sample-centre coordinate.
  svg.appendChild(svgEl('rect', { x: ox, y: top, width: plotW, height: plotH, fill: '#e9f5ee', stroke: '#1c744c', 'stroke-width': 5 }));
  const xs = [...new Set(points.map((p) => Number(p.x_m)))].sort((a,b) => a-b);
  const ys = [...new Set(points.map((p) => Number(p.y_m)))].sort((a,b) => a-b);
  xs.forEach((xv) => {
    const xx = ox + (xv / length) * plotW;
    svg.appendChild(svgEl('line', { x1: xx, y1: top, x2: xx, y2: bottom, stroke: '#bfd9ca', 'stroke-width': 1.5, 'stroke-dasharray': '4 6' }));
    svg.appendChild(svgEl('text', { x: xx, y: bottom + 34, 'text-anchor': 'middle', 'font-size': 14, fill: '#355b49', 'font-weight': 700 }, `X ${fmtCoord(xv)} মি`));
  });
  ys.forEach((yv) => {
    const yy = bottom - (yv / width) * plotH;
    svg.appendChild(svgEl('line', { x1: ox, y1: yy, x2: ox + plotW, y2: yy, stroke: '#bfd9ca', 'stroke-width': 1.5, 'stroke-dasharray': '4 6' }));
    svg.appendChild(svgEl('text', { x: ox - 22, y: yy + 5, 'text-anchor': 'end', 'font-size': 14, fill: '#355b49', 'font-weight': 700 }, `Y ${fmtCoord(yv)} মি`));
  });

  // Draw only immediate horizontal/vertical neighbours and annotate their measured distance.
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i], b = points[j];
      const dx = Math.abs(Number(a.x_m) - Number(b.x_m));
      const dy = Math.abs(Number(a.y_m) - Number(b.y_m));
      const horizontal = dy < 0.001 && dx > 0.001 && dx <= spacing + 0.01;
      const vertical = dx < 0.001 && dy > 0.001 && dy <= spacing + 0.01;
      if (!horizontal && !vertical) continue;
      const ax = x(a), ay = y(a), bx = x(b), by = y(b);
      svg.appendChild(svgEl('line', { x1: ax, y1: ay, x2: bx, y2: by, stroke: '#b97922', 'stroke-width': 3, 'stroke-dasharray': '8 6', opacity: 0.95 }));
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const labelX = horizontal ? mx : mx + 30;
      const labelY = horizontal ? my - 15 : my;
      const dist = Math.hypot(dx, dy);
      svg.appendChild(svgEl('rect', { x: labelX - 34, y: labelY - 14, width: 68, height: 26, rx: 9, fill: '#fffaf0', stroke: '#dfc18f', 'stroke-width': 1.5 }));
      svg.appendChild(svgEl('text', { x: labelX, y: labelY + 4, 'text-anchor': 'middle', 'font-size': 14, fill: '#75501d', 'font-weight': 800 }, `${fmtCoord(dist)} মি`));
    }
  }

  // Draw readable point markers with a proper label pill and its exact coordinates.
  points.forEach((point) => {
    const selected = Number(point.point_no) === Number(state.selectedPoint);
    const cx = x(point), cy = y(point);
    const group = svgEl('g', { role: 'button', tabindex: 0, 'aria-label': `${pointId(point.point_no)}, X ${fmtCoord(point.x_m)} মিটার, Y ${fmtCoord(point.y_m)} মিটার` });
    group.style.cursor = 'pointer';
    group.appendChild(svgEl('circle', { cx, cy, r: selected ? 13 : 10, fill: selected ? '#bf791b' : (point.saved ? '#23a566' : '#145f42'), stroke: '#ffffff', 'stroke-width': 4 }));
    const tagY = cy + 18;
    group.appendChild(svgEl('rect', { x: cx - 32, y: tagY, width: 64, height: 25, rx: 9, fill: selected ? '#fff3d7' : '#ffffff', stroke: selected ? '#bf791b' : (point.saved ? '#23a566' : '#145f42'), 'stroke-width': 1.6 }));
    group.appendChild(svgEl('text', { x: cx, y: tagY + 17, 'text-anchor': 'middle', 'font-size': 14, fill: '#123f2e', 'font-weight': 900, 'pointer-events': 'none' }, pointId(point.point_no)));
    group.appendChild(svgEl('title', {}, `${pointId(point.point_no)} — X=${fmtCoord(point.x_m)} মি, Y=${fmtCoord(point.y_m)} মি — ${point.saved ? 'তথ্য সংরক্ষিত' : 'তথ্য বাকি'}`));
    group.addEventListener('click', () => selectPoint(Number(point.point_no)));
    group.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectPoint(Number(point.point_no)); } });
    svg.appendChild(group);
  });

  // Whole-field dimensions and the declared reference corner A = (0, 0).
  svg.appendChild(svgEl('line', { x1: ox, y1: bottom + 78, x2: ox + plotW, y2: bottom + 78, stroke: '#526e61', 'stroke-width': 2.5, 'marker-start': 'url(#sf-arrowhead)', 'marker-end': 'url(#sf-arrowhead)' }));
  svg.appendChild(svgEl('text', { x: ox + plotW / 2, y: bottom + 109, 'text-anchor': 'middle', 'font-size': 19, fill: '#214e3d', 'font-weight': 900 }, `মাঠের মোট দৈর্ঘ্য: ${fmtCoord(length)} মিটার`));
  svg.appendChild(svgEl('line', { x1: ox - 72, y1: top, x2: ox - 72, y2: bottom, stroke: '#526e61', 'stroke-width': 2.5, 'marker-start': 'url(#sf-arrowhead)', 'marker-end': 'url(#sf-arrowhead)' }));
  svg.appendChild(svgEl('text', { x: ox - 105, y: (top + bottom) / 2, 'text-anchor': 'middle', 'font-size': 18, fill: '#214e3d', 'font-weight': 900, transform: `rotate(-90 ${ox - 105} ${(top + bottom) / 2})` }, `মাঠের মোট প্রস্থ: ${fmtCoord(width)} মিটার`));
  svg.appendChild(svgEl('circle', { cx: ox, cy: bottom, r: 8, fill: '#0d4d35', stroke: '#ffffff', 'stroke-width': 3 }));
  svg.appendChild(svgEl('rect', { x: ox - 14, y: bottom + 5, width: 52, height: 27, rx: 8, fill: '#0d4d35' }));
  svg.appendChild(svgEl('text', { x: ox + 12, y: bottom + 24, 'text-anchor': 'middle', 'font-size': 14, fill: '#ffffff', 'font-weight': 900 }, 'A (0,0)'));
  svg.appendChild(svgEl('text', { x: W / 2, y: H - 22, 'text-anchor': 'middle', 'font-size': 15, fill: '#355b49' }, `হলুদ ড্যাশ রেখা: পাশাপাশি নমুনা পয়েন্টের সরাসরি দূরত্ব • নির্দিষ্ট অবস্থানের জন্য X ও Y মিটার মাপুন`));

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
    'sample-air-temp', 'sample-air-hum', 'sample-soil-temp', 'sample-moist', 'sample-ec', 'sample-ph', 'sample-n', 'sample-p', 'sample-k'
  ].forEach((id) => { const field = $(id); if (field) field.value = '—'; });
}
function populateSample(sample) {
  const values = sample || {};
  const mapping = {
    'sample-air-temp': ['air_temp', 2], 'sample-air-hum': ['air_hum', 2], 'sample-soil-temp': ['soil_temp', 2],
    'sample-moist': ['moisture', 2], 'sample-ec': ['ec', 2], 'sample-ph': ['ph', 2],
    'sample-n': ['n_frg', 4], 'sample-p': ['p_frg', 2], 'sample-k': ['k_frg', 4]
  };
  Object.entries(mapping).forEach(([id, [key, digits]]) => {
    const input = $(id);
    if (input) input.value = values[key] === undefined || values[key] === null ? '—' : fmt(values[key], digits);
  });
}
function updatePointLocation(point) {
  $('point-coordinate').innerHTML = `
    <div><span>দৈর্ঘ্য বরাবর (X)</span><strong>${fmtCoord(point.x_m)} মিটার</strong><small>A কোণ থেকে মাপুন</small></div>
    <div><span>প্রস্থ বরাবর (Y)</span><strong>${fmtCoord(point.y_m)} মিটার</strong><small>A কোণ থেকে মাপুন</small></div>
    <div><span>A কোণ থেকে সরাসরি দূরত্ব</span><strong>${fmtCoord(point.distance_from_origin_m)} মিটার</strong><small>তির্যক দূরত্ব</small></div>
    <div><span>বিপরীত দৈর্ঘ্যের কিনারা পর্যন্ত</span><strong>${fmtCoord(point.distance_to_far_length_edge_m)} মিটার</strong><small>শেষ কিনারা পর্যন্ত</small></div>`;
  const nearest = point.nearest_points || [];
  $('point-neighbors').innerHTML = `<strong>কাছের নমুনা পয়েন্ট থেকে দূরত্ব:</strong> ${nearest.length ? nearest.map((item) => `<span class="neighbor-chip">${pointId(item.point_no)} — ${fmtCoord(item.distance_m)} মিটার</span>`).join('') : 'কোনো পাশের পয়েন্ট নেই'}`;
}
function setPointBaseline() {
  if (state.latestLive && Number.isFinite(Number(state.latestLive.id))) {
    state.selectedPointBaselineId = Number(state.latestLive.id);
    state.baselinePending = false;
  } else {
    state.selectedPointBaselineId = null;
    state.baselinePending = true;
  }
  state.savedSinceSelection = false;
  state.pendingSample = null;
}
function liveIsFresh(sample) {
  if (!sample || !sample.timestamp) return false;
  const time = new Date(sample.timestamp).getTime();
  return Number.isFinite(time) && Date.now() - time <= LIVE_MAX_AGE_MS && time <= Date.now() + 15000;
}
function updateSelectedPointLive(data) {
  const point = currentPoint();
  if (!state.grid || !point || !$('capture-point')) return;
  const reading = data && data.available && Number.isFinite(Number(data.id)) ? data : null;
  const isFresh = liveIsFresh(reading);

  if (!reading) {
    state.pendingSample = null;
    $('capture-point').disabled = true;
    $('sensor-capture-status').textContent = 'সার্ভারে এখনো সেন্সরের পাঠ নেই। ESP32-এর Wi-Fi ও cloud upload পরীক্ষা করুন।';
    $('reading-window').textContent = 'লাইভ পাঠ পাওয়া গেলে এখানে সময় দেখাবে।';
    if (!point.sample) clearSampleInputs();
    return;
  }

  // Always display the latest live value; the save button is enabled only after
  // a new server reading arrives after this specific point was selected.
  populateSample(reading);
  $('reading-window').textContent = `সর্বশেষ লাইভ পাঠ: ${dateBn(reading.timestamp)}`;

  if (state.baselinePending) {
    state.selectedPointBaselineId = Number(reading.id);
    state.baselinePending = false;
    state.pendingSample = null;
    $('capture-point').disabled = true;
    $('sensor-capture-status').textContent = 'বর্তমান সেন্সর মান দেখানো হচ্ছে। এই পয়েন্ট নির্বাচনের পরের নতুন পাঠ এলে সংরক্ষণ সক্রিয় হবে।';
    return;
  }

  const newAfterSelection = Number(reading.id) > Number(state.selectedPointBaselineId);
  if (state.savedSinceSelection) {
    $('capture-point').disabled = true;
    $('sensor-capture-status').textContent = `${pointId(point.point_no)}-এর তথ্য সংরক্ষিত হয়েছে। অন্য পয়েন্টে যেতে সেটি নির্বাচন করুন; একই পয়েন্ট আবার মাপতে হলে পয়েন্টটি পুনরায় নির্বাচন করুন।`;
    return;
  }

  if (!isFresh) {
    state.pendingSample = null;
    $('capture-point').disabled = true;
    $('point-status').textContent = 'নতুন পাঠের অপেক্ষা';
    $('point-status').classList.remove('badge-saved');
    $('sensor-capture-status').textContent = 'সর্বশেষ পাঠ পুরোনো। ESP32 থেকে নতুন cloud reading আসার অপেক্ষা চলছে।';
    return;
  }

  if (!newAfterSelection) {
    state.pendingSample = null;
    $('capture-point').disabled = true;
    $('point-status').textContent = 'নতুন পাঠের অপেক্ষা';
    $('point-status').classList.remove('badge-saved');
    $('sensor-capture-status').textContent = 'সর্বশেষ লাইভ মান দেখানো হচ্ছে। নির্বাচিত পয়েন্টে সেন্সর স্থির রাখুন; পরের নতুন পাঠ এলে সংরক্ষণ করতে পারবেন।';
    return;
  }

  state.pendingSample = {
    fieldId: state.fieldId,
    pointNo: Number(state.selectedPoint),
    reading,
    readingCount: 1,
    firstReadingAt: reading.timestamp,
    lastReadingAt: reading.timestamp,
    readingIds: [Number(reading.id)]
  };
  $('capture-point').disabled = false;
  $('point-status').textContent = 'লাইভ পাঠ প্রস্তুত';
  $('point-status').classList.remove('badge-saved');
  $('sensor-capture-status').textContent = `${pointId(point.point_no)}-এর নতুন লাইভ পাঠ পাওয়া গেছে। মানগুলো দেখে সংরক্ষণ করুন।`;
}
function selectPoint(number) {
  state.selectedPoint = number;
  const point = currentPoint();
  if (!point) return;
  setPointBaseline();
  $('active-point').textContent = pointId(number);
  $('point-status').textContent = point.saved ? 'আগে সংরক্ষিত' : 'লাইভ পাঠের অপেক্ষায়';
  $('point-status').classList.toggle('badge-saved', Boolean(point.saved));
  $('point-help').textContent = `মাঠে ${pointId(number)} পয়েন্টে যান। A কোণ থেকে X=${fmtCoord(point.x_m)} মিটার এবং Y=${fmtCoord(point.y_m)} মিটার মেপে সেন্সর বসান।`;
  updatePointLocation(point);
  $('capture-point').disabled = true;
  $('capture-point').textContent = 'এই পয়েন্টের তথ্য সংরক্ষণ করুন';
  if (point.sample) populateSample(point.sample);
  else clearSampleInputs();
  $('sensor-capture-status').textContent = 'এই পয়েন্ট নির্বাচন করা হয়েছে। সেন্সরের সর্বশেষ পাঠ লাইভ দেখানো হচ্ছে; পরের নতুন পাঠ এলে সংরক্ষণ সক্রিয় হবে।';
  $('reading-window').textContent = point.sample?.captured_at ? `আগের সংরক্ষিত পাঠ: ${dateBn(point.sample.captured_at)}` : 'লাইভ সেন্সর পাঠের অপেক্ষায়…';
  drawField(state.grid.points, state.grid.field);
  updateSelectedPointLive(state.latestLive);
}

async function createField() {
  const length = Number($('field-length').value);
  const width = Number($('field-width').value);
  const spacing = Number($('field-spacing').value);
  if (!$('field-name').value.trim()) return flash('মাঠের নাম লিখুন।', 'error');
  if (!(length > 0 && width > 0 && spacing > 0)) return flash('দৈর্ঘ্য, প্রস্থ ও নমুনার ব্যবধান শূন্যের চেয়ে বেশি হতে হবে।', 'error');
  if (!$('field-crop').value) return flash('আগে ফসল নির্বাচন করুন।', 'error');
  if (!$('field-season').value) return flash('ফসলের মৌসুম নির্বাচন করুন।', 'error');
  if (!$('field-variety').value) return flash('FRG-2024 তালিকা থেকে জাত নির্বাচন করুন।', 'error');
  const estimatedPoints = Math.ceil(length / spacing) * Math.ceil(width / spacing);
  if (estimatedPoints > 500) return flash('এই ব্যবধানে ৫০০টির বেশি পয়েন্ট তৈরি হবে। নমুনার ব্যবধান বাড়ান।', 'error');
  const payload = {
    name: $('field-name').value.trim(), length_m: length, width_m: width, spacing_m: spacing,
    crop: $('field-crop').value, variety: $('field-variety').value,
    season: $('field-season').value, yield_goal: $('field-yield').value,
    rhizobium_used: $('field-rhizobium').checked
  };
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

$('capture-point').addEventListener('click', async () => {
  const pending = state.pendingSample;
  const point = currentPoint();
  if (!pending || !point || pending.fieldId !== state.fieldId || pending.pointNo !== state.selectedPoint) {
    return flash('এই পয়েন্টের নতুন লাইভ পাঠ আসার পর সংরক্ষণ করুন।', 'error');
  }
  if (!liveIsFresh(pending.reading)) {
    state.pendingSample = null;
    $('capture-point').disabled = true;
    return flash('লাইভ পাঠ পুরোনো হয়ে গেছে। নতুন sensor reading আসা পর্যন্ত অপেক্ষা করুন।', 'error');
  }
  const reading = pending.reading;
  const payload = {
    field_id: state.fieldId,
    point_no: state.selectedPoint,
    x_m: Number(point.x_m),
    y_m: Number(point.y_m),
    moisture: Number(reading.moisture),
    ec: Number(reading.ec),
    ph: Number(reading.ph),
    n_raw: Number(reading.n_raw),
    p_raw: Number(reading.p_raw),
    k_raw: Number(reading.k_raw),
    n_corrected: Number(reading.n_corrected),
    p_corrected: Number(reading.p_corrected),
    k_corrected: Number(reading.k_corrected),
    n_frg: Number(reading.n_frg),
    p_frg: Number(reading.p_frg),
    k_frg: Number(reading.k_frg),
    air_temp: Number(reading.air_temp),
    air_hum: Number(reading.air_hum),
    soil_temp: Number(reading.soil_temp),
    reading_count: 1,
    first_reading_at: reading.timestamp,
    last_reading_at: reading.timestamp
  };
  const button = $('capture-point');
  button.disabled = true;
  button.textContent = 'তথ্য সংরক্ষণ হচ্ছে…';
  try {
    const result = await api('/api/samples', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    point.saved = true;
    point.sample = { ...payload, captured_at: result.captured_at || new Date().toISOString(), reading_count: 1 };
    state.pendingSample = null;
    state.savedSinceSelection = true;
    state.selectedPointBaselineId = Number(state.latestLive?.id || reading.id);
    $('point-status').textContent = 'সংরক্ষিত';
    $('point-status').classList.add('badge-saved');
    populateSample(reading);
    $('sensor-capture-status').textContent = `${pointId(point.point_no)}-এর লাইভ sensor reading সফলভাবে সংরক্ষণ করা হয়েছে।`;
    $('reading-window').textContent = `সংরক্ষণের সময়: ${dateBn(result.captured_at || new Date().toISOString())}`;
    $('grid-summary').textContent = `${fmtCoord(state.grid.points.length, 0)}টি পয়েন্ট • ${fmtCoord(state.grid.field.length_m)} × ${fmtCoord(state.grid.field.width_m)} মিটার • ব্যবধান ${fmtCoord(state.grid.field.spacing_m)} মিটার • সংরক্ষিত ${fmtCoord(state.grid.points.filter((p) => p.saved).length, 0)}টি`;
    drawField(state.grid.points, state.grid.field);
    flash(`${pointId(point.point_no)}-এর লাইভ পাঠ সংরক্ষিত হয়েছে। পরের পয়েন্টে যান।`, 'success');
  } catch (error) {
    button.disabled = !state.pendingSample;
    flash(error.message, 'error');
  } finally {
    button.textContent = 'এই পয়েন্টের তথ্য সংরক্ষণ করুন';
  }
});

$('run-calculation').addEventListener('click', async () => {
  if (!state.fieldId || !state.grid) return flash('আগে মাঠ ও নমুনা গ্রিড তৈরি করুন।', 'error');
  if (!$('field-crop').value || !$('field-season').value || !$('field-variety').value) return flash('ফসল, মৌসুম ও জাত নির্বাচন করুন।', 'error');
  const savedCount = state.grid.points.filter((point) => point.saved).length;
  const requiredCount = state.grid.points.length;
  if (savedCount < requiredCount) {
    return flash(`পুরো জমির বিশ্লেষণের আগে সব পয়েন্টের reading save করুন: ${savedCount}/${requiredCount}টি সম্পন্ন।`, 'error');
  }
  const button = $('run-calculation');
  button.disabled = true; button.textContent = 'পুরো জমির তথ্য বিশ্লেষণ হচ্ছে…';
  try {
    const data = await api('/api/fertilizer/calculate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        field_id: state.fieldId,
        crop: $('field-crop').value,
        variety: $('field-variety').value,
        season: $('field-season').value,
        yield_goal: $('field-yield').value,
        rhizobium_used: $('field-rhizobium').checked
      })
    });
    state.recommendation = data;
    $('vra-field-id').value = state.fieldId;
    showPage('vra');
    await loadVRA();
    flash('পুরো জমির সংরক্ষিত নমুনা থেকে FRG-2024 ভিত্তিক প্রাথমিক সার পরিকল্পনা তৈরি হয়েছে।', 'success');
  } catch (error) { flash(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = 'পুরো জমির সার ও ফলন পরিকল্পনা তৈরি করুন'; }
});

async function loadVRA() {
  const id = Number($('vra-field-id').value);
  if (!id) return flash('মাঠের ID লিখুন।', 'error');
  try {
    state.vra = await api(`/api/vra/${id}?grid=40`);
    state.recommendation = state.vra.recommendation || state.recommendation;
    drawVRA();
    renderVraLegend();
    renderPoints();
    renderRecommendation(state.vra.recommendation);
    const progress = state.vra.sampling_progress;
    if (progress && !progress.complete) {
      flash(`এখনো পুরো মাঠের নমুনা সম্পূর্ণ হয়নি: ${progress.saved_points}/${progress.required_points}টি। সম্পূর্ণ prescription-এর আগে সব point save করুন।`, 'info');
    } else if (!state.vra.samples.length) {
      flash('এই মাঠে এখনো কোনো নমুনা সংরক্ষণ করা হয়নি।', 'info');
    }
  } catch (error) { flash(error.message, 'error'); }
}
$('load-vra').addEventListener('click', loadVRA);
document.querySelectorAll('.chip').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.chip').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  state.layer = button.dataset.layer;
  drawVRA();
  renderVraLegend();
}));

const CLASS_COLORS = {
  'Optimum': '#238653',
  'Medium': '#d7d848',
  'Low': '#ee9b38',
  'Very Low': '#d93632',
  'High': '#b9c2bd',
  'Very High': '#7b8782',
  'No Data': '#d9dfdc'
};
const PRODUCT_BN = { Urea: 'ইউরিয়া', TSP: 'টিএসপি', MOP: 'এমওপি (পটাশ)' };
function productRateForPoint(point) {
  return point?.product_rates?.[state.layer] || null;
}
function drawVRA() {
  const canvas = $('vra-canvas');
  if (!canvas) return;
  const context = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  context.clearRect(0, 0, W, H);
  context.fillStyle = '#eef8f2';
  context.fillRect(0, 0, W, H);
  if (!state.vra) return;

  const field = state.vra.field;
  const samples = state.vra.samples || [];
  const surface = state.vra.surface || [];
  const grid = Number(state.vra.grid_resolution) || 40;
  if (!samples.length || !surface.length) {
    context.fillStyle = '#355b49'; context.font = 'bold 27px "Noto Sans Bengali", sans-serif';
    context.fillText('মানচিত্র তৈরির আগে অন্তত একটি নমুনা সংরক্ষণ করুন', 48, 75);
    return;
  }

  // Draw IDW-estimated fertilizer-rate zones; colour is FRG status class, not a random gradient.
  const cellW = W / grid, cellH = H / grid;
  surface.forEach((point, index) => {
    const gx = index % grid;
    const gy = Math.floor(index / grid);
    const rate = productRateForPoint(point);
    const color = !rate || !rate.applicable ? '#d9dfdc' : (CLASS_COLORS[rate.status_class] || '#d9dfdc');
    context.fillStyle = color;
    context.fillRect(gx * cellW, H - (gy + 1) * cellH, Math.ceil(cellW + 0.5), Math.ceil(cellH + 0.5));
  });

  // Field boundary and subtle frame.
  context.strokeStyle = '#145f42'; context.lineWidth = 5;
  context.strokeRect(2.5, 2.5, W - 5, H - 5);

  // Sampling coordinates. White/green circles represent actual saved samples.
  samples.forEach((sample) => {
    const px = (Number(sample.x_m) / Number(field.length_m)) * W;
    const py = H - (Number(sample.y_m) / Number(field.width_m)) * H;
    context.beginPath(); context.arc(px, py, 9, 0, Math.PI * 2);
    context.fillStyle = '#ffffff'; context.fill();
    context.lineWidth = 3; context.strokeStyle = '#0b5b3d'; context.stroke();
    const tag = pointId(sample.point_no);
    context.font = 'bold 15px sans-serif';
    const tw = context.measureText(tag).width + 14;
    context.fillStyle = '#ffffff'; context.fillRect(px + 12, py - 13, tw, 25);
    context.fillStyle = '#143b2b'; context.fillText(tag, px + 19, py + 5);
  });

  // Title band with unit/rate context.
  context.font = 'bold 22px "Noto Sans Bengali", sans-serif';
  const title = `${PRODUCT_BN[state.layer]} • IDW • ${fmtCoord(field.length_m)}×${fmtCoord(field.width_m)} মি • kg/ha`;
  const titleW = Math.min(W - 30, context.measureText(title).width + 30);
  context.fillStyle = '#ffffff'; context.fillRect(14, 14, titleW, 46);
  context.fillStyle = '#163e2d'; context.fillText(title, 27, 44);

  // Sampling progress note in the bottom margin.
  const progress = state.vra.sampling_progress;
  if (progress && !progress.complete) {
    const note = `নমুনা ${progress.saved_points}/${progress.required_points} • সম্পূর্ণ map নয়`;
    context.font = 'bold 17px "Noto Sans Bengali", sans-serif';
    const nw = context.measureText(note).width + 20;
    context.fillStyle = '#ffffff'; context.fillRect(W - nw - 15, H - 43, nw, 29);
    context.fillStyle = '#8b3c2e'; context.fillText(note, W - nw - 5, H - 23);
  }
}

function renderVraLegend() {
  const container = $('vra-legend');
  if (!container) return;
  const entries = state.vra?.legend?.[state.layer] || [];
  if (!entries.length) {
    container.innerHTML = '<p class="muted">সারমাত্রার legend দেখাতে মাঠ ও ফসল নির্বাচন করে বিশ্লেষণ করুন।</p>';
    return;
  }
  const title = PRODUCT_BN[state.layer] || state.layer;
  container.innerHTML = `<div class="legend-heading"><strong>${escapeHtml(title)} — রঙের অর্থ ও মাত্রা</strong><span>FRG-2024 • kg/ha</span></div><div class="legend-grid">${entries.map((entry) => {
    const label = translateClass(entry.status_class);
    const rate = entry.applicable && entry.min_kg_ha !== null && entry.max_kg_ha !== null
      ? `${fmt(entry.min_kg_ha, 1)}–${fmt(entry.max_kg_ha, 1)} kg/ha`
      : 'এই শ্রেণির জন্য আলাদা dose নেই';
    const color = entry.applicable ? (CLASS_COLORS[entry.status_class] || '#d9dfdc') : '#d9dfdc';
    const note = entry.applicable ? '' : `<small>${escapeHtml(entry.note_bn || 'ল্যাব soil-test প্রয়োজন।')}</small>`;
    return `<div class="legend-entry"><span class="legend-swatch" style="background:${color}"></span><div><strong>${escapeHtml(label)}</strong><span>${rate}</span>${note}</div></div>`;
  }).join('')}</div><p class="small-note muted">রঙ মাটির interpolated শ্রেণি অনুযায়ী। High/Very High শ্রেণিতে FRG-2024-এর crop table আলাদা dose না দিলে ধূসর zone দেখানো হয়; এটিকে শূন্য সারমাত্রা হিসেবে ধরে নেবেন না।</p>`;
}

function renderRecommendation(report) {
  const container = $('recommendation-report');
  if (!container) return;
  if (!report) {
    container.innerHTML = '<div class="card"><p class="muted">পূর্ণ নমুনা সংরক্ষণ করে “পুরো জমির সার ও ফলন পরিকল্পনা তৈরি করুন” চাপলে FRG-2024-এর ফলাফল এখানে দেখাবে।</p></div>';
    return;
  }
  const y = report.yield_comparison || {};
  const fmtYieldRange = (a, b) => `${fmt(a, 2)}–${fmt(b, 2)} টন/হেক্টর`;
  let beforeHtml = '<strong>সংখ্যাগত রেঞ্জ নেই</strong><p>FRG-2024-এর সাধারণ response table এই nutrient status-এর জন্য fertilizer ছাড়া yield-এর নির্দিষ্ট শতাংশ দেয় না। তাই অনুমান করে ফলন বানানো হয়নি।</p>';
  if (y.before_range_available) {
    const beforePct = y.before_percent_range || [];
    beforeHtml = `<strong>${fmtYieldRange(y.before_fertilizer_min_t_ha, y.before_fertilizer_max_t_ha)}</strong><p>মোট জমিতে আনুমানিক ${fmt(y.before_fertilizer_min_field_kg, 1)}–${fmt(y.before_fertilizer_max_field_kg, 1)} কেজি। FRG-2024 Table 2-এর ভিত্তিতে সর্বাধিক yield goal-এর ${fmt(beforePct[0], 0)}–${fmt(beforePct[1], 0)}% হিসাবে হিসাব; এটি প্রকৃত মাপা ফলন নয়। Limiting nutrient: ${escapeHtml(y.limiting_nutrient || '—')} (${fmt(y.critical_limit_percent, 1)}% critical limit)।</p>`;
  }
  const afterHtml = `<strong>${fmtYieldRange(y.after_fertilizer_min_t_ha, y.after_fertilizer_max_t_ha)}</strong><p>জমির আয়তন অনুযায়ী লক্ষ্য-পরিসর ${fmt(y.after_fertilizer_min_field_kg, 1)}–${fmt(y.after_fertilizer_max_field_kg, 1)} কেজি। এটি FRG-2024 yield goal, নিশ্চিত ফলন পূর্বাভাস নয়।</p>`;
  const classes = report.classes || {};
  const nutRows = [
    ['N', 'নাইট্রোজেন', classes.N, 'মূল একক %'],
    ['P', 'ফসফরাস', classes.P, report.crop === 'Rice' ? 'মূল একক µg/g (ধানের wetland শ্রেণি)' : 'মূল একক µg/g'],
    ['K', 'পটাশিয়াম', classes.K, 'মূল একক meq/100g']
  ];
  const fertilizerRows = Object.entries(report.fertilizer_totals || {}).map(([key, item]) => {
    const product = PRODUCT_BN[key] || item.label_bn || key;
    const complete = item.area_total_complete;
    const dosage = item.average_min_kg_ha === null || item.average_max_kg_ha === null
      ? 'প্রযোজ্য/গণনাযোগ্য অঞ্চল নেই'
      : `${fmt(item.average_min_kg_ha, 1)}–${fmt(item.average_max_kg_ha, 1)} kg/ha`;
    const total = complete
      ? `${fmt(item.total_min_kg, 2)}–${fmt(item.total_max_kg, 2)} কেজি`
      : `গণনাযোগ্য ${fmt(item.rated_area_ha, 4)} ha-তে ${fmt(item.total_min_kg, 2)}–${fmt(item.total_max_kg, 2)} কেজি`;
    const coverage = `${fmt(item.coverage_percent, 1)}% এলাকা`;
    return `<tr><td><strong>${escapeHtml(product)}</strong></td><td>${dosage}</td><td>${total}<small>${coverage}${item.unrated_area_ha > 0.000001 ? ` • dose নির্ধারিত নয় ${fmt(item.unrated_area_ha, 4)} ha` : ''}</small></td></tr>`;
  }).join('');
  const organic = report.organic_fertilizer_t_ha === null || report.organic_fertilizer_t_ha === undefined
    ? '<p>এই crop profile-এ আলাদা জৈব সারের dose দেওয়া নেই।</p>'
    : `<p><strong>${fmt(report.organic_fertilizer_t_ha, 2)} টন/হেক্টর</strong> — পুরো জমিতে ${fmt(report.organic_fertilizer_field_t, 3)} টন।</p>`;
  const extra = (report.extra_nutrients_not_measured || []).map((item) => `<li>${escapeHtml(item.label_bn)}: ${escapeHtml(item.note_bn)}</li>`).join('');
  const apply = (report.application_bn || []).map((line) => `<li>${escapeHtml(line)}</li>`).join('');
  const limitations = (report.limitations_bn || []).map((line) => `<li>${escapeHtml(line)}</li>`).join('');
  const validation = state.vra?.spatial_validation;
  let validationHtml = '';
  if (!validation || !validation.valid) {
    validationHtml = `<div class="report-warning"><strong>মানচিত্রের নির্ভরযোগ্যতা</strong><p>${escapeHtml(validation?.note_bn || 'Cross-validation হিসাবের জন্য পর্যাপ্ত point নেই।')} কম point থাকলে map-টি কেবল প্রাথমিক নির্দেশক।</p></div>`;
  } else {
    const metrics = validation.metrics || {};
    validationHtml = `<div class="report-warning"><strong>Spatial validation (IDW, leave-one-out)</strong><p>N MAE ${fmt(metrics.N?.mae, 4)} • P MAE ${fmt(metrics.P?.mae, 2)} • K MAE ${fmt(metrics.K?.mae, 4)}। ${escapeHtml(validation.note_bn || '')}</p></div>`;
  }
  const progress = state.vra?.sampling_progress;
  container.innerHTML = `
    <div class="card recommendation-card">
      <div class="recommendation-title"><div><span class="eyebrow">FRG-2024 • প্রাথমিক পরিকল্পনা</span><h3>ফসল, সার ও সম্ভাব্য ফলন</h3></div><span class="badge">${fmtCoord(report.sample_count, 0)}টি নমুনা</span></div>
      <p class="muted small-note">ফসল: ${escapeHtml(cropName(report.crop))} • জাত: ${escapeHtml(report.variety_bn || report.variety || '—')} • মৌসুম: ${escapeHtml(report.season_label_bn || seasonName(report.season))} • জমি: ${fmt(report.field_area_m2, 1)} মি² (${fmt(report.field_area_ha, 4)} হেক্টর) • উৎস: ${escapeHtml(report.source_page || 'FRG-2024')}</p>
      ${progress && !progress.complete ? `<div class="report-warning"><strong>নমুনা অসম্পূর্ণ</strong><p>${fmtCoord(progress.saved_points, 0)}/${fmtCoord(progress.required_points, 0)} পয়েন্ট save হয়েছে। ফলাফল কেবল বর্তমানে সংরক্ষিত sample-এর প্রাথমিক মানচিত্র; সব point save না করা পর্যন্ত পূর্ণ মাঠের সার পরিকল্পনা তৈরি করবেন না।</p></div>` : ''}
      <div class="yield-comparison">
        <article><span>সার প্রয়োগ ছাড়া — গাইডভিত্তিক রেফারেন্স</span>${beforeHtml}</article>
        <article><span>সার ব্যবস্থাপনার পরে — FRG yield goal</span>${afterHtml}</article>
      </div>
      <p class="small-note muted">ফলনের দুই মানের তুলনা FRG-2024-এর সাধারণ response band ও crop yield goal থেকে তৈরি প্রাথমিক হিসাব। সার দেওয়ার পরের প্রকৃত ফলন আবহাওয়া, সেচ, জাত, রোগবালাই এবং মাঠের ব্যবস্থাপনার ওপর নির্ভর করে।</p>
    </div>
    <div class="card recommendation-card"><h3>পুষ্টির শ্রেণি ও সার পরিকল্পনা</h3>
      <div class="nutrient-status-grid">${nutRows.map(([key, label, cls, unit]) => `<div><span>${label} (${key})</span><strong>${escapeHtml(translateClass(cls))}</strong><small>${escapeHtml(unit)}</small></div>`).join('')}</div>
      <div class="table-wrap"><table class="recommendation-table"><thead><tr><th>সার</th><th>প্রস্তাবিত পরিসর</th><th>এই জমির আনুমানিক পরিমাণ</th></tr></thead><tbody>${fertilizerRows}</tbody></table></div>
      <h4>জৈব সার</h4>${organic}
      <p class="small-note muted">সারের পরিমাণ FRG-2024-এর nutrient recommendation ও Appendix-10 conversion factor থেকে গণনা করা। যেখানে crop table নির্দিষ্ট শ্রেণির dose দেয় না, সেই zone ধূসর দেখানো হয়েছে; তার পরিমাণকে শূন্য ধরে নেওয়া হয়নি।</p>
    </div>
    <div class="card recommendation-card"><h3>সার প্রয়োগের সময় ও সতর্কতা</h3><ul>${apply || '<li>নির্বাচিত crop profile-এ বিস্তারিত প্রয়োগ নির্দেশনা নেই; FRG-2024-এর crop-specific পৃষ্ঠা দেখুন।</li>'}</ul>
      ${extra ? `<h4>যে nutrient sensor মাপে না</h4><ul>${extra}</ul>` : ''}
      ${validationHtml}
      <h4>এই হিসাবের সীমাবদ্ধতা</h4><ul>${limitations}</ul>
      <p class="source-note">Reference: Bangladesh Agricultural Research Council (BARC), Fertilizer Recommendation Guide-2024. Crop table: ${escapeHtml(report.source_page || 'প্রাসঙ্গিক FRG-2024 crop table')}; soil class: Appendix-8; conversion factor: Appendix-10.</p>
    </div>`;
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
// Crop, season and variety options come from the FRG-2024 tables included with this project.
function cropName(value) {
  const map = { Rice: 'ধান', Wheat: 'গম', Lentil: 'মসুর ডাল', Onion: 'পেঁয়াজ', Maize: 'ভুট্টা', Potato: 'আলু', Tomato: 'টমেটো', Eggplant: 'বেগুন', Chili: 'মরিচ', Mustard: 'সরিষা' };
  return map[value] || value || '—';
}
function seasonName(value) {
  const map = { Boro: 'বোরো', Aus: 'আউশ', Aman: 'আমন', Rabi: 'রবি', Summer: 'গ্রীষ্মকালীন' };
  return map[value] || value || '—';
}
function getSelectedProfile() {
  const token = $('field-variety')?.value || '';
  const key = token.split('|', 1)[0];
  return state.frgProfiles.find((profile) => profile.key === key) || null;
}
function updateYieldDisplay() {
  const profile = getSelectedProfile();
  $('field-yield').value = profile
    ? `${profile.yield_goal_t_ha} ± ${profile.yield_tolerance_t_ha} টন/হেক্টর (FRG-2024, পৃষ্ঠা ${String(profile.source_page || '').match(/p\.(\d+)/)?.[1] || '—'})`
    : 'জাত নির্বাচন করলে ফলন লক্ষ্য দেখাবে';
}
function updateVarietyOptions(crop, season, selected = '') {
  const select = $('field-variety');
  select.innerHTML = '';
  if (!crop || !season) {
    select.disabled = true;
    select.appendChild(new Option('আগে ফসল ও মৌসুম নির্বাচন করুন', ''));
    $('field-yield').value = 'ফসল, মৌসুম ও জাত নির্বাচন করুন';
    return;
  }
  const profiles = state.frgProfiles.filter((profile) => profile.crop === crop && profile.season === season);
  select.disabled = false;
  select.appendChild(new Option('জাত নির্বাচন করুন', ''));
  const varieties = profiles.flatMap((profile) => profile.varieties.map((variety) => ({
    ...variety,
    goal: profile.yield_goal_t_ha,
    tolerance: profile.yield_tolerance_t_ha,
    key: profile.key
  })));
  varieties.forEach((variety) => {
    const goal = `${variety.goal} ± ${variety.tolerance} টন/হেক্টর`;
    select.appendChild(new Option(`${variety.label_bn} — ফলন লক্ষ্য ${goal}`, variety.value));
  });
  if (selected) {
    const matched = [...select.options].find((option) => option.value === selected || option.value.endsWith(`|${selected}`));
    if (matched) select.value = matched.value;
  }
  updateYieldDisplay();
}
function updateSeasonOptions(crop, selectedSeason = '', selectedVariety = '') {
  const seasonSelect = $('field-season');
  seasonSelect.innerHTML = '';
  if (!crop) {
    seasonSelect.disabled = true;
    seasonSelect.appendChild(new Option('আগে ফসল নির্বাচন করুন', ''));
    updateVarietyOptions('', '', '');
    $('rhizobium-row').classList.add('hidden');
    $('field-rhizobium').checked = false;
    return;
  }
  const seasons = [...new Map(state.frgProfiles.filter((profile) => profile.crop === crop).map((profile) => [profile.season, profile.season_label_bn])).entries()];
  seasonSelect.disabled = false;
  seasonSelect.appendChild(new Option('মৌসুম নির্বাচন করুন', ''));
  seasons.forEach(([key, label]) => seasonSelect.appendChild(new Option(label, key)));
  const chosen = seasons.find(([key]) => key === selectedSeason) || (seasons.length === 1 ? seasons[0] : null);
  seasonSelect.value = chosen ? chosen[0] : '';
  updateVarietyOptions(crop, seasonSelect.value, selectedVariety);
  const isLentil = crop === 'Lentil';
  $('rhizobium-row').classList.toggle('hidden', !isLentil);
  if (!isLentil) $('field-rhizobium').checked = false;
}
$('field-crop').addEventListener('change', () => updateSeasonOptions($('field-crop').value));
$('field-season').addEventListener('change', () => updateVarietyOptions($('field-crop').value, $('field-season').value));
$('field-variety').addEventListener('change', updateYieldDisplay);

async function restoreField(fieldId) {
  const data = await api(`/api/fields/${fieldId}`);
  const field = data.field;
  state.fieldId = Number(field.id);
  state.selectedPoint = 1;
  state.pendingSample = null;
  state.grid = null;
  localStorage.setItem('smartFarmingLastFieldId', String(field.id));
  $('field-name').value = field.name || '';
  $('field-length').value = field.length_m;
  $('field-width').value = field.width_m;
  $('field-spacing').value = field.spacing_m;
  $('field-crop').value = field.crop || '';
  updateSeasonOptions(field.crop || '', field.season || '', field.variety || '');
  $('field-season').value = field.season || '';
  updateVarietyOptions(field.crop || '', field.season || '', field.variety || '');
  $('field-rhizobium').checked = Boolean(field.rhizobium_used);
  $('rhizobium-row').classList.toggle('hidden', field.crop !== 'Lentil');
  updateYieldDisplay();
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
async function initializeApp() {
  try {
    const data = await api('/api/frg/options');
    state.frgProfiles = data.profiles || [];
  } catch (error) {
    flash('FRG-2024 ফসল/জাতের তালিকা লোড হয়নি: ' + error.message, 'error');
  }
  if (!$('field-crop').value) {
    $('field-season').disabled = true;
    $('field-variety').disabled = true;
  }
  await restoreLastField();
}
initializeApp();
