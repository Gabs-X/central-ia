/* global central, esc, fmtTokens, brDate, toast, MODEL_OPTIONS */
// Tela "Uso": gastos por dia e por função, evolução da cota, orçamento e o que o roteador aprendeu.

const FEATURE_LABEL = {
  chat: 'Conversas', routine: 'Rotinas', quick: 'Janela rápida', meetings: 'Reuniões', busca: 'Busca nas reuniões',
  briefing: 'Briefings', cobranca: 'Cobranças', slack: 'Slack',
};
const SERIES = [
  { key: 'claude', label: 'Claude', color: 'var(--claude)', cls: 'sw-claude' },
  { key: 'codex', label: 'Codex', color: 'var(--codex)', cls: 'sw-codex' },
];
const tok = (p) => (p ? (p.input || 0) + (p.cached || 0) + (p.output || 0) : 0);

// ---------- Tooltip ----------
const tip = document.createElement('div');
tip.className = 'viz-tip';
tip.hidden = true;
document.body.appendChild(tip);
function showTip(e, title, rows) {
  tip.replaceChildren();
  const h = document.createElement('div');
  h.className = 'tt-title';
  h.textContent = title;
  tip.appendChild(h);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'tt-row';
    const key = document.createElement('i');
    key.style.background = r.color;
    const v = document.createElement('b');
    v.textContent = r.value;
    const l = document.createElement('span');
    l.textContent = r.label;
    row.append(key, v, l);
    tip.appendChild(row);
  }
  tip.hidden = false;
  const x = Math.min(window.innerWidth - tip.offsetWidth - 12, e.clientX + 14);
  const y = Math.max(8, e.clientY - tip.offsetHeight - 10);
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
const hideTip = () => (tip.hidden = true);

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
}

// Barra com cantos de 4px só na ponta de dados (topo), presa à base.
function barPath(x, y, w, h, r = 4) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function barPathH(x, y, w, h, r = 4) {
  r = Math.min(r, h / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

function legend(series) {
  return `<div class="legend">${series.map((s) => `<span><i class="${s.cls}${s.line ? ' line' : ''}"></i>${esc(s.label)}</span>`).join('')}</div>`;
}

// ---------- Gráfico 1: tokens por dia (barras empilhadas) ----------
function dailyChart(container, days) {
  const W = container.clientWidth || 640;
  const H = 220;
  const m = { t: 12, r: 8, b: 26, l: 44 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const totals = days.map((d) => tok(d.claude) + tok(d.codex));
  const max = niceMax(Math.max(...totals, 1));
  const svg = svgEl('svg', { width: W, height: H, role: 'img', 'aria-label': 'Tokens por dia, Claude e Codex' });
  for (let i = 0; i <= 2; i++) {
    const v = (max / 2) * i;
    const y = m.t + ih - (v / max) * ih;
    svgEl('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: 'grid' }, svg);
    svgEl('text', { x: m.l - 6, y: y + 4, class: 'axis', 'text-anchor': 'end' }, svg).textContent = fmtTokens(v);
  }
  const step = iw / days.length;
  const bw = Math.max(4, Math.min(28, step * 0.62));
  days.forEach((d, i) => {
    const x = m.l + i * step + (step - bw) / 2;
    let base = m.t + ih;
    const vals = SERIES.map((s) => ({ s, v: tok(d[s.key]) }));
    const nonzero = vals.filter((x) => x.v > 0);
    nonzero.forEach(({ s, v }, j) => {
      const h = (v / max) * ih;
      const gap = j > 0 ? 2 : 0; // 2px de superfície entre segmentos
      const top = base - h;
      const isTop = j === nonzero.length - 1;
      const p = svgEl('path', { d: isTop ? barPath(x, top, bw, Math.max(0, h - gap)) : `M${x},${base - gap}V${top}H${x + bw}V${base - gap}Z`, fill: s.color, class: 'mark', tabindex: 0 }, svg);
      const rows = vals.map(({ s: ss, v: vv }) => ({ color: ss.color, value: fmtTokens(vv), label: ss.label }));
      p.addEventListener('pointermove', (e) => showTip(e, brDate(d.date), rows));
      p.addEventListener('pointerleave', hideTip);
      p.addEventListener('focus', (e) => {
        const r = p.getBoundingClientRect();
        showTip({ clientX: r.right, clientY: r.top }, brDate(d.date), rows);
      });
      p.addEventListener('blur', hideTip);
      base = top;
    });
    // Rótulo do eixo X: espaçado para não colidir.
    const every = Math.ceil(days.length / Math.max(1, Math.floor(iw / 46)));
    if (i % every === 0 || i === days.length - 1) {
      svgEl('text', { x: x + bw / 2, y: H - 8, class: 'axis', 'text-anchor': 'middle' }, svg).textContent = brDate(d.date);
    }
  });
  container.replaceChildren(svg);
}

// ---------- Gráfico 2: tokens por função (barras horizontais empilhadas) ----------
function featureChart(container, rows) {
  const W = container.clientWidth || 640;
  const rowH = 26;
  const m = { t: 4, r: 64, b: 4, l: 140 };
  const H = m.t + m.b + rows.length * rowH;
  const iw = W - m.l - m.r;
  const max = niceMax(Math.max(...rows.map((r) => r.claude + r.codex), 1));
  const svg = svgEl('svg', { width: W, height: H, role: 'img', 'aria-label': 'Tokens por função nos últimos 7 dias' });
  rows.forEach((r, i) => {
    const y = m.t + i * rowH + 5;
    const h = rowH - 10;
    svgEl('text', { x: m.l - 8, y: y + h / 2 + 4, class: 'label', 'text-anchor': 'end' }, svg).textContent = r.label;
    let x = m.l;
    const parts = SERIES.map((s) => ({ s, v: r[s.key] })).filter((p) => p.v > 0);
    parts.forEach(({ s, v }, j) => {
      const w = (v / max) * iw;
      const gap = j > 0 ? 2 : 0;
      const isEnd = j === parts.length - 1;
      const p = svgEl('path', { d: isEnd ? barPathH(x + gap, y, Math.max(0, w - gap), h) : `M${x + gap},${y}H${x + w}V${y + h}H${x + gap}Z`, fill: s.color, class: 'mark', tabindex: 0 }, svg);
      const tt = SERIES.map((ss) => ({ color: ss.color, value: fmtTokens(r[ss.key]), label: ss.label }));
      p.addEventListener('pointermove', (e) => showTip(e, `${r.label} · ${r.calls} pedido(s)`, tt));
      p.addEventListener('pointerleave', hideTip);
      x += w;
    });
    svgEl('text', { x: x + 6, y: y + h / 2 + 4, class: 'value' }, svg).textContent = fmtTokens(r.claude + r.codex);
  });
  container.replaceChildren(svg);
}

// ---------- Gráfico 3: cota ao longo do tempo (linhas + mira) ----------
function quotaChart(container, history, budget) {
  const W = container.clientWidth || 640;
  const H = 200;
  const m = { t: 10, r: 10, b: 24, l: 40 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const since = Date.now() - 48 * 3600e3;
  const pts = history.filter((h) => h.t >= since);
  const svg = svgEl('svg', { width: W, height: H, role: 'img', 'aria-label': 'Uso da janela de 5 horas nas últimas 48 horas' });
  if (pts.length < 2) {
    container.innerHTML = '<p class="muted small">O histórico começa a aparecer depois de algumas horas com a Central aberta (uma amostra a cada 15 min).</p>';
    return;
  }
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const X = (t) => m.l + ((t - t0) / Math.max(1, t1 - t0)) * iw;
  const Y = (v) => m.t + ih - v * ih;
  for (const v of [0, 0.5, 1]) {
    svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'grid' }, svg);
    svgEl('text', { x: m.l - 6, y: Y(v) + 4, class: 'axis', 'text-anchor': 'end' }, svg).textContent = `${v * 100}%`;
  }
  // Linha de referência: orçamento das funções automáticas.
  svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(budget), y2: Y(budget), class: 'refline' }, svg);
  svgEl('text', { x: W - m.r, y: Y(budget) - 4, class: 'axis', 'text-anchor': 'end' }, svg).textContent = `orçamento automático ${Math.round(budget * 100)}%`;
  const lines = [
    { key: 'c5', label: 'Claude · 5h', color: 'var(--claude)' },
    { key: 'x5', label: 'Codex · 5h', color: 'var(--codex)' },
  ];
  for (const l of lines) {
    const d = pts.filter((p) => p[l.key] != null).map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p[l.key]).toFixed(1)}`).join('');
    if (d) svgEl('path', { d, fill: 'none', stroke: l.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  }
  const hours = [t0, (t0 + t1) / 2, t1];
  hours.forEach((t, i) => {
    svgEl('text', { x: X(t), y: H - 6, class: 'axis', 'text-anchor': i === 0 ? 'start' : i === 2 ? 'end' : 'middle' }, svg).textContent = new Date(t).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  });
  const cross = svgEl('line', { y1: m.t, y2: m.t + ih, class: 'crosshair', visibility: 'hidden' }, svg);
  const dots = lines.map((l) => svgEl('circle', { r: 4, fill: l.color, stroke: 'var(--panel)', 'stroke-width': 2, visibility: 'hidden' }, svg));
  const hit = svgEl('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' }, svg);
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const tx = t0 + ((e.clientX - r.left - m.l) / iw) * (t1 - t0);
    const p = pts.reduce((a, b) => (Math.abs(b.t - tx) < Math.abs(a.t - tx) ? b : a));
    cross.setAttribute('x1', X(p.t));
    cross.setAttribute('x2', X(p.t));
    cross.setAttribute('visibility', 'visible');
    lines.forEach((l, i) => {
      if (p[l.key] == null) return dots[i].setAttribute('visibility', 'hidden');
      dots[i].setAttribute('cx', X(p.t));
      dots[i].setAttribute('cy', Y(p[l.key]));
      dots[i].setAttribute('visibility', 'visible');
    });
    showTip(e, new Date(p.t).toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }), lines.map((l) => ({ color: l.color, value: p[l.key] == null ? '—' : `${Math.round(p[l.key] * 100)}%`, label: l.label })));
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    hideTip();
  });
  container.replaceChildren(svg);
}

// ---------- Tela ----------
async function renderUsageView() {
  const [u, cfg, learning] = await Promise.all([central.getUsage(), central.getConfig(), central.getLearning()]);
  const body = document.getElementById('usage-body');
  const days = u.days.slice(-14);
  const today = u.today;
  const tTok = tok(today.claude) + tok(today.codex);
  const calls = (today.claude.calls || 0) + (today.codex.calls || 0);
  const bgKeys = Object.entries(cfg.features).filter(([, f]) => f.background).map(([k]) => k);
  const bgTok = Object.entries(today.byFeature || {}).filter(([k]) => bgKeys.includes(k)).reduce((s, [, f]) => s + f.tokens, 0);
  const apiValue = u.days.slice(-7).reduce((s, d) => s + (d.claude?.costUsd || 0), 0);

  // Por função, últimos 7 dias.
  const feat = {};
  for (const d of u.days.slice(-7)) {
    for (const [k, f] of Object.entries(d.byFeature || {})) {
      const x = (feat[k] ||= { key: k, label: FEATURE_LABEL[k] || k, claude: 0, codex: 0, calls: 0 });
      x.claude += f.claude || 0;
      x.codex += f.codex || 0;
      x.calls += f.calls || 0;
    }
  }
  const featRows = Object.values(feat).sort((a, b) => b.claude + b.codex - (a.claude + a.codex));

  const pct = (v) => Math.round(v * 100);
  const slider = (path, label, value, help) => `<label class="slider"><span>${label} <b data-out="${path}">${pct(value)}%</b></span><input type="range" min="30" max="100" step="5" value="${pct(value)}" data-path="${path}"><small class="muted">${help}</small></label>`;
  const featModel = (k, f) => `<tr><td>${esc(FEATURE_LABEL[k] || k)}${f.background ? ' <span class="tag">segundo plano</span>' : ''}</td>
    <td><select data-feature="${k}" data-field="model">${[['rapido', 'Haiku'], ['equilibrado', 'Sonnet'], ['profundo', 'Opus']].map(([v, l]) => `<option value="${v}" ${f.model === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
    <td><select data-feature="${k}" data-field="provider">${[['auto', 'Auto (pela cota)'], ['claude', 'Sempre Claude'], ['codex', 'Sempre Codex']].map(([v, l]) => `<option value="${v}" ${f.provider === v ? 'selected' : ''}>${l}</option>`).join('')}</select></td></tr>`;

  body.innerHTML = `
    <div class="tiles">
      <div class="tile"><small>Tokens hoje</small><b>${fmtTokens(tTok)}</b><span class="muted small">Claude ${fmtTokens(tok(today.claude))} · Codex ${fmtTokens(tok(today.codex))}</span></div>
      <div class="tile"><small>Pedidos hoje</small><b>${calls}</b><span class="muted small">${today.claude.calls || 0} Claude · ${today.codex.calls || 0} Codex</span></div>
      <div class="tile"><small>Funções automáticas hoje</small><b>${tTok ? Math.round((bgTok / tTok) * 100) : 0}%</b><span class="muted small">dos tokens (reuniões, briefings, Slack)</span></div>
      <div class="tile"><small>Valor de tabela · 7 dias</small><b>US$ ${apiValue.toFixed(2)}</b><span class="muted small">quanto o Claude custaria via API</span></div>
    </div>

    <section class="section chart-card">
      <div class="section-head"><h2>Tokens por dia</h2>${legend(SERIES)}</div>
      <div id="chart-daily" class="chart"></div>
      <details class="table-view"><summary>ver tabela</summary><table class="table"><thead><tr><th>Dia</th><th>Claude</th><th>Codex</th><th>Pedidos</th></tr></thead><tbody>${days.slice().reverse().map((d) => `<tr><td>${brDate(d.date)}</td><td>${fmtTokens(tok(d.claude))}</td><td>${fmtTokens(tok(d.codex))}</td><td>${(d.claude?.calls || 0) + (d.codex?.calls || 0)}</td></tr>`).join('')}</tbody></table></details>
    </section>

    <section class="section chart-card">
      <div class="section-head"><h2>Por função · últimos 7 dias</h2>${legend(SERIES)}</div>
      <div id="chart-feature" class="chart">${featRows.length ? '' : '<p class="muted small">Ainda sem dados por função (começa a contar a partir desta versão).</p>'}</div>
    </section>

    <section class="section chart-card">
      <div class="section-head"><h2>Janela de 5 h · últimas 48 h</h2>${legend([{ label: 'Claude · 5h', cls: 'sw-claude', line: true }, { label: 'Codex · 5h', cls: 'sw-codex', line: true }])}</div>
      <div id="chart-quota" class="chart"></div>
    </section>

    <div class="grid2">
      <section class="section">
        <h2>Orçamento de cota</h2>
        <p class="muted small">Funções automáticas param de usar uma IA quando ela passa do limite, trocam para a outra e, se as duas estiverem altas, esperam a janela renovar. Assim sobra cota para você no chat.</p>
        ${slider('budgets.backgroundClaude', 'Automáticas usam o Claude até', cfg.budgets.backgroundClaude, 'depois disso vão para o Codex')}
        ${slider('budgets.backgroundCodex', 'Automáticas usam o Codex até', cfg.budgets.backgroundCodex, 'depois disso esperam a janela renovar')}
        ${slider('quota.claudeDowngradeAt', 'No chat, Opus vira Sonnet a partir de', cfg.quota.claudeDowngradeAt, 'economiza a cota semanal')}
        ${slider('quota.claudeAvoidAt', 'No chat, vai para o Codex a partir de', cfg.quota.claudeAvoidAt, 'quando possível')}
      </section>
      <section class="section">
        <h2>Modelo de cada função</h2>
        <table class="table compact"><thead><tr><th>Função</th><th>Modelo Claude</th><th>IA</th></tr></thead><tbody>${Object.entries(cfg.features).map(([k, f]) => featModel(k, f)).join('')}</tbody></table>
        <h2>O que o roteador aprendeu</h2>
        <label class="check"><input type="checkbox" id="learn-on" ${learning.enabled ? 'checked' : ''}> Aprender com as minhas trocas manuais de modelo</label>
        ${learning.learned.length ? `<ul class="learned">${learning.learned.map((l) => `<li><b>${esc(l.label)}</b> → ${esc(l.choiceLabel)}</li>`).join('')}</ul>` : '<p class="muted small">Nada ainda. Quando você trocar o modelo de um mesmo tipo de pedido 3 vezes (das últimas 5), ele vira o padrão.</p>'}
        <p class="muted small">${learning.overrides.length} troca(s) registradas. <button class="link" id="learn-reset">Esquecer tudo</button></p>
      </section>
    </div>`;

  if (days.length) dailyChart(body.querySelector('#chart-daily'), days);
  if (featRows.length) featureChart(body.querySelector('#chart-feature'), featRows);
  quotaChart(body.querySelector('#chart-quota'), u.history || [], cfg.budgets.backgroundClaude);

  body.querySelectorAll('input[type=range]').forEach((inp) => {
    inp.addEventListener('input', () => (body.querySelector(`[data-out="${inp.dataset.path}"]`).textContent = `${inp.value}%`));
    inp.addEventListener('change', async () => {
      const [a, b] = inp.dataset.path.split('.');
      await central.setConfig({ [a]: { [b]: Number(inp.value) / 100 } });
      toast('Orçamento salvo.');
    });
  });
  body.querySelectorAll('select[data-feature]').forEach((sel) =>
    sel.addEventListener('change', async () => {
      await central.setConfig({ features: { [sel.dataset.feature]: { [sel.dataset.field]: sel.value } } });
      toast('Salvo.');
    }),
  );
  body.querySelector('#learn-on').addEventListener('change', (e) => central.setConfig({ learning: { enabled: e.target.checked } }));
  body.querySelector('#learn-reset').addEventListener('click', async () => {
    await central.resetLearning();
    renderUsageView();
  });
}

let usageResize;
window.addEventListener('resize', () => {
  clearTimeout(usageResize);
  usageResize = setTimeout(() => {
    if (!document.getElementById('view-usage').hidden) renderUsageView();
  }, 200);
});
