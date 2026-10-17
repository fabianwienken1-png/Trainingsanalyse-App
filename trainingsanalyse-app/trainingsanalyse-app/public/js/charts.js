// Schlanke, abhängigkeitsfreie SVG-Diagramme: tägliche Trainingslast und
// Wochenumfang nach Sportart. Tooltips per Tippen (iPhone) oder Hover (Desktop).

const SVG_NS = 'http://www.w3.org/2000/svg';

function cssVar(name, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function setupChart(container, ariaLabel, height) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  const width = Math.max(container.clientWidth, 260);
  const svg = svgEl('svg', {
    width: '100%', height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': ariaLabel
  });
  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  wrap.appendChild(tooltip);
  wrap.appendChild(svg);
  container.appendChild(wrap);

  function show(text, x, y) {
    tooltip.textContent = text;
    tooltip.style.left = (x / width) * 100 + '%';
    tooltip.style.top = y + 'px';
    tooltip.style.opacity = 1;
  }
  function hide() { tooltip.style.opacity = 0; }
  svg.addEventListener('pointerleave', hide);
  return { svg, width, show, hide };
}

function drawGrid(svg, width, chartH) {
  const grid = cssVar('--gridline', '#2a2d33');
  for (let g = 1; g <= 3; g++) {
    const y = chartH - (chartH * g) / 3;
    svg.appendChild(svgEl('line', { x1: 0, x2: width, y1: y, y2: y, stroke: grid, 'stroke-width': 1 }));
  }
  svg.appendChild(svgEl('line', {
    x1: 0, x2: width, y1: chartH, y2: chartH, stroke: cssVar('--baseline', '#3a3d44'), 'stroke-width': 1
  }));
}

function axisLabel(svg, x, y, text, anchor = 'middle') {
  const t = svgEl('text', { x, y, 'text-anchor': anchor, 'font-size': 11, fill: cssVar('--muted', '#9a9da3') });
  t.textContent = text;
  svg.appendChild(t);
}

function renderLoadChart(container, dailyLoadMap, days = 28) {
  const height = 150;
  const chartH = height - 24;
  const { svg, width, show } = setupChart(container, `Tägliche Trainingslast der letzten ${days} Tage`, height);

  const today = new Date();
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = localDateKey(d);
    series.push({ date: d, value: dailyLoadMap[key] || 0 });
  }
  const maxVal = Math.max(...series.map((s) => s.value), 1);
  const slot = width / series.length;
  const barW = Math.min(16, Math.max(3, slot * 0.6));
  const color = cssVar('--accent', '#d4f25c');

  drawGrid(svg, width, chartH);

  series.forEach((p, i) => {
    const barH = (p.value / maxVal) * (chartH - 10);
    const x = i * slot + (slot - barW) / 2;
    const y = chartH - barH;
    svg.appendChild(svgEl('rect', {
      x, y, width: barW, height: Math.max(barH, 1), rx: Math.min(3, barW / 2),
      fill: color, opacity: p.value > 0 ? 1 : 0.15
    }));
    const hit = svgEl('rect', { x: i * slot, y: 0, width: slot, height: chartH, fill: 'transparent' });
    const text = `${p.date.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}: ${Math.round(p.value)} Punkte`;
    hit.addEventListener('pointerenter', () => show(text, x + barW / 2, y));
    hit.addEventListener('pointerdown', () => show(text, x + barW / 2, y));
    svg.appendChild(hit);
    if (i % 7 === 0 || i === series.length - 1) {
      const anchor = i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle';
      const lx = anchor === 'start' ? x : anchor === 'end' ? x + barW : x + barW / 2;
      axisLabel(svg, lx, height - 6, p.date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }), anchor);
    }
  });
}

// weeks: [{ label, total, segments: [{ color, value, name }] }]  (value in Stunden)
function renderVolumeChart(container, weeks) {
  const height = 170;
  const chartH = height - 24;
  const { svg, width, show } = setupChart(container, 'Trainingsumfang pro Woche nach Sportart', height);
  const maxVal = Math.max(...weeks.map((w) => w.total), 1);
  const slot = width / weeks.length;
  const barW = Math.min(28, slot * 0.6);

  drawGrid(svg, width, chartH);

  weeks.forEach((w, i) => {
    const x = i * slot + (slot - barW) / 2;
    let yCursor = chartH;
    const nonZero = w.segments.filter((s) => s.value > 0);
    nonZero.forEach((s, si) => {
      const h = (s.value / maxVal) * (chartH - 10);
      yCursor -= h;
      svg.appendChild(svgEl('rect', {
        x, y: yCursor, width: barW, height: Math.max(h - (si < nonZero.length - 1 ? 1 : 0), 0.5),
        rx: si === nonZero.length - 1 ? 3 : 0, fill: s.color
      }));
    });
    if (!nonZero.length) {
      svg.appendChild(svgEl('rect', { x, y: chartH - 2, width: barW, height: 2, fill: cssVar('--border', '#2a2d33') }));
    }
    const detail = nonZero.map((s) => `${s.name} ${formatHours(s.value)}`).join(' · ');
    const text = `${w.label}: ${formatHours(w.total)}${detail ? ' (' + detail + ')' : ''}`;
    const hit = svgEl('rect', { x: i * slot, y: 0, width: slot, height: chartH, fill: 'transparent' });
    hit.addEventListener('pointerenter', () => show(text, x + barW / 2, Math.max(yCursor, 30)));
    hit.addEventListener('pointerdown', () => show(text, x + barW / 2, Math.max(yCursor, 30)));
    svg.appendChild(hit);
    axisLabel(svg, x + barW / 2, height - 6, w.label);
  });
}

function formatHours(h) {
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return hh > 0 ? `${hh}:${String(mm).padStart(2, '0')} h` : `${mm} min`;
}

function localDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// series: [{ date: 'YYYY-MM-DD', total, deep, rem }] (Stunden, null = keine Daten)
function renderSleepChart(container, series, targetHours = 7) {
  const height = 150;
  const chartH = height - 24;
  const { svg, width, show } = setupChart(container, 'Schlafdauer der letzten Nächte', height);
  const maxVal = Math.max(9, ...series.map((p) => p.total || 0));
  const slot = width / series.length;
  const barW = Math.min(16, Math.max(3, slot * 0.6));
  const color = '#9b8cf2';
  const lowColor = cssVar('--warning', '#f5b544');

  drawGrid(svg, width, chartH);
  const yT = chartH - (targetHours / maxVal) * (chartH - 10);
  svg.appendChild(svgEl('line', { x1: 0, x2: width, y1: yT, y2: yT, stroke: cssVar('--text-2', '#c9cbcf'), 'stroke-width': 1, 'stroke-dasharray': '4 4', opacity: 0.6 }));
  const tl = svgEl('text', { x: width - 2, y: yT - 4, 'text-anchor': 'end', 'font-size': 11, fill: cssVar('--muted', '#9a9da3') });
  tl.textContent = `${targetHours} h`;
  svg.appendChild(tl);

  series.forEach((p, i) => {
    const v = p.total || 0;
    const barH = (v / maxVal) * (chartH - 10);
    const x = i * slot + (slot - barW) / 2;
    const y = chartH - barH;
    if (v > 0) {
      svg.appendChild(svgEl('rect', { x, y, width: barW, height: barH, rx: Math.min(3, barW / 2), fill: v < 6 ? lowColor : color }));
    }
    const d = new Date(p.date + 'T12:00:00');
    const parts = [];
    if (p.deep) parts.push(`Tief ${formatHours(p.deep)}`);
    if (p.rem) parts.push(`REM ${formatHours(p.rem)}`);
    const text = `${d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}: ${v ? formatHours(v) : 'keine Daten'}${parts.length ? ' (' + parts.join(', ') + ')' : ''}`;
    const hit = svgEl('rect', { x: i * slot, y: 0, width: slot, height: chartH, fill: 'transparent' });
    hit.addEventListener('pointerenter', () => show(text, x + barW / 2, Math.max(y, 30)));
    hit.addEventListener('pointerdown', () => show(text, x + barW / 2, Math.max(y, 30)));
    svg.appendChild(hit);
    if (i % 7 === 0 || i === series.length - 1) {
      const anchor = i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle';
      const lx = anchor === 'start' ? x : anchor === 'end' ? x + barW : x + barW / 2;
      axisLabel(svg, lx, height - 6, d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }), anchor);
    }
  });
}

// points: [{ week: 'YYYY-MM-DD', value|null }] – Linie mit Punkten, Lücken werden überbrückt
function renderTrendChart(container, points, opts = {}) {
  const height = 96;
  const chartH = height - 20;
  const { svg, width, show } = setupChart(container, `${opts.label || 'Trend'} der letzten Wochen`, height);
  const vals = points.filter((p) => p.value !== null).map((p) => p.value);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  const pad = (max - min) * 0.2 || Math.abs(max) * 0.05 || 1;
  min -= pad; max += pad;
  const slot = width / points.length;
  const xOf = (i) => i * slot + slot / 2;
  const yOf = (v) => 6 + (1 - (v - min) / (max - min)) * (chartH - 12);
  const grid = cssVar('--gridline', '#2a2d33');
  svg.appendChild(svgEl('line', { x1: 0, x2: width, y1: chartH, y2: chartH, stroke: cssVar('--baseline', '#3a3d44'), 'stroke-width': 1 }));
  svg.appendChild(svgEl('line', { x1: 0, x2: width, y1: chartH / 2, y2: chartH / 2, stroke: grid, 'stroke-width': 1 }));
  const color = opts.color || cssVar('--accent', '#d4f25c');
  let d = '';
  points.forEach((p, i) => {
    if (p.value === null) return;
    d += `${d ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(p.value).toFixed(1)}`;
  });
  svg.appendChild(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  points.forEach((p, i) => {
    const date = new Date(p.week + 'T12:00:00');
    if (p.value !== null) {
      svg.appendChild(svgEl('circle', { cx: xOf(i), cy: yOf(p.value), r: i === points.length - 1 ? 3.5 : 2, fill: color }));
    }
    const text = `Woche ab ${date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}: ${p.value === null ? 'keine Daten' : p.value.toLocaleString('de-DE', { maximumFractionDigits: opts.decimals ?? 1 }) + ' ' + (opts.unit || '')}`;
    const hit = svgEl('rect', { x: i * slot, y: 0, width: slot, height: chartH, fill: 'transparent' });
    const y = p.value === null ? chartH / 2 : yOf(p.value);
    hit.addEventListener('pointerenter', () => show(text, xOf(i), Math.max(y, 24)));
    hit.addEventListener('pointerdown', () => show(text, xOf(i), Math.max(y, 24)));
    svg.appendChild(hit);
    if (i === 0 || i === points.length - 1 || i === Math.floor(points.length / 2)) {
      const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle';
      axisLabel(svg, anchor === 'start' ? 0 : anchor === 'end' ? width : xOf(i), height - 4, date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }), anchor);
    }
  });
}

window.renderTrendChart = renderTrendChart;
window.renderLoadChart = renderLoadChart;
window.renderSleepChart = renderSleepChart;
window.renderVolumeChart = renderVolumeChart;
