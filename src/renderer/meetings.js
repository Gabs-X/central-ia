/* global central, renderMarkdown, escapeHtml, state, el, renderMessages, updateSendButton, refreshList, autosize, schedulePreview */
// Aba "Reuniões": painel de demandas + resumo de cada call.

const mt = {
  data: { meetings: [], tasks: [] },
  view: 'board', // 'board' | meetingKey
  showAllDone: false,
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
  erro: '⚠️ erro',
};

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}${y !== String(new Date().getFullYear()) ? `/${y}` : ''}`;
}

function deadlineInfo(iso) {
  if (!iso) return null;
  const today = ymd(new Date());
  const tomorrow = ymd(new Date(Date.now() + 864e5));
  if (iso < today) return { cls: 'late', text: `atrasada · ${fmtDate(iso)}` };
  if (iso === today) return { cls: 'today', text: 'hoje' };
  if (iso === tomorrow) return { cls: 'soon', text: 'amanhã' };
  return { cls: '', text: fmtDate(iso) };
}

function meetingByKey(key) {
  return mt.data.meetings.find((m) => m.key === key);
}

// ---------- Troca de aba ----------
function setView(view) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  document.getElementById('view-chat').hidden = view !== 'chat';
  document.getElementById('view-meetings').hidden = view !== 'meetings';
  document.querySelector('.side-chat').hidden = view !== 'chat';
  document.querySelector('.side-meetings').hidden = view !== 'meetings';
  if (view === 'meetings') renderMeetings();
  else el.input.focus();
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
central.onView((view) => {
  setView(view);
  if (view === 'meetings') { mt.view = 'board'; renderMeetings(); }
});

document.getElementById('open-board').addEventListener('click', () => {
  mt.view = 'board';
  renderMeetings();
});
document.getElementById('mt-scan').addEventListener('click', () => central.scanMeetings());

// ---------- Dados ----------
central.onMeetings((data) => {
  mt.data = data;
  renderBadge();
  if (!document.getElementById('view-meetings').hidden) renderMeetings();
});

function renderBadge() {
  const open = mt.data.tasks.filter((t) => t.status !== 'done').length;
  const badge = document.getElementById('tab-badge');
  badge.hidden = open === 0;
  badge.textContent = open;
}

function renderMeetings() {
  renderMeetingList();
  const status = document.getElementById('mt-status');
  const pending = mt.data.meetings.filter((m) => m.status === 'na fila' || m.status === 'processando').length;
  status.textContent = !mt.data.enabled
    ? 'monitoramento desligado'
    : pending
      ? `processando ${pending} reuni${pending > 1 ? 'ões' : 'ão'}…`
      : `monitorando ${mt.data.folder}`;
  if (mt.view === 'board' || !meetingByKey(mt.view)) renderBoard();
  else renderMeetingDetail(meetingByKey(mt.view));
}

function renderMeetingList() {
  const nav = document.getElementById('meeting-list');
  nav.innerHTML = '';
  for (const m of mt.data.meetings) {
    const open = mt.data.tasks.filter((t) => t.meetingKey === m.key && t.status !== 'done').length;
    const item = document.createElement('div');
    item.className = `chat-item meeting-item${mt.view === m.key ? ' active' : ''}${m.status === 'ignorada' ? ' dim' : ''}`;
    const st = STATUS_LABEL[m.status] ?? m.status;
    item.innerHTML = `<div class="mi-main"><span>${escapeHtml(m.title || m.code)}</span><small>${fmtDate(m.isoDate)} ${m.start ? m.start.slice(0, 5) : ''}${m.durationMin ? ` · ${m.durationMin} min` : ''}${st ? ` · ${escapeHtml(st)}` : ''}</small></div>${open ? `<b class="badge">${open}</b>` : ''}`;
    item.addEventListener('click', () => {
      mt.view = m.key;
      renderMeetings();
    });
    nav.appendChild(item);
  }
}

// ---------- Painel ----------
function renderBoard() {
  document.getElementById('mt-title').textContent = 'Painel de demandas';
  const body = document.getElementById('mt-body');
  const tasks = [...mt.data.tasks].sort(
    (a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999') || PRIO[a.priority] - PRIO[b.priority] || b.createdAt - a.createdAt,
  );
  const weekAgo = Date.now() - 7 * 864e5;

  body.innerHTML = `
    <form class="add-task" id="add-task">
      <input id="add-text" placeholder="Adicionar demanda manualmente…" autocomplete="off" />
      <input id="add-date" type="date" title="Prazo" />
      <select id="add-prio"><option value="media">média</option><option value="alta">alta</option><option value="baixa">baixa</option></select>
      <button class="btn primary">Adicionar</button>
    </form>
    <div class="board">${COLS.map((c) => {
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
    }).join('')}</div>`;

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
  bindCards(body);
}

function cardHtml(t) {
  const m = t.meetingKey ? meetingByKey(t.meetingKey) : null;
  const dl = t.status !== 'done' ? deadlineInfo(t.deadline) : null;
  const next = t.status === 'todo' ? 'doing' : t.status === 'doing' ? 'done' : 'todo';
  const nextLabel = { doing: '▶ Começar', done: '✓ Concluir', todo: '↺ Reabrir' }[next];
  return `<div class="card prio-${t.priority}${t.status === 'done' ? ' done' : ''}" draggable="true" data-id="${t.id}">
    <div class="card-text" title="Clique duas vezes para editar">${escapeHtml(t.text)}</div>
    <div class="card-meta">
      ${dl ? `<span class="due ${dl.cls}">📅 ${escapeHtml(dl.text)}</span>` : ''}
      <span class="prio">${t.priority}</span>
      ${t.requestedBy ? `<span>por ${escapeHtml(t.requestedBy)}</span>` : ''}
    </div>
    ${m ? `<button class="origin" data-meeting="${m.key}">↳ ${escapeHtml(m.title || m.code)} · ${fmtDate(m.isoDate)}</button>` : ''}
    ${t.evidence ? `<details class="evidence"><summary>trecho da call</summary>“${escapeHtml(t.evidence)}”</details>` : ''}
    <div class="card-actions">
      <button data-act="move" data-to="${next}">${nextLabel}</button>
      ${t.status !== 'done' ? '<button data-act="ai" title="Abrir uma conversa com a IA para resolver">🤖 Resolver com IA</button>' : ''}
      <button data-act="del" class="danger" title="Apagar">✕</button>
    </div>
  </div>`;
}

function bindCards(root) {
  root.querySelectorAll('.card').forEach((card) => {
    const id = card.dataset.id;
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.querySelector('[data-act=move]')?.addEventListener('click', (e) => central.updateTask(id, { status: e.target.dataset.to }));
    card.querySelector('[data-act=del]')?.addEventListener('click', () => central.deleteTask(id));
    card.querySelector('[data-act=ai]')?.addEventListener('click', () => solveWithAI(mt.data.tasks.find((t) => t.id === id)));
    card.querySelector('.origin')?.addEventListener('click', (e) => {
      mt.view = e.currentTarget.dataset.meeting;
      renderMeetings();
    });
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
  root.querySelectorAll('.col').forEach((col) => {
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

// Abre uma conversa nova já com o contexto da demanda.
async function solveWithAI(task) {
  if (!task) return;
  const m = task.meetingKey ? meetingByKey(task.meetingKey) : null;
  const ctx = [
    `Tenho esta demanda: ${task.text}`,
    task.deadline ? `Prazo: ${fmtDate(task.deadline)}.` : '',
    task.requestedBy ? `Quem pediu: ${task.requestedBy}.` : '',
    m ? `Ela surgiu na reunião "${m.title}" de ${fmtDate(m.isoDate)}. Resumo da call: ${m.summary?.resumo || ''}` : '',
    task.evidence ? `Trecho da fala: "${task.evidence}"` : '',
    '',
    'Me ajude a resolver: ',
  ].filter((x) => x !== '').join('\n');
  setView('chat');
  state.chatId = null;
  state.chat = null;
  state.live = null;
  renderMessages();
  updateSendButton();
  refreshList();
  el.input.value = ctx;
  autosize();
  schedulePreview();
  el.input.focus();
  el.input.setSelectionRange(ctx.length, ctx.length);
  if (task.status === 'todo') central.updateTask(task.id, { status: 'doing' });
}

// ---------- Detalhe da reunião ----------
function renderMeetingDetail(m) {
  document.getElementById('mt-title').textContent = m.title || m.code;
  const body = document.getElementById('mt-body');
  const s = m.summary;
  const tasks = mt.data.tasks.filter((t) => t.meetingKey === m.key);
  const list = (arr) => (arr?.length ? `<ul>${arr.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : '<p class="muted small">Nenhum.</p>');

  body.innerHTML = `<div class="detail">
    <div class="detail-head">
      <span class="tag">${fmtDate(m.isoDate)} · ${m.start ? m.start.slice(0, 5) : '?'}–${m.end ? m.end.slice(0, 5) : '?'}${m.durationMin != null ? ` · ${m.durationMin} min` : ''}</span>
      ${s?.tipo ? `<span class="tag">${escapeHtml(s.tipo)}</span>` : ''}
      ${m.model ? `<span class="tag ${m.provider}">${escapeHtml(m.model)}</span>` : ''}
      ${m.tokens ? `<span class="muted small">${Math.round(((m.tokens.input || 0) + (m.tokens.cached || 0)) / 1000)}k tokens</span>` : ''}
      <span class="spacer"></span>
      <button class="btn small-btn" id="d-files">Abrir transcript</button>
      <button class="btn small-btn" id="d-reprocess">${m.status === 'ignorada' ? 'Processar mesmo assim' : 'Reprocessar'}</button>
    </div>
    ${m.participants?.length ? `<p class="muted small">Participantes: ${escapeHtml(m.participants.join(', '))}</p>` : ''}
    ${m.status !== 'pronta' && m.status !== 'sem demandas' ? `<p class="notice">Status: ${escapeHtml(m.status)}${m.reason ? ` — ${escapeHtml(m.reason)}` : ''}</p>` : ''}
    ${s ? `
      <h2>Resumo</h2><p>${escapeHtml(s.resumo)}</p>
      <div class="grid2">
        <div><h2>Tópicos</h2>${list(s.topicos)}</div>
        <div><h2>Decisões</h2>${list(s.decisoes)}</div>
      </div>
      <h2>Ficou para você</h2>
      ${tasks.length ? `<div class="cards inline">${tasks.map(cardHtml).join('')}</div>` : '<p class="muted small">Nenhuma demanda para você nesta call.</p>'}
      <h2>Combinados com outras pessoas</h2>
      ${s.outros?.length ? `<ul>${s.outros.map((o) => `<li><b>${escapeHtml(o.responsavel)}</b>: ${escapeHtml(o.descricao)}${o.prazo ? ` <span class="muted">(até ${fmtDate(o.prazo)})</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted small">Nenhum.</p>'}
    ` : ''}
  </div>`;

  body.querySelector('#d-files').addEventListener('click', () => (m.files || []).forEach((f) => central.openPath(f)));
  body.querySelector('#d-reprocess').addEventListener('click', () => central.reprocessMeeting(m.key));
  bindCards(body);
}

// ---------- Início ----------
(async function initMeetings() {
  mt.data = await central.getMeetings();
  renderBadge();
})();
