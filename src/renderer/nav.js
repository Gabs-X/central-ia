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

// Escuta contínua roda nesta janela, mesmo escondida. Cada fala vai para o processo principal,
// que reconhece "Ohara", abre a conversa por voz e mantém o microfone aberto para os próximos pedidos.
let stopListening = null;
const heardLog = []; // últimas falas ouvidas (aparecem ao passar o mouse no estado, em Ajustes → Voz)
function showListenState(s) {
  const dot = document.getElementById('listen-state');
  if (!dot) return;
  dot.textContent = s;
  dot.title = heardLog.length ? `Últimas falas ouvidas:\n${heardLog.join('\n')}` : '';
}
central.onVoiceSession(({ state }) => showListenState(state));
// Ex.: "Ohara, desativa o microfone" desliga a escuta pela voz.
central.onConfigChanged((cfg) => applyListening(cfg));

async function applyListening(cfg) {
  const want = !!cfg.voice.wakeWord;
  if (want && !stopListening) {
    const ws = await central.whisperStatus();
    if (!ws.installed) {
      central.voiceLog(`escuta ligada, mas o Whisper (modelo ${ws.modelName}) não está instalado`);
      return;
    }
    central.voiceLog('escuta: iniciando');
    stopListening = Voice.listen({
      onHeard: async (bytes) => {
        const r = await central.voiceHeard(bytes);
        if (!r.ok) throw new Error(r.error);
        const { text, action } = r.data;
        if (text) {
          heardLog.unshift(`${new Date().toLocaleTimeString('pt-BR')} · ${action} · “${text}”`);
          heardLog.length = Math.min(heardLog.length, 8);
        }
        return { state: action === 'ignorado' || action === 'nada' ? 'ouvindo' : action };
      },
      onState: showListenState,
      onLog: (msg) => central.voiceLog(msg),
      // Não ouve a própria voz enquanto lê uma resposta (só conta áudio tocando de verdade).
      isSpeaking: () => typeof tts !== 'undefined' && !!tts.audio && !tts.audio.paused && !tts.audio.ended,
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
