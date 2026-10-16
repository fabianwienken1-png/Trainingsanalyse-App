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

window.renderLoadChart = renderLoadChart;
window.renderVolumeChart = renderVolumeChart;
