/* global central, renderMarkdown */
const $ = (sel) => document.querySelector(sel);

const state = {
  chatId: null,
  chat: null,
  attachments: [], // { path, preview }
  running: new Map(), // chatId -> Set(runId): agentes rodando em cada conversa
  config: null,
  lives: new Map(), // runId -> { chatId, wrap, msg }: respostas em andamento nesta janela
};

const isBusy = (chatId) => (state.running.get(chatId)?.size || 0) > 0;
function markRunning(chatId, runId, on) {
  if (!state.running.has(chatId)) state.running.set(chatId, new Set());
  const set = state.running.get(chatId);
  if (on) set.add(runId);
  else set.delete(runId);
  if (!set.size) state.running.delete(chatId);
}

// Ao reabrir uma conversa, religa as respostas em andamento aos novos elementos da tela.
function relinkLives() {
  for (const [runId, live] of state.lives) {
    if (live.chatId !== state.chatId) continue;
    const wrap = el.messages.querySelector(`.msg[data-id="${runId}"]`);
    if (!wrap) continue;
    live.wrap = wrap;
    fillAssistant(wrap, live.msg, { live: true });
  }
}

const el = {
  list: $('#chat-list'),
  messages: $('#messages'),
  empty: $('#empty'),
  input: $('#input'),
  send: $('#send'),
  title: $('#chat-title'),
  cwd: $('#cwd-select'),
  model: $('#model-select'),
  badge: $('#route-badge'),
  attachments: $('#attachments'),
  fullAccess: $('#full-access'),
  speak: $('#speak-replies'),
};

// encodeURI: nomes com espaço, # ou ? não quebram a URL da imagem.
const fileUrl = (p) => `file:///${encodeURI(p.replace(/\\/g, '/').replace(/^\/+/, ''))}`;
const fmtNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0));

function providerTag(msg) {
  const name = msg.provider === 'codex' ? 'Codex' : msg.provider === 'local' ? 'Ohara' : 'Claude';
  return `<span class="tag ${msg.provider}">${name} · ${escapeHtml(msg.model || '')}</span>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------- Conversas ----------
async function refreshList() {
  const chats = await central.listChats();
  el.list.innerHTML = '';
  for (const c of chats) {
    const item = document.createElement('div');
    item.className = `chat-item${c.id === state.chatId ? ' active' : ''}`;
    item.innerHTML = `<span title="${escapeHtml(c.cwd)}">${isBusy(c.id) ? `⏳${state.running.get(c.id).size > 1 ? state.running.get(c.id).size : ''} ` : ''}${escapeHtml(c.title)}</span><button class="del" title="Apagar">✕</button>`;
    item.addEventListener('click', () => openChat(c.id));
    item.querySelector('.del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await central.deleteChat(c.id);
      if (c.id === state.chatId) { state.chatId = null; state.chat = null; renderMessages(); }
      refreshList();
    });
    el.list.appendChild(item);
  }
}

async function openChat(id) {
  state.chatId = id;
  state.chat = await central.getChat(id);
  renderMessages();
  relinkLives();
  syncCwdSelect();
  refreshList();
  updateSendButton();
  el.input.focus();
}

async function ensureChat() {
  if (state.chatId) return state.chat;
  const chat = await central.createChat(el.cwd.value || state.config.defaultCwd);
  state.chatId = chat.id;
  state.chat = chat;
  refreshList();
  return chat;
}

// ---------- Mensagens ----------
function renderMessages() {
  el.messages.querySelectorAll('.msg').forEach((n) => n.remove());
  const msgs = state.chat?.messages || [];
  el.empty.hidden = msgs.length > 0;
  el.title.textContent = state.chat?.title || 'Nova conversa';
  for (const m of msgs) appendMessage(m);
  scrollBottom(true);
}

function appendMessage(m) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${m.role}`;
  if (m.id) wrap.dataset.id = m.id;
  if (m.role === 'user') {
    const imgs = (m.images || []).map((p) => `<img src="${fileUrl(p)}" alt="">`).join('');
    wrap.innerHTML = `${imgs ? `<div class="imgs">${imgs}</div>` : ''}<div class="bubble"></div>`;
    wrap.querySelector('.bubble').textContent = m.text;
  } else {
    wrap.innerHTML = `<div class="meta"></div><div class="tools"></div><div class="bubble"></div>`;
    fillAssistant(wrap, m);
  }
  el.messages.appendChild(wrap);
  return wrap;
}

function fillAssistant(wrap, m, { live = false } = {}) {
  const meta = wrap.querySelector('.meta');
  const reasons = (m.route?.reasons || []).join(' · ');
  const tokens = m.tokens ? `${fmtNum((m.tokens.input || 0) + (m.tokens.cached || 0))} in · ${fmtNum(m.tokens.output)} out` : '';
  const wa = m.whatsapp
    ? m.whatsapp.sent
      ? '<span title="Enviado para o seu WhatsApp">📱 enviado</span>'
      : `<span class="bad" title="${escapeHtml(m.whatsapp.error || '')}">📱 não enviado</span>`
    : '';
  const par = m.parallel ? '<span class="tag parallel" title="Rodou ao mesmo tempo que outra tarefa desta conversa">⫽ paralelo</span>' : '';
  meta.innerHTML = `${providerTag(m)}${par}<span title="${escapeHtml(reasons)}">${escapeHtml(m.route?.label || '')}</span>${tokens ? `<span>${tokens}</span>` : ''}${wa}${
    live ? '' : '<button class="act" data-a="copy" title="Copiar">⧉</button><button class="act" data-a="speak" title="Ler em voz alta">🔊</button><button class="act" data-a="whatsapp" title="Enviar para o meu WhatsApp">📱</button>'
  }`;
  meta.querySelector('[data-a=copy]')?.addEventListener('click', () => navigator.clipboard.writeText(m.text || ''));
  meta.querySelector('[data-a=speak]')?.addEventListener('click', () => central.speak(m.text || ''));
  meta.querySelector('[data-a=whatsapp]')?.addEventListener('click', async () => {
    const r = await callSafe(central.whatsappSend(m.text || ''), 'WhatsApp: ');
    if (r != null) toast('Enviado para o seu WhatsApp.');
  });

  const tools = wrap.querySelector('.tools');
  const list = m.tools || [];
  if (list.length > 6 && !live) {
    tools.innerHTML = `<details><summary>${list.length} ações executadas</summary>${list.map((t) => `<div>${escapeHtml(t)}</div>`).join('')}</details>`;
  } else {
    tools.innerHTML = list.map((t) => `<div>${escapeHtml(t)}</div>`).join('');
  }

  const bubble = wrap.querySelector('.bubble');
  bubble.classList.toggle('error', !!m.error && !m.text);
  if (live && !m.text) {
    bubble.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  } else {
    bubble.innerHTML = renderMarkdown(m.text || (m.error ? `⚠️ ${m.error}` : ''));
    if (m.error && m.text) bubble.insertAdjacentHTML('beforeend', `<p class="error">⚠️ ${escapeHtml(m.error)}</p>`);
    bubble.querySelectorAll('pre .copy').forEach((b) =>
      b.addEventListener('click', () => {
        navigator.clipboard.writeText(b.nextElementSibling.textContent);
        b.textContent = 'copiado';
        setTimeout(() => (b.textContent = 'copiar'), 1200);
      }),
    );
  }
  if (!live) renderDrafts(wrap, m);
  if (!live) renderImprovementOffer(wrap, m);
}

// Ela se ofereceu para se alterar: um clique aceita (o mesmo que responder "sim").
function renderImprovementOffer(wrap, m) {
  wrap.querySelector('.improve-offer')?.remove();
  const last = state.chat?.messages?.[state.chat.messages.length - 1];
  if (!m.improvementOffer || (last && last.id && last.id !== m.id)) return;
  const box = document.createElement('div');
  box.className = 'improve-offer';
  box.innerHTML = `<span>✨ Posso me alterar para: <b>${escapeHtml(m.improvementOffer)}</b></span><button class="btn small-btn primary">Sim, pode se alterar</button>`;
  box.querySelector('button').addEventListener('click', () => {
    box.remove();
    el.input.value = 'Sim, pode se alterar.';
    sendMessage();
  });
  wrap.appendChild(box);
}

// Mensagem para contato: só sai depois do clique em "Enviar".
function renderDrafts(wrap, m) {
  wrap.querySelector('.wa-drafts')?.remove();
  if (!m.whatsappDrafts?.length) return;
  const box = document.createElement('div');
  box.className = 'wa-drafts';
  const label = { pending: 'aguardando sua confirmação', sending: 'enviando…', sent: 'enviada', cancelled: 'cancelada', error: 'não enviada' };
  box.innerHTML = m.whatsappDrafts
    .map((d, i) => `<div class="wa-draft ${d.status}">
      <div class="wa-head">📱 WhatsApp para <b>${escapeHtml(d.sentTo || d.to)}</b> <span class="muted small">· ${label[d.status] || d.status}</span></div>
      <div class="wa-text">${escapeHtml(d.text)}</div>
      ${d.error ? `<p class="error small">⚠️ ${escapeHtml(d.error)}</p>` : ''}
      ${d.status === 'pending' || d.status === 'error' ? `<div class="row"><button class="btn small-btn primary" data-wa="send" data-i="${i}">${d.status === 'error' ? 'Tentar de novo' : 'Enviar'}</button><button class="btn small-btn" data-wa="cancel" data-i="${i}">Cancelar</button></div>` : ''}
    </div>`)
    .join('');
  box.querySelectorAll('[data-wa]').forEach((b) =>
    b.addEventListener('click', async () => {
      const i = Number(b.dataset.i);
      b.disabled = true;
      if (b.dataset.wa === 'send') {
        const r = await central.whatsappConfirm(state.chatId, m.id, i);
        if (r?.ok) toast(`Enviada para ${r.data.sentTo || r.data.to}.`);
      } else {
        await central.whatsappCancel(state.chatId, m.id, i);
      }
    }),
  );
  wrap.appendChild(box);
}

function scrollBottom(force = false) {
  const m = el.messages;
  if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 160) m.scrollTop = m.scrollHeight;
}

// ---------- Envio ----------
// Pode enviar a qualquer momento: se já houver uma tarefa rodando, a nova vira outro agente, em paralelo.
// Com o campo vazio e algo rodando, o botão vira "Parar" (para todos os agentes da conversa).
async function sendMessage() {
  const text = el.input.value.trim();
  if (!text) return;

  const chat = await ensureChat();
  const images = state.attachments.map((a) => a.path);
  const runId = crypto.randomUUID();
  const parallel = isBusy(chat.id);
  const userMsg = { role: 'user', text, images };
  chat.messages.push(userMsg);
  el.empty.hidden = true;
  appendMessage(userMsg);

  const liveMsg = { id: runId, role: 'assistant', text: '', tools: [], provider: 'claude', model: '…', route: null, parallel };
  chat.messages.push(liveMsg);
  const wrap = appendMessage(liveMsg);
  state.lives.set(runId, { chatId: chat.id, wrap, msg: liveMsg });
  fillAssistant(wrap, liveMsg, { live: true });
  scrollBottom(true);

  el.input.value = '';
  autosize();
  state.attachments = [];
  renderAttachments();
  el.badge.hidden = true;

  markRunning(chat.id, runId, true);
  updateSendButton();
  refreshList();

  const res = await central.send(chat.id, {
    text,
    images,
    runId,
    override: el.model.value,
    permissionMode: el.fullAccess.checked ? 'bypassPermissions' : undefined,
  });

  if (res?.error && !res.role) {
    // Falhou antes de começar (não houve "chat:done").
    markRunning(chat.id, runId, false);
    const live = state.lives.get(runId);
    state.lives.delete(runId);
    liveMsg.error = res.error;
    if (live && state.chatId === chat.id) fillAssistant(live.wrap, liveMsg);
    updateSendButton();
  }
  refreshList();
}

function updateSendButton() {
  const busy = isBusy(state.chatId) && !el.input.value.trim();
  el.send.textContent = busy ? 'Parar' : 'Enviar';
  el.send.classList.toggle('stop', busy);
}

central.onRoute(({ chatId, runId, route }) => {
  const live = state.lives.get(runId);
  if (!live) return;
  Object.assign(live.msg, { provider: route.provider, model: route.model, route });
  // O roteador pode ter levado a conversa para a pasta do projeto citado.
  if (route.project && state.chat?.id === chatId && (state.chat.messages?.length || 0) <= 2) {
    state.chat.cwd = route.project.path;
    syncCwdSelect();
  }
  if (state.chatId === chatId) fillAssistant(live.wrap, live.msg, { live: true });
});

const dirty = new Set();
let renderPending = false;
central.onEvent(({ chatId, runId, kind, text }) => {
  const live = state.lives.get(runId);
  if (!live) return;
  const m = live.msg;
  if (kind === 'delta') m.text += text;
  if (kind === 'tool') m.tools.push(text);
  if (state.chatId !== chatId) return;
  dirty.add(runId);
  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      for (const id of dirty) {
        const l = state.lives.get(id);
        if (l && l.chatId === state.chatId) fillAssistant(l.wrap, l.msg, { live: true });
      }
      dirty.clear();
      scrollBottom();
    });
  }
});

central.onDone(async ({ chatId, runId, message, source }) => {
  markRunning(chatId, runId, false);
  updateSendButton();
  const live = state.lives.get(runId);
  state.lives.delete(runId);
  if (live) {
    Object.assign(live.msg, message);
    if (chatId === state.chatId) {
      fillAssistant(live.wrap, live.msg);
      scrollBottom();
      const fresh = await central.getChat(chatId);
      el.title.textContent = fresh.title;
    }
  } else if (chatId === state.chatId) {
    // Terminou uma conversa que foi reaberta no meio da execução.
    state.chat = await central.getChat(chatId);
    renderMessages();
  }
  if (source === 'quick') return refreshList(); // a janela rápida mostra a resposta
  if (el.speak.checked && message.text) central.speak(message.text);
  if (document.hidden || !document.hasFocus()) {
    new Notification('Ohara', { body: (message.text || message.error || 'Tarefa concluída').slice(0, 140) });
  }
  refreshList();
});

// ---------- Prévia da rota ----------
let previewTimer;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const text = el.input.value.trim();
    if (!text) { el.badge.hidden = true; return; }
    const r = await central.previewRoute(text, { hasImage: state.attachments.length > 0, override: el.model.value, chatId: state.chatId });
    const name = r.provider === 'codex' ? 'Codex' : r.provider === 'local' ? 'Ohara' : 'Claude';
    el.badge.innerHTML = `→ <b class="${r.provider}">${name} ${escapeHtml(r.model)}</b> · ${escapeHtml(r.label)}${r.reasons.length > 1 ? ` · ${escapeHtml(r.reasons.slice(1).join(' · '))}` : ''}`;
    el.badge.title = r.reasons.join('\n');
    el.badge.hidden = false;
  }, 250);
}

// ---------- Anexos ----------
function renderAttachments() {
  el.attachments.innerHTML = '';
  state.attachments.forEach((a, i) => {
    const d = document.createElement('div');
    d.className = 'att';
    d.innerHTML = `<img src="${a.preview || fileUrl(a.path)}" alt=""><button title="Remover">✕</button>`;
    d.querySelector('button').addEventListener('click', () => {
      state.attachments.splice(i, 1);
      renderAttachments();
      schedulePreview();
    });
    el.attachments.appendChild(d);
  });
}

$('#btn-screen').addEventListener('click', async () => {
  try {
    const shot = await central.captureScreen();
    state.attachments.push(shot);
    renderAttachments();
    schedulePreview();
  } catch (err) {
    alertInline(`Não consegui capturar a tela: ${err.message}`);
  }
});

$('#btn-image').addEventListener('click', async () => {
  const files = await central.pickImages();
  files.forEach((p) => state.attachments.push({ path: p }));
  renderAttachments();
  schedulePreview();
});

// 🎤: com o Whisper instalado grava e transcreve aqui mesmo; sem ele, abre o ditado do Windows (Win+H).
let recording = null;
$('#btn-voice').addEventListener('click', async () => {
  const btn = $('#btn-voice');
  if (recording) {
    recording.stop();
    return;
  }
  const ws = await central.whisperStatus();
  if (!ws.installed) {
    el.input.focus();
    central.dictate();
    return;
  }
  try {
    recording = await Voice.record({ onLevel: (l) => (btn.style.boxShadow = `0 0 0 ${Math.round(l * 6)}px rgba(255,92,122,.5)`) });
    btn.classList.add('rec');
    btn.title = 'Gravando… clique para parar';
    const bytes = await recording.done;
    btn.classList.remove('rec');
    btn.style.boxShadow = '';
    btn.title = 'Falar';
    recording = null;
    if (!bytes) return toast('Não ouvi nada.');
    btn.textContent = '⏳';
    const text = await Voice.transcribe(bytes);
    btn.textContent = '🎤';
    el.input.value = (el.input.value ? `${el.input.value} ` : '') + text;
    autosize();
    schedulePreview();
    el.input.focus();
  } catch (err) {
    recording = null;
    btn.textContent = '🎤';
    btn.classList.remove('rec');
    toast(`Voz: ${err.message}`, 'error');
  }
});

function alertInline(text) {
  const d = document.createElement('div');
  d.className = 'msg assistant';
  d.innerHTML = `<div class="bubble error">⚠️ ${escapeHtml(text)}</div>`;
  el.messages.appendChild(d);
  scrollBottom(true);
}

// ---------- Pasta de trabalho ----------
async function loadRepos() {
  const repos = await central.listRepos();
  const opts = [state.config.defaultCwd, state.config.workspaceRoot, ...repos];
  el.cwd.innerHTML = '';
  for (const p of [...new Set(opts)]) {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = p.replace(state.config.workspaceRoot, '…') || p;
    el.cwd.appendChild(o);
  }
  const pick = document.createElement('option');
  pick.value = '__pick__';
  pick.textContent = 'Escolher outra pasta…';
  el.cwd.appendChild(pick);
}

function syncCwdSelect() {
  const cwd = state.chat?.cwd || state.config.defaultCwd;
  if (![...el.cwd.options].some((o) => o.value === cwd)) {
    const o = document.createElement('option');
    o.value = cwd;
    o.textContent = cwd;
    el.cwd.insertBefore(o, el.cwd.lastElementChild);
  }
  el.cwd.value = cwd;
}

el.cwd.addEventListener('change', async () => {
  if (el.cwd.value === '__pick__') {
    const p = await central.pickFolder();
    if (!p) return syncCwdSelect();
    const o = document.createElement('option');
    o.value = p;
    o.textContent = p;
    el.cwd.insertBefore(o, el.cwd.lastElementChild);
    el.cwd.value = p;
  }
  if (state.chatId) {
    await central.setCwd(state.chatId, el.cwd.value);
    state.chat.cwd = el.cwd.value;
  }
});

// ---------- Uso ----------
function setMeter(key, value, resetsAt) {
  const m = document.querySelector(`.meter[data-key="${key}"]`);
  const bar = m.querySelector('i');
  if (value == null) {
    m.querySelector('b').textContent = '—';
    bar.style.width = '0';
    m.querySelector('small').textContent = 'sem dados ainda';
    return;
  }
  const pct = Math.round(value * 100);
  m.querySelector('b').textContent = `${pct}%`;
  bar.style.width = `${Math.min(100, pct)}%`;
  bar.className = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
  m.querySelector('small').textContent = resetsAt ? `renova ${fmtReset(resetsAt)}` : '';
}

function fmtReset(sec) {
  const d = new Date(sec * 1000);
  const diffH = (d - Date.now()) / 36e5;
  if (diffH < 0) return 'já renovou';
  if (diffH < 24) return `em ${diffH < 1 ? `${Math.round(diffH * 60)} min` : `${diffH.toFixed(1)} h`}`;
  return d.toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function renderUsage(u) {
  const c = u.limits.claude || {};
  const x = u.limits.codex || {};
  setMeter('claude-5h', c.fiveHour, c.fiveHourResetsAt);
  setMeter('claude-7d', c.weekly, c.weeklyResetsAt);
  setMeter('codex-5h', x.fiveHour, x.fiveHourResetsAt);
  setMeter('codex-7d', x.weekly, x.weeklyResetsAt);
  const t = u.today;
  const tot = (p) => fmtNum(p.input + p.cached + p.output);
  $('#usage-today').innerHTML = `Hoje: Claude ${t.claude.calls} pedidos (${tot(t.claude)} tokens)<br>Codex ${t.codex.calls} pedidos (${tot(t.codex)} tokens)`;
}

central.onMessage(({ chatId, message }) => {
  if (chatId !== state.chatId) return;
  const local = state.chat?.messages.find((m) => m.id === message.id);
  if (local) Object.assign(local, message);
  const wrap = el.messages.querySelector(`.msg[data-id="${message.id}"]`);
  if (wrap) fillAssistant(wrap, local || message);
});

central.onUsage(renderUsage);

// ---------- Entrada ----------
function autosize() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(240, el.input.scrollHeight)}px`;
}

el.input.addEventListener('input', () => { autosize(); schedulePreview(); });
el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
el.model.addEventListener('change', schedulePreview);
el.send.addEventListener('click', () => {
  if (isBusy(state.chatId) && !el.input.value.trim()) central.cancel(state.chatId);
  else sendMessage();
});
el.input.addEventListener('input', updateSendButton);

$('#new-chat').addEventListener('click', () => {
  state.chatId = null;
  state.chat = null;
  renderMessages();
  updateSendButton();
  refreshList();
  el.input.focus();
});

document.querySelectorAll('.suggestions .chip').forEach((c) =>
  c.addEventListener('click', () => {
    el.input.value = c.dataset.s;
    autosize();
    schedulePreview();
    el.input.focus();
  }),
);

el.speak.addEventListener('change', () => {
  central.setConfig({ voice: { speakReplies: el.speak.checked } });
  if (!el.speak.checked) central.stopSpeaking();
});

el.fullAccess.addEventListener('change', () => {
  document.body.classList.toggle('full-access', el.fullAccess.checked);
});

central.onFocusInput(() => el.input.focus());
central.onChatOpen((id) => {
  if (typeof setView === 'function') setView('chat');
  openChat(id);
});
central.onChatsChanged(({ openId } = {}) => {
  refreshList();
  if (openId) {
    if (typeof setView === 'function') setView('chat');
    openChat(openId);
  }
});

// Usado por outras telas: abre uma conversa nova com um texto pronto (e a pasta certa).
async function newChatWithPrompt(text, { cwd, send = false, override } = {}) {
  if (typeof setView === 'function') setView('chat');
  state.chatId = null;
  state.chat = null;
  renderMessages();
  updateSendButton();
  if (cwd) {
    if (![...el.cwd.options].some((o) => o.value === cwd)) {
      const o = document.createElement('option');
      o.value = cwd;
      o.textContent = cwd;
      el.cwd.insertBefore(o, el.cwd.lastElementChild);
    }
    el.cwd.value = cwd;
  }
  if (override) el.model.value = override;
  el.input.value = text;
  autosize();
  schedulePreview();
  el.input.focus();
  el.input.setSelectionRange(text.length, text.length);
  refreshList();
  if (send) await sendMessage();
}

// ---------- Início ----------
(async function init() {
  state.config = await central.getConfig();
  central.appVersion().then((v) => { document.getElementById('app-version').textContent = 'v' + v; });
  el.speak.checked = !!state.config.voice.speakReplies;
  await loadRepos();
  syncCwdSelect();
  await refreshList();
  renderUsage(await central.getUsage());
  el.input.focus();
})();

// ---------- Voz neural ----------
// O processo principal manda um MP3 por trecho; tocam em fila, na ordem em que chegam.
const tts = { id: 0, queue: [], audio: null };
function ttsNext() {
  if (tts.audio || !tts.queue.length) return;
  const file = tts.queue.shift();
  const a = new Audio(fileUrl(file));
  tts.audio = a;
  const done = () => {
    if (tts.audio === a) tts.audio = null;
    ttsNext();
  };
  a.addEventListener('ended', done);
  a.addEventListener('error', done);
  a.play().catch(done);
}
central.onTtsPlay(({ id, file, first }) => {
  if (first || id !== tts.id) {
    // fala nova: descarta o que sobrou da anterior
    tts.id = id;
    tts.queue = [];
    if (tts.audio) { tts.audio.pause(); tts.audio = null; }
  }
  tts.queue.push(file);
  ttsNext();
});
central.onTtsStop(() => {
  tts.queue = [];
  if (tts.audio) { tts.audio.pause(); tts.audio = null; }
});
