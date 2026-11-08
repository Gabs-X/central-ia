// WhatsApp para o próprio dono via CallMeBot (https://www.callmebot.com/blog/free-api-whatsapp-messages/).
// Configuração: mande "I allow callmebot to send me messages" para o número do CallMeBot e guarde a chave recebida.
// A Ohara só envia para o número configurado: não há como escolher outro destinatário.
const API = 'https://api.callmebot.com/whatsapp.php';
const MAX_CHUNK = 1500; // mensagens longas vão em partes
const MAX_PARTS = 4;
const GAP_MS = 2500; // o CallMeBot limita envios seguidos

const strip = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// "me manda no WhatsApp", "envia pro meu zap", "manda no wpp"...
function wantsWhatsApp(text) {
  const t = strip(text || '');
  const mention = /\b(whats ?app|whats|zap|zapzap|wpp)\b/.test(t);
  const verb = /\b(mand\w*|envi\w*|avis\w*|lembr\w*|jog\w*|notifi\w*|dispar\w*)\b/.test(t);
  return mention && verb;
}

// Converte o markdown da resposta para a formatação do WhatsApp.
function toWhatsAppText(md) {
  return String(md || '')
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, '```$1```')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Divide em partes de até MAX_CHUNK caracteres, de preferência em quebras de parágrafo/linha.
function splitMessage(text, max = MAX_CHUNK, maxParts = MAX_PARTS) {
  const parts = [];
  let rest = text;
  while (rest.length > max && parts.length < maxParts - 1) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > max) rest = `${rest.slice(0, max - 40).trim()}…\n\n(continua na Ohara)`;
  if (rest) parts.push(rest);
  return parts;
}

// Rascunhos para contatos que a IA deixa na resposta:
// [[whatsapp para="João Silva"]]texto[[/whatsapp]]  →  { text sem os blocos, drafts: [{ to, text }] }
function extractDrafts(answer) {
  const drafts = [];
  const re = /\[\[whatsapp\s+para\s*=\s*"([^"]+)"\s*\]\]([\s\S]*?)\[\[\/whatsapp\]\]/gi;
  const text = String(answer || '')
    .replace(re, (_m, to, body) => {
      const t = body.trim();
      if (to.trim() && t) drafts.push({ to: to.trim(), text: t });
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, drafts };
}

// Aviso de demandas novas depois de uma reunião.
function formatTasksMessage(meetingTitle, tasks) {
  const br = (d) => d.split('-').reverse().join('/');
  const prio = { alta: '🔴', media: '🟡', baixa: '🟢' };
  const lines = tasks.map((t) => {
    const extra = [t.deadline && `até ${br(t.deadline)}${t.time ? ` ${t.time}` : ''}`, t.requestedBy && `pedido por ${t.requestedBy}`].filter(Boolean).join(' · ');
    return `${prio[t.priority] || '•'} ${t.text}${extra ? `\n   _${extra}_` : ''}`;
  });
  const n = tasks.length;
  return `📋 *${n} demanda${n > 1 ? 's' : ''} nova${n > 1 ? 's' : ''} para você*\nReunião: ${meetingTitle}\n\n${lines.join('\n')}`;
}

const norm = (s) => strip(String(s || '')).replace(/\s+/g, ' ').trim();

// Escolhe o contato: nome igual > único resultado > nome que começa igual (se só um). Senão, ambíguo.
function pickContact(query, titles) {
  const q = norm(query);
  const uniq = [...new Set(titles.filter(Boolean))];
  const exact = uniq.filter((t) => norm(t) === q);
  if (exact.length === 1) return { name: exact[0] };
  if (uniq.length === 1) return { name: uniq[0] };
  const starts = uniq.filter((t) => norm(t).startsWith(q));
  if (starts.length === 1) return { name: starts[0] };
  if (!uniq.length) return { error: `Não achei "${query}" nos seus contatos do WhatsApp.` };
  return { error: `Mais de um contato para "${query}": ${uniq.slice(0, 5).join(', ')}. Diga o nome completo.`, candidates: uniq };
}

class WhatsApp {
  constructor({ getConfig }) {
    this.getConfig = getConfig;
  }

  get settings() {
    return this.getConfig().integrations.whatsapp || {};
  }

  get configured() {
    const { phone, apikey } = this.settings;
    return !!(phone && apikey);
  }

  status() {
    const { phone } = this.settings;
    return { configured: this.configured, phone: phone ? `${String(phone).slice(0, 5)}•••${String(phone).slice(-2)}` : '' };
  }

  async #sendOne(text) {
    const { phone, apikey } = this.settings;
    const qs = new URLSearchParams({ phone: String(phone).replace(/[^\d+]/g, ''), text, apikey: String(apikey) });
    const res = await fetch(`${API}?${qs}`, { headers: { 'User-Agent': 'ohara' } });
    const body = await res.text();
    const plain = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!res.ok || /invalid|error|not (allowed|activated)|wrong/i.test(plain)) {
      throw new Error(`CallMeBot: ${plain.slice(0, 160) || `HTTP ${res.status}`}`);
    }
  }

  /** Envia para o WhatsApp do dono. Retorna o número de partes enviadas. */
  async send(markdown) {
    if (!this.configured) throw new Error('WhatsApp não configurado: informe o número e a chave do CallMeBot em Ajustes.');
    const parts = splitMessage(toWhatsAppText(markdown));
    if (!parts.length) throw new Error('Mensagem vazia.');
    for (let i = 0; i < parts.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, GAP_MS));
      await this.#sendOne(parts.length > 1 ? `(${i + 1}/${parts.length})\n${parts[i]}` : parts[i]);
    }
    return parts.length;
  }
}

module.exports = { WhatsApp, wantsWhatsApp, toWhatsAppText, splitMessage, formatTasksMessage, extractDrafts, pickContact };
