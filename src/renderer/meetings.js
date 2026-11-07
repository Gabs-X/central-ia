/* global central, esc, brDate, ymdLocal, toast, openModal, closeModal, callSafe, renderMarkdown, newChatWithPrompt */
// Tela "Reuniões": painel de demandas, aguardando outros, busca, pessoas e resumo de cada call.

const mt = {
  data: { meetings: [], tasks: [], waiting: [] },
  view: 'board', // 'board' | 'people' | 'person:<key>' | 'search' | <meetingKey>
  showAllDone: false,
  showAllWaiting: false,
  search: null, // { q, loading, result }
  people: [],
};

const COLS = [
  { id: 'todo', label: 'A fazer' },
  { id: 'doing', label: 'Em andamento' },
  { id: 'done', label: 'Feito' },
];
const PRIO = { alta: 0, media: 1, baixa: 2 };
const STATUS_LABEL = {
  'na fila': '⏳ na fila',
  processando: '⚙️ processando',
  pronta: '',
  'sem demandas': 'informal',
  ignorada: 'ignorada',
  adiada: '⏸ adiada (cota)',
  erro: '⚠️ erro',
};

function deadlineInfo(iso) {
  if (!iso) return null;
  const today = ymdLocal();
  const tomorrow = ymdLocal(new Date(Date.now() + 864e5));
  if (iso < today) return { cls: 'late', text: `atrasada · ${brDate(iso)}` };
  if (iso === today) return { cls: 'today', text: 'hoje' };
  if (iso === tomorrow) return { cls: 'soon', text: 'amanhã' };
  return { cls: '', text: brDate(iso) };
}

const meetingByKey = (key) => mt.data.meetings.find((m) => m.key === key);
const openTasks = () => mt.data.tasks.filter((t) => t.status !== 'done');

// ---------- Dados ----------
central.onMeetings((data) => {
  mt.data = data;
  renderMeetingBadge();
  if (!document.getElementById('view-meetings').hidden) renderMeetings();
});

function renderMeetingBadge() {
  const open = openTasks().length;
  const badge = document.getElementById('tab-badge');
  badge.hidden = open === 0;
  badge.textContent = open;
}

function setSeg(which) {
  document.getElementById('open-board').classList.toggle('active', which === 'board');
  document.getElementById('open-people').classList.toggle('active', which === 'people');
}

document.getElementById('open-board').addEventListener('click', () => {
  mt.view = 'board';
  renderMeetings();
});
document.getElementById('open-people').addEventListener('click', async () => {
  mt.view = 'people';
  renderMeetings();
});
document.getElementById('mt-scan').addEventListener('click', () => {
  central.scanMeetings();
  toast('Procurando transcripts novos…');
});

document.getElementById('mt-search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = document.getElementById('mt-q').value.trim();
  if (!q) return;
  mt.view = 'search';
  mt.search = { q, loading: true };
  renderMeetings();
  const r = await central.search(q);
  mt.search = { q, loading: false, result: r.ok ? r.data : null, error: r.ok ? null : r.error };
  if (mt.view === 'search') renderMeetings();
});

async function renderMeetings() {
  renderMeetingList();
  const status = document.getElementById('mt-status');
  const pending = mt.data.meetings.filter((m) => m.status === 'na fila' || m.status === 'processando').length;
  status.textContent = !mt.data.enabled
    ? 'monitoramento desligado'
    : pending
      ? `processando ${pending} reuni${pending > 1 ? 'ões' : 'ão'}…`
      : `monitorando ${mt.data.folder}`;

  const v = mt.view;
  setSeg(v === 'people' || v.startsWith('person:') ? 'people' : v === 'board' ? 'board' : '');
  if (v === 'board') return renderBoard();
  if (v === 'search') return renderSearch();
  if (v === 'people') {
    mt.people = await central.people();
    return renderPeople();
  }
  if (v.startsWith('person:')) {
    mt.people = await central.people();
    return renderPerson(v.slice(7));
  }
  const m = meetingByKey(v);
  if (m) return renderMeetingDetail(m);
  mt.view = 'board';
  renderBoard();
}

function renderMeetingList() {
  const nav = document.getElementById('meeting-list');
  nav.innerHTML = '';
  for (const m of mt.data.meetings) {
    const open = mt.data.tasks.filter((t) => t.meetingKey === m.key && t.status !== 'done').length;
    const item = document.createElement('div');
    item.className = `chat-item meeting-item${mt.view === m.key ? ' active' : ''}${m.status === 'ignorada' ? ' dim' : ''}`;
    const st = STATUS_LABEL[m.status] ?? m.status;
    item.innerHTML = `<div class="mi-main"><span>${esc(m.title || m.code)}</span><small>${brDate(m.isoDate)} ${m.start ? m.start.slice(0, 5) : ''}${m.durationMin ? ` · ${m.durationMin} min` : ''}${st ? ` · ${esc(st)}` : ''}</small></div>${open ? `<b class="badge">${open}</b>` : ''}`;
    item.addEventListener('click', () => {
      mt.view = m.key;
      renderMeetings();
    });
    nav.appendChild(item);
  }
}

// ---------- Painel ----------
function sortTasks(list) {
  return [...list].sort(
    (a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || PRIO[a.priority] - PRIO[b.priority] || b.createdAt - a.createdAt,
  );
}

function renderBoard() {
  document.getElementById('mt-title').textContent = 'Painel de demandas';
  const body = document.getElementById('mt-body');
  const tasks = sortTasks(mt.data.tasks);
  const weekAgo = Date.now() - 7 * 864e5;
  const waitingAll = mt.data.waiting.filter((w) => w.status === 'open');
  const waitingMine = waitingAll.filter((w) => w.forMe !== false);
  const waitingShown = mt.showAllWaiting ? waitingAll : waitingMine;
  waitingShown.sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));

  body.innerHTML = `
    <form class="add-task" id="add-task">
      <input id="add-text" placeholder="Adicionar demanda manualmente…" autocomplete="off" />
      <input id="add-date" type="date" title="Prazo" />
      <select id="add-prio"><option value="media">média</option><option value="alta">alta</option><option value="baixa">baixa</option></select>
      <button class="btn primary">Adicionar</button>
    </form>
    <div class="board four">${COLS.map((c) => {
      let list = tasks.filter((t) => t.status === c.id);
      let hidden = 0;
      if (c.id === 'done' && !mt.showAllDone) {
        const recent = list.filter((t) => (t.doneAt || t.updatedAt) >= weekAgo);
        hidden = list.length - recent.length;
        list = recent;
      }
      return `<div class="col" data-col="${c.id}">
        <h3>${c.label} <span>${list.length}</span></h3>
        <div class="cards">${list.map(cardHtml).join('') || '<p class="muted small empty-col">Nada aqui.</p>'}</div>
        ${hidden ? `<button class="link" id="show-done">mostrar ${hidden} mais antigas</button>` : ''}
      </div>`;
    }).join('')}
      <div class="col waiting-col">
        <h3>Aguardando outros <span>${waitingShown.length}</span></h3>
        <div class="cards">${waitingShown.map(waitingHtml).join('') || '<p class="muted small empty-col">Ninguém te deve nada.</p>'}</div>
        <button class="link" id="toggle-waiting">${mt.showAllWaiting ? 'mostrar só o que depende de você' : `ver todos os combinados (${waitingAll.length})`}</button>
      </div>
    </div>`;

  if (!tasks.length) {
    const processed = mt.data.meetings.filter((m) => m.status === 'pronta' || m.status === 'sem demandas').length;
    body.querySelector('.board').insertAdjacentHTML(
      'beforebegin',
      `<p class="muted hint">${processed ? 'Nenhuma demanda para você nas reuniões analisadas até agora.' : 'Quando o bot salvar um transcript, a reunião é resumida e as demandas aparecem aqui.'}</p>`,
    );
  }

  body.querySelector('#add-task').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = body.querySelector('#add-text').value.trim();
    if (!text) return;
    await central.addTask({ text, deadline: body.querySelector('#add-date').value || null, priority: body.querySelector('#add-prio').value });
  });
  body.querySelector('#show-done')?.addEventListener('click', () => { mt.showAllDone = true; renderBoard(); });
  body.querySelector('#toggle-waiting').addEventListener('click', () => { mt.showAllWaiting = !mt.showAllWaiting; renderBoard(); });
  bindCards(body);
}

function cardHtml(t) {
  const m = t.meetingKey ? meetingByKey(t.meetingKey) : null;
  const dl = t.status !== 'done' ? deadlineInfo(t.deadline) : null;
  const next = t.status === 'todo' ? 'doing' : t.status === 'doing' ? 'done' : 'todo';
  const nextLabel = { doing: '▶ Começar', done: '✓ Concluir', todo: '↺ Reabrir' }[next];
  const origin = m
    ? `<button class="origin" data-meeting="${m.key}">↳ ${esc(m.title || m.code)} · ${brDate(m.isoDate)}</button>`
    : t.source === 'slack' && t.link
      ? `<button class="origin" data-link="${esc(t.link)}">↳ Slack</button>`
      : '';
  return `<div class="card prio-${t.priority}${t.status === 'done' ? ' done' : ''}" draggable="true" data-id="${t.id}">
    <div class="card-text" title="Clique duas vezes para editar">${esc(t.text)}</div>
    <div class="card-meta">
      ${dl ? `<span class="due ${dl.cls}">📅 ${esc(dl.text)}</span>` : ''}
      <span class="prio">${t.priority}</span>
      ${t.requestedBy ? `<span>por ${esc(t.requestedBy)}</span>` : ''}
    </div>
    ${origin}
    ${t.evidence ? `<details class="evidence"><summary>trecho</summary>“${esc(t.evidence)}”</details>` : ''}
    <div class="card-actions">
      <button data-act="move" data-to="${next}">${nextLabel}</button>
      ${t.status !== 'done' ? '<button data-act="ai" title="Abrir uma conversa com a IA para resolver">🤖 Resolver</button>' : ''}
      <button data-act="del" class="danger" title="Apagar">✕</button>
    </div>
  </div>`;
}

function waitingHtml(w) {
  const m = w.meetingKey ? meetingByKey(w.meetingKey) : null;
  const dl = deadlineInfo(w.deadline);
  return `<div class="card waiting${w.forMe === false ? ' dim' : ''}" data-wid="${w.id}">
    <div class="card-text"><b>${esc(w.person)}</b>: ${esc(w.text)}</div>
    <div class="card-meta">${dl ? `<span class="due ${dl.cls}">📅 ${esc(dl.text)}</span>` : '<span>sem prazo</span>'}${w.lastNudgedAt ? `<span>cobrado ${relTime(w.lastNudgedAt)}</span>` : ''}</div>
    ${m ? `<button class="origin" data-meeting="${m.key}">↳ ${esc(m.title || m.code)} · ${brDate(m.isoDate)}</button>` : ''}
    <div class="card-actions">
      <button data-wact="nudge">💬 Cobrar</button>
      <button data-wact="done">✓ Recebi</button>
      <button data-wact="del" class="danger" title="Apagar">✕</button>
    </div>
  </div>`;
}

function bindCards(root) {
  root.querySelectorAll('.card[data-id]').forEach((card) => {
    const id = card.dataset.id;
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.querySelector('[data-act=move]')?.addEventListener('click', (e) => central.updateTask(id, { status: e.target.dataset.to }));
    card.querySelector('[data-act=del]')?.addEventListener('click', () => central.deleteTask(id));
    card.querySelector('[data-act=ai]')?.addEventListener('click', () => solveWithAI(mt.data.tasks.find((t) => t.id === id)));
    const txt = card.querySelector('.card-text');
    txt.addEventListener('dblclick', () => {
      txt.contentEditable = 'true';
      txt.focus();
      document.getSelection().selectAllChildren(txt);
    });
    txt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); txt.blur(); }
      if (e.key === 'Escape') { txt.textContent = mt.data.tasks.find((t) => t.id === id)?.text || ''; txt.blur(); }
    });
    txt.addEventListener('blur', () => {
      if (txt.contentEditable !== 'true') return;
      txt.contentEditable = 'false';
      const text = txt.textContent.trim();
      const t = mt.data.tasks.find((x) => x.id === id);
      if (text && t && text !== t.text) central.updateTask(id, { text });
    });
  });
  root.querySelectorAll('.card[data-wid]').forEach((card) => {
    const id = card.dataset.wid;
    card.querySelector('[data-wact=nudge]').addEventListener('click', () => nudge(id));
    card.querySelector('[data-wact=done]').addEventListener('click', () => central.updateWaiting(id, { status: 'done' }));
    card.querySelector('[data-wact=del]').addEventListener('click', () => central.deleteWaiting(id));
  });
  root.querySelectorAll('.origin').forEach((b) =>
    b.addEventListener('click', (e) => {
      const { meeting, link } = e.currentTarget.dataset;
      if (link) return central.openExternal(link);
      mt.view = meeting;
      if (typeof setView === 'function') setView('meetings');
      renderMeetings();
    }),
  );
  root.querySelectorAll('.col[data-col]').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', () => col.classList.remove('over'));
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('over');
      const id = e.dataTransfer.getData('text/plain');
      if (id) central.updateTask(id, { status: col.dataset.col });
    });
  });
}

// Gera a mensagem de cobrança e oferece copiar ou mandar no Slack.
async function nudge(waitingId) {
  const w = mt.data.waiting.find((x) => x.id === waitingId);
  if (!w) return;
  const card = openModal(`<h2>Cobrar ${esc(w.person)}</h2><p class="muted small">${esc(w.text)}</p><div class="nudge-text"><span class="typing"><i></i><i></i><i></i></span></div>`);
  const r = await central.nudge(waitingId);
  if (!r.ok) {
    card.querySelector('.nudge-text').innerHTML = `<p class="error">⚠️ ${esc(r.error)}</p>`;
    return;
  }
  const slack = await central.slackStatus();
  card.innerHTML = `<h2>Cobrar ${esc(w.person)}</h2>
    <p class="muted small">${esc(w.text)}</p>
    <textarea id="nudge-msg" rows="5">${esc(r.data.text)}</textarea>
    <div class="modal-actions">
      <button class="btn" data-close>Cancelar</button>
      <button class="btn" id="nudge-copy">Copiar</button>
      ${slack.ok ? '<button class="btn primary" id="nudge-slack">Enviar no Slack</button>' : '<span class="muted small">Configure o Slack em Ajustes para enviar direto.</span>'}
    </div>`;
  card.querySelector('[data-close]').addEventListener('click', closeModal);
  const msg = () => card.querySelector('#nudge-msg').value.trim();
  card.querySelector('#nudge-copy').addEventListener('click', async () => {
    await central.copy(msg());
    await central.updateWaiting(waitingId, { lastNudgedAt: Date.now() });
    closeModal();
    toast('Mensagem copiada.');
  });
  card.querySelector('#nudge-slack')?.addEventListener('click', async () => {
    const res = await central.slackSend(w.person, msg());
    if (!res.ok) return toast(res.error, 'error');
    await central.updateWaiting(waitingId, { lastNudgedAt: Date.now() });
    closeModal();
    toast(`Enviado para ${res.data.name} no Slack.`);
  });
}

// Abre uma conversa já com o contexto da demanda, na pasta do repositório certo quando der.
async function solveWithAI(task) {
  if (!task) return;
  const m = task.meetingKey ? meetingByKey(task.meetingKey) : null;
  const hint = await central.suggestRepo(task.id);
  const ctx = [
    `Tenho esta demanda: ${task.text}`,
    task.deadline ? `Prazo: ${brDate(task.deadline)}.` : '',
    task.requestedBy ? `Quem pediu: ${task.requestedBy}.` : '',
    m ? `Ela surgiu na reunião "${m.title}" de ${brDate(m.isoDate)}. Resumo da call: ${m.summary?.resumo || ''}` : '',
    task.evidence ? `Trecho da fala: "${task.evidence}"` : '',
    hint?.pr ? `Ela envolve a PR ${hint.pr}: comece com \`gh pr view ${hint.pr}\` e \`gh pr diff ${hint.pr}\` no repositório certo.` : '',
    hint?.wt ? `Referência de work item: WT ${hint.wt}.` : '',
    '',
    'Me ajude a resolver: ',
  ].filter((x) => x !== '').join('\n');
  await newChatWithPrompt(ctx, { cwd: hint?.cwd || undefined });
  if (hint?.cwd) toast(`Pasta escolhida: ${hint.cwd}`);
  if (task.status === 'todo') central.updateTask(task.id, { status: 'doing' });
}

// ---------- Busca ----------
function renderSearch() {
  document.getElementById('mt-title').textContent = 'Busca nas reuniões';
  const body = document.getElementById('mt-body');
  const s = mt.search;
  if (!s) return renderBoard();
  if (s.loading) {
    body.innerHTML = `<div class="detail"><h2>“${esc(s.q)}”</h2><p class="muted"><span class="typing"><i></i><i></i><i></i></span> Procurando nas transcrições…</p></div>`;
    return;
  }
  if (s.error) {
    body.innerHTML = `<div class="detail"><h2>“${esc(s.q)}”</h2><p class="error">⚠️ ${esc(s.error)}</p></div>`;
    return;
  }
  const r = s.result;
  body.innerHTML = `<div class="detail">
    <h2>“${esc(s.q)}”</h2>
    <div class="bubble answer">${renderMarkdown(r.answer)}</div>
    ${r.sources.length ? `<h2>Fontes</h2><ul class="sources">${r.sources.map((f) => `<li><button class="origin" data-meeting="${esc(f.exists ? f.reuniao : '')}">${esc(f.title)}${f.date ? ` · ${brDate(f.date)}` : ''}${f.horario ? ` · ${esc(f.horario)}` : ''}</button><div class="muted small">“${esc(f.trecho)}”</div></li>`).join('')}</ul>` : ''}
    <p class="muted small">${r.scanned} reuniões consultadas · ${r.excerpts} trechos enviados · ${esc(r.model)}</p>
  </div>`;
  body.querySelectorAll('.origin').forEach((b) =>
    b.addEventListener('click', () => {
      if (!b.dataset.meeting) return;
      mt.view = b.dataset.meeting;
      renderMeetings();
    }),
  );
}

// ---------- Pessoas ----------
function renderPeople() {
  document.getElementById('mt-title').textContent = 'Pessoas';
  const body = document.getElementById('mt-body');
  body.innerHTML = `<div class="people-grid">${mt.people.map((p) => `
    <button class="person" data-key="${esc(p.key)}">
      <span class="avatar">${esc(p.name.split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase())}</span>
      <span class="p-main"><b>${esc(p.name)}</b><small>${p.meetingCount} reuni${p.meetingCount === 1 ? 'ão' : 'ões'}${p.lastMeeting ? ` · última ${brDate(p.lastMeeting.date)}` : ''}</small></span>
      <span class="p-stats">${p.openTasks.length ? `<span title="pedidos dela(e) para você em aberto">📥 ${p.openTasks.length}</span>` : ''}${p.openWaiting.length ? `<span title="te deve">⏳ ${p.openWaiting.length}</span>` : ''}</span>
    </button>`).join('') || '<p class="muted">Ainda não há pessoas: elas aparecem conforme as reuniões são processadas.</p>'}</div>`;
  body.querySelectorAll('.person').forEach((b) => b.addEventListener('click', () => {
    mt.view = `person:${b.dataset.key}`;
    renderMeetings();
  }));
}

function renderPerson(key) {
  const p = mt.people.find((x) => x.key === key);
  if (!p) return renderPeople();
  document.getElementById('mt-title').textContent = p.name;
  const body = document.getElementById('mt-body');
  const tasks = sortTasks(mt.data.tasks.filter((t) => p.allTasks.includes(t.id)));
  const waiting = mt.data.waiting.filter((w) => p.allWaiting.includes(w.id) && w.status === 'open');
  body.innerHTML = `<div class="detail">
    <button class="link" id="back-people">← Pessoas</button>
    <h2>Pediu para você</h2>
    ${tasks.length ? `<div class="cards inline">${tasks.map(cardHtml).join('')}</div>` : '<p class="muted small">Nada.</p>'}
    <h2>Combinados em aberto</h2>
    ${waiting.length ? `<div class="cards inline">${waiting.map(waitingHtml).join('')}</div>` : '<p class="muted small">Nada pendente.</p>'}
    <h2>Últimas reuniões juntos</h2>
    ${p.recent.map((m) => `<div class="recent-meeting"><button class="origin" data-meeting="${esc(m.key)}">${esc(m.title)} · ${brDate(m.date)}</button><p class="small">${esc(m.resumo)}</p></div>`).join('') || '<p class="muted small">Nenhuma.</p>'}
  </div>`;
  body.querySelector('#back-people').addEventListener('click', () => { mt.view = 'people'; renderMeetings(); });
  bindCards(body);
}

// ---------- Detalhe da reunião ----------
function renderMeetingDetail(m) {
  document.getElementById('mt-title').textContent = m.title || m.code;
  const body = document.getElementById('mt-body');
  const s = m.summary;
  const tasks = mt.data.tasks.filter((t) => t.meetingKey === m.key);
  const waiting = mt.data.waiting.filter((w) => w.meetingKey === m.key);
  const list = (arr) => (arr?.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="muted small">Nenhum.</p>');

  body.innerHTML = `<div class="detail">
    <div class="detail-head">
      <span class="tag">${brDate(m.isoDate)} · ${m.start ? m.start.slice(0, 5) : '?'}–${m.end ? m.end.slice(0, 5) : '?'}${m.durationMin != null ? ` · ${m.durationMin} min` : ''}</span>
      ${s?.tipo ? `<span class="tag">${esc(s.tipo)}</span>` : ''}
      ${m.model ? `<span class="tag ${m.provider}">${esc(m.model)}</span>` : ''}
      ${m.tokens ? `<span class="muted small">${Math.round(((m.tokens.input || 0) + (m.tokens.cached || 0)) / 1000)}k tokens</span>` : ''}
      <span class="spacer"></span>
      ${s ? `<button class="btn small-btn" id="d-copy" title="Copiar resumo em Markdown">Copiar</button>
      <button class="btn small-btn" id="d-save" title="Salvar .md na sua pasta do Claude">Salvar .md</button>
      <button class="btn small-btn" id="d-mail" title="Abrir e-mail com o resumo">E-mail</button>` : ''}
      <button class="btn small-btn" id="d-files">Transcript</button>
      <button class="btn small-btn" id="d-reprocess">${m.status === 'ignorada' ? 'Processar mesmo assim' : 'Reprocessar'}</button>
    </div>
    ${m.participants?.length ? `<p class="muted small">Participantes: ${esc(m.participants.join(', '))}</p>` : ''}
    ${m.status !== 'pronta' && m.status !== 'sem demandas' ? `<p class="notice">Status: ${esc(m.status)}${m.reason ? ` — ${esc(m.reason)}` : ''}${m.retryAt ? ` · nova tentativa ${new Date(m.retryAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : ''}</p>` : ''}
    ${s ? `
      <h2>Resumo</h2><p>${esc(s.resumo)}</p>
      <div class="grid2">
        <div><h2>Tópicos</h2>${list(s.topicos)}</div>
        <div><h2>Decisões</h2>${list(s.decisoes)}</div>
      </div>
      <h2>Ficou para você</h2>
      ${tasks.length ? `<div class="cards inline">${tasks.map(cardHtml).join('')}</div>` : '<p class="muted small">Nenhuma demanda para você nesta call.</p>'}
      <h2>Combinados com outras pessoas</h2>
      ${waiting.length ? `<div class="cards inline">${waiting.map(waitingHtml).join('')}</div>` : '<p class="muted small">Nenhum.</p>'}
    ` : ''}
  </div>`;

  body.querySelector('#d-files').addEventListener('click', () => (m.files || []).forEach((f) => central.openPath(f)));
  body.querySelector('#d-reprocess').addEventListener('click', () => central.reprocessMeeting(m.key));
  body.querySelector('#d-copy')?.addEventListener('click', async () => {
    await central.copy(await central.meetingMarkdown(m.key));
    toast('Resumo copiado em Markdown.');
  });
  body.querySelector('#d-save')?.addEventListener('click', async () => {
    const file = await callSafe(central.saveMeetingMarkdown(m.key));
    if (file) {
      toast(`Salvo em ${file}`);
      central.openPath(file);
    }
  });
  body.querySelector('#d-mail')?.addEventListener('click', () => central.mailMeeting(m.key));
  bindCards(body);
}

// ---------- Início ----------
(async function initMeetings() {
  mt.data = await central.getMeetings();
  renderMeetingBadge();
})();
