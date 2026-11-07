/* Utilitários compartilhados pelas telas. */
/* eslint-disable no-unused-vars */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function ymdLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function brDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}${y !== String(new Date().getFullYear()) ? `/${y}` : ''}`;
}

function relTime(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return 'agora';
  if (diff < 3600) return `há ${Math.round(diff / 60)} min`;
  if (diff < 86400) return `há ${Math.round(diff / 3600)} h`;
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function fmtTokens(n) {
  n = n || 0;
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

let toastTimer;
function toast(text, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === 'error' ? 6000 : 3000);
}

// Janela modal simples. Devolve o elemento do cartão; fechar com closeModal().
function openModal(html, { wide = false } = {}) {
  const m = document.getElementById('modal');
  const card = document.getElementById('modal-card');
  card.className = `modal-card${wide ? ' wide' : ''}`;
  card.innerHTML = html;
  m.hidden = false;
  card.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModal));
  setTimeout(() => card.querySelector('input,textarea,select,button')?.focus(), 30);
  return card;
}

function closeModal() {
  document.getElementById('modal').hidden = true;
}

document.getElementById('modal').addEventListener('mousedown', (e) => {
  if (e.target.id === 'modal') closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('modal').hidden) closeModal();
});

// Chamada IPC "segura": { ok, data, error }.
async function callSafe(promise, errPrefix = '') {
  const r = await promise;
  if (r && r.ok === false) {
    toast(`${errPrefix}${r.error}`, 'error');
    return null;
  }
  return r?.data;
}

const MODEL_OPTIONS = [
  ['auto', 'Automático'],
  ['claude:rapido', 'Claude Haiku'],
  ['claude:equilibrado', 'Claude Sonnet'],
  ['claude:profundo', 'Claude Opus'],
  ['codex:medium', 'Codex'],
  ['codex:high', 'Codex (raciocínio alto)'],
];
const WEEKDAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
