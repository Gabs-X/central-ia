/* global central, renderMarkdown */
const $ = (sel) => document.querySelector(sel);

const state = {
  chatId: null,
  chat: null,
  attachments: [], // { path, preview }
  running: new Set(),
  config: null,
  live: null, // elementos da resposta em andamento { chatId, bubble, tools, text, meta }
};

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
  const name = msg.provider === 'codex' ? 'Codex' : 'Claude';
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
    item.innerHTML = `<span title="${escapeHtml(c.cwd)}">${state.running.has(c.id) ? '⏳ ' : ''}${escapeHtml(c.title)}</span><button class="del" title="Apagar">✕</button>`;
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
  state.live = null;
  renderMessages();
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
  meta.innerHTML = `${providerTag(m)}<span title="${escapeHtml(reasons)}">${escapeHtml(m.route?.label || '')}</span>${tokens ? `<span>${tokens}</span>` : ''}${
    live ? '' : '<button class="act" data-a="copy" title="Copiar">⧉</button><button class="act" data-a="speak" title="Ler em voz alta">🔊</button>'
  }`;
  meta.querySelector('[data-a=copy]')?.addEventListener('click', () => navigator.clipboard.writeText(m.text || ''));
  meta.querySelector('[data-a=speak]')?.addEventListener('click', () => central.speak(m.text || ''));

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
}

function scrollBottom(force = false) {
  const m = el.messages;
  if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 160) m.scrollTop = m.scrollHeight;
}

// ---------- Envio ----------
// Enter/Enviar: envia. Com a resposta em andamento, só o botão "Parar" cancela (Enter não cancela por engano).
async function sendMessage() {
  const text = el.input.value.trim();
  if (state.running.has(state.chatId)) {
    toast('Aguarde a resposta ou clique em Parar.');
    return;
  }
  if (!text) return;

  const chat = await ensureChat();
  const images = state.attachments.map((a) => a.path);
  const userMsg = { role: 'user', text, images };
  chat.messages.push(userMsg);
  el.empty.hidden = true;
  appendMessage(userMsg);

  const liveMsg = { role: 'assistant', text: '', tools: [], provider: 'claude', model: '…', route: null };
  chat.messages.push(liveMsg);
  const wrap = appendMessage(liveMsg);
  state.live = { chatId: chat.id, wrap, msg: liveMsg };
  fillAssistant(wrap, liveMsg, { live: true });
  scrollBottom(true);

  el.input.value = '';
  autosize();
  state.attachments = [];
  renderAttachments();
  el.badge.hidden = true;

  state.running.add(chat.id);
  updateSendButton();
  refreshList();

  const res = await central.send(chat.id, {
    text,
    images,
    override: el.model.value,
    permissionMode: el.fullAccess.checked ? 'bypassPermissions' : undefined,
  });

  state.running.delete(chat.id);
  updateSendButton();
  if (res?.error && !res.role) {
    liveMsg.error = res.error;
    if (state.live?.chatId === chat.id) fillAssistant(wrap, liveMsg);
  }
  refreshList();
}

function updateSendButton() {
  const busy = state.running.has(state.chatId);
  el.send.textContent = busy ? 'Parar' : 'Enviar';
  el.send.classList.toggle('stop', busy);
}

central.onRoute(({ chatId, route }) => {
  if (state.live?.chatId !== chatId) return;
  Object.assign(state.live.msg, { provider: route.provider, model: route.model, route });
  // O roteador pode ter levado a conversa para a pasta do projeto citado.
  if (route.project && state.chat?.id === chatId && (state.chat.messages?.length || 0) <= 2) {
    state.chat.cwd = route.project.path;
    syncCwdSelect();
  }
  fillAssistant(state.live.wrap, state.live.msg, { live: true });
});

let renderPending = false;
central.onEvent(({ chatId, kind, text }) => {
  if (state.live?.chatId !== chatId) return;
  const m = state.live.msg;
  if (kind === 'delta') m.text += text;
  if (kind === 'tool') m.tools.push(text);
  if (!renderPending) {
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      if (state.live) {
        fillAssistant(state.live.wrap, state.live.msg, { live: true });
        scrollBottom();
      }
    });
  }
});

central.onDone(async ({ chatId, message, source }) => {
  state.running.delete(chatId);
  updateSendButton();
  if (state.live?.chatId === chatId) {
    Object.assign(state.live.msg, message);
    fillAssistant(state.live.wrap, state.live.msg);
    state.live = null;
    scrollBottom();
    if (chatId === state.chatId) {
      state.chat = await central.getChat(chatId);
      el.title.textContent = state.chat.title;
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
    const name = r.provider === 'codex' ? 'Codex' : 'Claude';
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
  if (state.running.has(state.chatId)) central.cancel(state.chatId);
  else sendMessage();
});

$('#new-chat').addEventListener('click', () => {
  state.chatId = null;
  state.chat = null;
  state.live = null;
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
  state.live = null;
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
