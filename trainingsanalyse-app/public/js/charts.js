// Schlanke, abhängigkeitsfreie SVG-Bar-Chart-Komponente für die tägliche
// Trainingslast. Folgt den Mark-Specs aus dem dataviz-Skill: dünne Balken,
// abgerundetes oberes Ende, Haarlinien-Gitter, Hover-Tooltip.

function renderLoadChart(container, dailyLoadMap, days = 28) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';

  const width = container.clientWidth || 320;
  const height = 140;
  const svgNS = 'http://www.w3.org/2000/svg';

  // Letzte `days` Tage als Datenreihe aufbauen (fehlende Tage = 0)
  const today = new Date();
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    series.push({ date: key, value: dailyLoadMap[key] || 0 });
  }
  const maxVal = Math.max(...series.map((s) => s.value), 1);

  const chartH = height - 24; // Platz für x-Achse unten
  const barSlot = width / series.length;
  const barW = Math.min(18, Math.max(3, barSlot * 0.6));

  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Tägliche Trainingslast der letzten ' + days + ' Tage');

  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--gridline').trim() || '#e1e0d9';
  const baselineColor = style.getPropertyValue('--baseline').trim() || '#c3c2b7';
  const barColor = style.getPropertyValue('--series-1').trim() || '#2a78d6';
  const mutedColor = style.getPropertyValue('--text-muted').trim() || '#898781';

  // Haarlinien-Gitter (3 horizontale Linien)
  for (let g = 1; g <= 3; g++) {
    const y = chartH - (chartH * g) / 3;
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', 0);
    line.setAttribute('x2', width);
    line.setAttribute('y1', y);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', gridColor);
    line.setAttribute('stroke-width', 1);
    svg.appendChild(line);
  }

  // Baseline
  const baseline = document.createElementNS(svgNS, 'line');
  baseline.setAttribute('x1', 0);
  baseline.setAttribute('x2', width);
  baseline.setAttribute('y1', chartH);
  baseline.setAttribute('y2', chartH);
  baseline.setAttribute('stroke', baselineColor);
  baseline.setAttribute('stroke-width', 1);
  svg.appendChild(baseline);

  const tooltip = document.createElement('div');
  tooltip.className = 'chart-tooltip';
  wrap.appendChild(tooltip);

  series.forEach((point, i) => {
    const barH = maxVal > 0 ? (point.value / maxVal) * (chartH - 10) : 0;
    const x = i * barSlot + (barSlot - barW) / 2;
    const y = chartH - barH;

    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', barW);
    rect.setAttribute('height', Math.max(barH, 1));
    rect.setAttribute('rx', Math.min(4, barW / 2));
    rect.setAttribute('fill', barColor);
    rect.setAttribute('opacity', point.value > 0 ? '1' : '0.15');

    rect.addEventListener('mouseenter', () => showTooltip(point, x + barW / 2, y));
    rect.addEventListener('mousemove', () => showTooltip(point, x + barW / 2, y));
    rect.addEventListener('mouseleave', () => (tooltip.style.opacity = 0));
    svg.appendChild(rect);

    // Nur jeden 7. Tag beschriften (sonst zu voll)
    if (i % 7 === 0 || i === series.length - 1) {
      const label = document.createElementNS(svgNS, 'text');
      label.setAttribute('x', x + barW / 2);
      label.setAttribute('y', height - 6);
      label.setAttribute('text-anchor', 'middle');
      label.setAttribute('font-size', '10');
      label.setAttribute('fill', mutedColor);
      label.textContent = point.date.slice(5).replace('-', '.');
      svg.appendChild(label);
    }
  });

  function showTooltip(point, x, y) {
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
    tooltip.style.opacity = 1;
    tooltip.textContent = `${formatDate(point.date)}: ${Math.round(point.value)} Punkte`;
  }

  wrap.appendChild(svg);
  container.appendChild(wrap);
}

function formatDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
}

window.renderLoadChart = renderLoadChart;
