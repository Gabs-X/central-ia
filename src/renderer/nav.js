/* global central, el, renderMeetings, renderToday, renderAutomations, renderUsageView, renderSettings, toast */
// Navegação entre as telas.

const VIEWS = ['today', 'chat', 'meetings', 'auto', 'usage', 'settings'];
let currentView = 'chat';

function setView(view) {
  if (!VIEWS.includes(view)) view = 'chat';
  currentView = view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  for (const v of VIEWS) document.getElementById(`view-${v}`).hidden = v !== view;
  document.querySelector('.side-chat').hidden = view !== 'chat';
  document.querySelector('.side-meetings').hidden = view !== 'meetings';
  document.querySelector('.side-spacer').hidden = view === 'chat' || view === 'meetings';
  const render = { today: renderToday, meetings: renderMeetings, auto: renderAutomations, usage: renderUsageView, settings: renderSettings }[view];
  render?.();
  if (view === 'chat') el.input.focus();
  try {
    localStorage.setItem('central:view', view);
  } catch {
    /* sem armazenamento: tudo bem */
  }
}

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
central.onView((view) => {
  if (view === 'meetings' && typeof mt !== 'undefined') mt.view = 'board';
  setView(view);
});

// Escuta contínua ("Ohara, ...") roda nesta janela, mesmo escondida.
// Variações comuns na transcrição do Whisper.
const WAKE_WORDS = ['ohara', 'o hara', 'oh hara', 'o-hara', 'oara', 'ohhara', 'orara', 'o herra', 'o hera', 'ohera', 'oera', 'o arra', 'oarra'];
let stopListening = null;
async function applyListening(cfg) {
  const want = !!cfg.voice.wakeWord;
  if (want && !stopListening) {
    const ws = await central.whisperStatus();
    if (!ws.installed) return;
    stopListening = Voice.listen({
      wakeWords: WAKE_WORDS,
      onCommand: (text) => central.quickAsk ? central.quickAsk(text) : null,
      onState: (s) => {
        const dot = document.getElementById('listen-state');
        if (dot) dot.textContent = s;
      },
    });
  } else if (!want && stopListening) {
    stopListening();
    stopListening = null;
  }
}

(async function initNav() {
  let saved = 'chat';
  try {
    saved = localStorage.getItem('central:view') || 'chat';
  } catch {
    /* ignora */
  }
  setView(saved);
  applyListening(await central.getConfig());
})();
