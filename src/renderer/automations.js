/* global central, esc, toast, openModal, closeModal, relTime, MODEL_OPTIONS, WEEKDAY_NAMES */
// Tela "Automações": atalhos de rotina (um clique) e agendamentos.

const au = { data: null, repos: [] };

const ACTION_LABEL = {
  briefing: (a) => ({ daily: 'Briefing da manhã', weekly: 'Resumo da semana', eod: 'Fechamento do dia' }[a.kind] || 'Briefing'),
  followups: () => 'Avisar cobranças atrasadas',
  slackImport: () => 'Importar menções do Slack',
  routine: (a) => {
    const r = au.data?.routines.find((x) => x.id === a.routineId);
    return r ? `Rotina: ${r.icon} ${r.name}` : 'Rotina (apagada)';
  },
};

async function renderAutomations() {
  au.data = await central.getAutomations();
  const d = au.data;
  const body = document.getElementById('auto-body');
  const modelName = (v) => MODEL_OPTIONS.find(([k]) => k === v)?.[1] || v;

  body.innerHTML = `
    <section class="section">
      <div class="section-head"><h2>Atalhos de rotina</h2><button class="btn primary small-btn" id="new-routine">+ Nova rotina</button></div>
      <p class="muted small">Um clique abre uma conversa e roda o pedido com o modelo escolhido. Também aparecem no menu da bandeja.</p>
      <div class="routine-grid">${d.routines.map((r) => `
        <div class="routine" data-id="${esc(r.id)}">
          <div class="r-icon">${esc(r.icon)}</div>
          <div class="r-main">
            <b>${esc(r.name)}</b>
            <small class="muted">${esc(modelName(r.override))} · ${esc(r.cwd)}</small>
            <p class="small r-prompt">${esc(r.prompt)}</p>
          </div>
          <div class="r-actions">
            <button class="btn primary small-btn" data-run>▶ Rodar</button>
            <button class="btn small-btn" data-edit>Editar</button>
          </div>
        </div>`).join('') || '<p class="muted">Nenhuma rotina ainda.</p>'}
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Agendamentos</h2><button class="btn primary small-btn" id="new-schedule">+ Novo agendamento</button></div>
      <p class="muted small">Rodam sozinhos enquanto a Central estiver aberta (deixe "Iniciar com o Windows" ligado na bandeja). Funções automáticas respeitam o orçamento de cota.</p>
      <table class="table">
        <thead><tr><th></th><th>Nome</th><th>Quando</th><th>Faz</th><th></th></tr></thead>
        <tbody>${d.schedules.map((s) => `
          <tr data-id="${esc(s.id)}">
            <td><label class="switch"><input type="checkbox" data-toggle ${s.enabled ? 'checked' : ''}><span></span></label></td>
            <td>${esc(s.name)}</td>
            <td class="small">${s.days.length === 7 ? 'Todo dia' : s.days.length === 5 && [1, 2, 3, 4, 5].every((x) => s.days.includes(x)) ? 'Dias úteis' : s.days.map((x) => WEEKDAY_NAMES[x]).join(', ')} · ${s.times.join(', ')}</td>
            <td class="small">${esc(ACTION_LABEL[s.action.type]?.(s.action) || s.action.type)}</td>
            <td class="row-actions"><button class="btn small-btn" data-run>Rodar agora</button><button class="btn small-btn" data-edit>Editar</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </section>

    <section class="section">
      <h2>Últimas execuções</h2>
      ${d.runs.length ? `<ul class="runs">${d.runs.slice(0, 15).map((r) => `<li><span class="run-${r.status.replace(/\s/g, '')}">${esc(r.status)}</span> ${esc(r.name)} <span class="muted small">${relTime(r.at)}${r.detail ? ` · ${esc(r.detail)}` : ''}</span></li>`).join('')}</ul>` : '<p class="muted small">Nada rodou ainda.</p>'}
    </section>`;

  body.querySelector('#new-routine').addEventListener('click', () => editRoutine());
  body.querySelector('#new-schedule').addEventListener('click', () => editSchedule());
  body.querySelectorAll('.routine').forEach((el) => {
    const r = d.routines.find((x) => x.id === el.dataset.id);
    el.querySelector('[data-run]').addEventListener('click', async () => {
      const res = await central.runRoutine(r.id);
      if (!res.ok) toast(res.error, 'error');
    });
    el.querySelector('[data-edit]').addEventListener('click', () => editRoutine(r));
  });
  body.querySelectorAll('tr[data-id]').forEach((row) => {
    const s = d.schedules.find((x) => x.id === row.dataset.id);
    row.querySelector('[data-toggle]').addEventListener('change', (e) => central.saveSchedule({ ...s, enabled: e.target.checked }));
    row.querySelector('[data-run]').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Rodando…';
      const res = await central.runSchedule(s.id);
      if (!res.ok) toast(res.error, 'error');
      else toast(`${s.name}: pronto.`);
      renderAutomations();
    });
    row.querySelector('[data-edit]').addEventListener('click', () => editSchedule(s));
  });
}

async function editRoutine(r = null) {
  if (!au.repos.length) au.repos = await central.listRepos();
  const cfg = await central.getConfig();
  const cwds = [...new Set([r?.cwd, cfg.defaultCwd, cfg.workspaceRoot, ...au.repos].filter(Boolean))];
  const card = openModal(`
    <h2>${r ? 'Editar rotina' : 'Nova rotina'}</h2>
    <div class="form">
      <label>Ícone e nome<div class="row"><input id="f-icon" class="icon-input" maxlength="4" value="${esc(r?.icon || '⚡')}"><input id="f-name" value="${esc(r?.name || '')}" placeholder="Ex.: Subir ambiente do projeto"></div></label>
      <label>O que pedir à IA<textarea id="f-prompt" rows="5" placeholder="Escreva como se fosse no chat. Pode usar skills, ex.: /vagas">${esc(r?.prompt || '')}</textarea></label>
      <label>Pasta<select id="f-cwd">${cwds.map((c) => `<option ${c === r?.cwd ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label>Modelo<select id="f-model">${MODEL_OPTIONS.map(([k, v]) => `<option value="${k}" ${k === (r?.override || 'auto') ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    </div>
    <div class="modal-actions">
      ${r ? '<button class="btn danger-btn" id="f-del">Apagar</button><span class="spacer"></span>' : ''}
      <button class="btn" data-close>Cancelar</button>
      <button class="btn primary" id="f-save">Salvar</button>
    </div>`, { wide: true });
  card.querySelector('#f-save').addEventListener('click', async () => {
    const name = card.querySelector('#f-name').value.trim();
    const prompt = card.querySelector('#f-prompt').value.trim();
    if (!name || !prompt) return toast('Preencha nome e pedido.', 'error');
    await central.saveRoutine({ id: r?.id, icon: card.querySelector('#f-icon').value.trim(), name, prompt, cwd: card.querySelector('#f-cwd').value, override: card.querySelector('#f-model').value });
    closeModal();
    renderAutomations();
  });
  card.querySelector('#f-del')?.addEventListener('click', async () => {
    await central.deleteRoutine(r.id);
    closeModal();
    renderAutomations();
  });
}

function editSchedule(s = null) {
  const actions = [
    ['briefing:daily', 'Briefing da manhã'],
    ['briefing:eod', 'Fechamento do dia'],
    ['briefing:weekly', 'Resumo da semana'],
    ['followups', 'Avisar cobranças atrasadas'],
    ['slackImport', 'Importar menções do Slack'],
    ...au.data.routines.map((r) => [`routine:${r.id}`, `Rotina: ${r.icon} ${r.name}`]),
  ];
  const cur = s ? (s.action.type === 'briefing' ? `briefing:${s.action.kind}` : s.action.type === 'routine' ? `routine:${s.action.routineId}` : s.action.type) : 'briefing:daily';
  const days = s?.days || [1, 2, 3, 4, 5];
  const card = openModal(`
    <h2>${s ? 'Editar agendamento' : 'Novo agendamento'}</h2>
    <div class="form">
      <label>Nome<input id="s-name" value="${esc(s?.name || '')}" placeholder="Ex.: Status dos repositórios toda segunda"></label>
      <label>O que fazer<select id="s-action">${actions.map(([k, v]) => `<option value="${esc(k)}" ${k === cur ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label>Dias<div class="days">${WEEKDAY_NAMES.map((n, i) => `<label class="day"><input type="checkbox" value="${i}" ${days.includes(i) ? 'checked' : ''}><span>${n}</span></label>`).join('')}</div></label>
      <label>Horários (separe por vírgula)<input id="s-times" value="${esc((s?.times || ['09:00']).join(', '))}" placeholder="09:00, 14:30"></label>
      <label class="check"><input type="checkbox" id="s-catch" ${s?.catchUp ? 'checked' : ''}> Se o PC estava desligado no horário, rodar quando a Central abrir (até 4 h depois)</label>
    </div>
    <div class="modal-actions">
      ${s ? '<button class="btn danger-btn" id="s-del">Apagar</button><span class="spacer"></span>' : ''}
      <button class="btn" data-close>Cancelar</button>
      <button class="btn primary" id="s-save">Salvar</button>
    </div>`, { wide: true });
  card.querySelector('#s-save').addEventListener('click', async () => {
    const a = card.querySelector('#s-action').value;
    const [type, arg] = a.split(':');
    const action = type === 'briefing' ? { type, kind: arg } : type === 'routine' ? { type, routineId: arg } : { type };
    const times = card.querySelector('#s-times').value.split(',').map((x) => x.trim().padStart(5, '0')).filter((x) => /^\d{2}:\d{2}$/.test(x));
    const dsel = [...card.querySelectorAll('.days input:checked')].map((x) => Number(x.value));
    if (!times.length || !dsel.length) return toast('Escolha ao menos um dia e um horário (HH:MM).', 'error');
    const name = card.querySelector('#s-name').value.trim() || actions.find(([k]) => k === a)[1];
    await central.saveSchedule({ id: s?.id, name, action, days: dsel, times, enabled: s ? s.enabled : true, catchUp: card.querySelector('#s-catch').checked });
    closeModal();
    renderAutomations();
  });
  card.querySelector('#s-del')?.addEventListener('click', async () => {
    await central.deleteSchedule(s.id);
    closeModal();
    renderAutomations();
  });
}

central.onAutomations(() => {
  if (!document.getElementById('view-auto').hidden && document.getElementById('modal').hidden) renderAutomations();
});
