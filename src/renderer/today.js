/* global central, esc, brDate, toast, renderMarkdown, callSafe, newChatWithPrompt, mt, nudge, solveWithAI, relTime, setView, meetingByKey */
// Tela "Hoje": o que importa agora, sem gastar token; o briefing com IA é sob demanda ou agendado.

const td = { board: null, prs: null, generating: null };

async function renderToday() {
  const body = document.getElementById('today-body');
  td.board = await central.today();
  const b = td.board;
  const d = new Date();
  document.getElementById('today-title').textContent = `Hoje · ${d.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' })}`;

  const taskLine = (t) => {
    const m = t.meetingKey ? meetingByKey(t.meetingKey) : null;
    return `<li class="t-line prio-${t.priority}">
      <span class="t-text">${esc(t.text)}</span>
      <span class="muted small">${t.deadline ? `📅 ${brDate(t.deadline)}` : ''}${t.requestedBy ? ` · ${esc(t.requestedBy)}` : ''}${m ? ` · ${esc(m.title)}` : ''}</span>
      <span class="t-actions"><button data-done="${t.id}" title="Concluir">✓</button><button data-solve="${t.id}" title="Resolver com IA">🤖</button></span>
    </li>`;
  };
  const section = (title, list, empty) => `<section class="today-card"><h3>${title} <span>${list.length}</span></h3>${list.length ? `<ul class="t-list">${list.map(taskLine).join('')}</ul>` : `<p class="muted small">${empty}</p>`}</section>`;

  const waitLine = (w) => `<li class="t-line"><span class="t-text"><b>${esc(w.person)}</b>: ${esc(w.text)}</span><span class="muted small">${w.deadline ? `📅 ${brDate(w.deadline)}` : 'sem prazo'}${w.lastNudgedAt ? ` · cobrado ${relTime(w.lastNudgedAt)}` : ''}</span><span class="t-actions"><button data-nudge="${w.id}" title="Gerar cobrança">💬</button><button data-recv="${w.id}" title="Recebi">✓</button></span></li>`;

  const upcoming = b.upcoming.map((u) => {
    const tasks = u.prep.tasks.map((id) => mt.data.tasks.find((t) => t.id === id)).filter(Boolean);
    const waits = u.prep.waiting.map((id) => mt.data.waiting.find((w) => w.id === id)).filter(Boolean);
    return `<li class="up-item">
      <div class="up-head"><b>${esc(u.time)}</b> ${esc(u.title)} <span class="tag">${u.source === 'agenda' ? 'agenda' : 'recorrente'}</span></div>
      ${u.prep.last ? `<p class="small muted">Última vez (${brDate(u.prep.last.date)}): ${esc(u.prep.last.resumo).slice(0, 260)}${u.prep.last.resumo.length > 260 ? '…' : ''}</p>` : ''}
      ${tasks.length ? `<p class="small">Suas pendências com eles: ${tasks.map((t) => esc(t.text)).join(' · ')}</p>` : ''}
      ${waits.length ? `<p class="small">Para cobrar: ${waits.map((w) => `${esc(w.person.split(' ')[0])} — ${esc(w.text)}`).join(' · ')}</p>` : ''}
    </li>`;
  }).join('');

  const brief = b.lastBriefing;
  const briefLabel = brief ? { daily: 'Briefing da manhã', weekly: 'Resumo da semana', eod: 'Fechamento do dia' }[brief.kind] : '';

  body.innerHTML = `
    <div class="today-grid">
      <div class="today-col">
        ${section('🔥 Atrasadas', b.overdue, 'Nada atrasado. 👏')}
        ${section('📌 Para hoje', b.dueToday, 'Nada com prazo para hoje.')}
        ${section('⏭️ Próximos 3 dias', b.dueSoon, 'Nada nos próximos dias.')}
        ${section('▶ Em andamento', b.doing, 'Nada em andamento.')}
      </div>
      <div class="today-col">
        <section class="today-card"><h3>📅 Próximas reuniões <span>${b.upcoming.length}</span></h3>
          ${b.upcoming.length ? `<ul class="up-list">${upcoming}</ul>` : '<p class="muted small">Nenhuma prevista. Conecte sua agenda em Ajustes para ver todas.</p>'}
        </section>
        <section class="today-card"><h3>⏳ Aguardando outros <span>${b.waitingOpen.length}</span></h3>
          ${b.waitingOpen.length ? `<ul class="t-list">${[...b.waitingOverdue, ...b.waitingOpen.filter((w) => !b.waitingOverdue.some((x) => x.id === w.id))].map(waitLine).join('')}</ul>` : '<p class="muted small">Ninguém te deve nada.</p>'}
        </section>
        <section class="today-card" id="prs-card"><h3>🔀 Pull requests</h3><p class="muted small">Carregando…</p></section>
      </div>
    </div>
    <section class="today-card brief">
      <h3>${brief ? `${briefLabel} <span>${relTime(brief.at)} · ${esc(brief.model)}</span>` : 'Briefing com IA'}</h3>
      <div id="brief-body">${td.generating ? '<p class="muted"><span class="typing"><i></i><i></i><i></i></span> Gerando…</p>' : brief ? `<div class="bubble">${renderMarkdown(brief.text)}</div><div class="modal-actions left"><button class="btn small-btn" id="brief-copy">Copiar</button><button class="btn small-btn" id="brief-speak">🔊 Ouvir</button></div>` : '<p class="muted small">Use os botões no topo, ou espere o agendamento das 8h30 (dias úteis).</p>'}</div>
    </section>`;

  body.querySelectorAll('[data-done]').forEach((x) => x.addEventListener('click', async () => { await central.updateTask(x.dataset.done, { status: 'done' }); renderToday(); }));
  body.querySelectorAll('[data-solve]').forEach((x) => x.addEventListener('click', () => solveWithAI(mt.data.tasks.find((t) => t.id === x.dataset.solve))));
  body.querySelectorAll('[data-nudge]').forEach((x) => x.addEventListener('click', () => nudge(x.dataset.nudge)));
  body.querySelectorAll('[data-recv]').forEach((x) => x.addEventListener('click', async () => { await central.updateWaiting(x.dataset.recv, { status: 'done' }); renderToday(); }));
  body.querySelector('#brief-copy')?.addEventListener('click', () => { central.copy(brief.text); toast('Briefing copiado.'); });
  body.querySelector('#brief-speak')?.addEventListener('click', () => central.speak(brief.text));

  // Badge da aba: atrasadas + para hoje
  const n = b.overdue.length + b.dueToday.length;
  const badge = document.getElementById('badge-today');
  badge.hidden = !n;
  badge.textContent = n;

  loadPrs();
}

async function loadPrs(force = false) {
  const cardEl = document.getElementById('prs-card');
  if (!cardEl) return;
  const r = await central.githubPrs(force);
  if (!r.ok) {
    cardEl.innerHTML = `<h3>🔀 Pull requests</h3><p class="error small">${esc(r.error)}</p>`;
    return;
  }
  const { review, mine, errors, disabled } = r.data;
  const line = (p) => `<li class="t-line"><span class="t-text"><a href="${esc(p.url)}" target="_blank">${esc(p.repo)}#${p.number}</a> ${esc(p.title)}${p.draft ? ' <span class="tag">rascunho</span>' : ''}</span><span class="muted small">${esc(p.author || '')} · ${relTime(new Date(p.updatedAt).getTime())}</span><span class="t-actions"><button data-review="${esc(p.url)}" title="Revisar com IA">🤖</button></span></li>`;
  cardEl.innerHTML = `<h3>🔀 Pull requests <span>${review.length} para revisar · ${mine.length} suas</span> <button class="link" id="prs-refresh">atualizar</button></h3>
    ${disabled ? '<p class="muted small">Integração com GitHub desligada.</p>' : ''}
    ${review.length ? `<p class="small muted">Esperando seu review</p><ul class="t-list">${review.map(line).join('')}</ul>` : '<p class="muted small">Nenhuma PR esperando seu review.</p>'}
    ${mine.length ? `<p class="small muted">Suas PRs abertas</p><ul class="t-list">${mine.map(line).join('')}</ul>` : ''}
    ${errors.length ? `<p class="error small">${errors.map(esc).join('<br>')}</p>` : ''}`;
  cardEl.querySelector('#prs-refresh').addEventListener('click', () => loadPrs(true));
  cardEl.querySelectorAll('[data-review]').forEach((b) =>
    b.addEventListener('click', () =>
      newChatWithPrompt(`Revise a PR ${b.dataset.review}: use \`gh pr view\` e \`gh pr diff\`. Aponte bugs, riscos e sugestões. Não comente nem aprove no GitHub sem eu pedir.`, { override: 'claude:equilibrado' }),
    ),
  );
}

document.querySelectorAll('[data-brief]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    if (td.generating) return;
    td.generating = btn.dataset.brief;
    renderToday();
    const r = await central.makeBriefing(btn.dataset.brief);
    td.generating = null;
    if (!r.ok) toast(r.error, 'error');
    renderToday();
  }),
);

central.onBriefing(() => {
  if (!document.getElementById('view-today').hidden) renderToday();
});
central.onMeetings(() => {
  if (!document.getElementById('view-today').hidden && !td.generating) renderToday();
});
