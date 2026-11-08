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

// Resposta curta a um rascunho pendente: "confirmado", "pode enviar", "manda pra Tata" → 'confirm';
// "sim"/"ok" sozinho → 'yes'; "cancela", "não envia" → 'cancel'.
// Qualquer outra coisa (pedido novo, ajuste no texto) → null e segue para a IA.
// names: destinatários dos rascunhos, para aceitar "envia pra Tata".
const SEND_WORDS = new Set(['confirmado', 'confirmada', 'confirmo', 'confirma', 'confirmar', 'confirme', 'envia', 'envie', 'enviar', 'manda', 'mande', 'mandar', 'dispara', 'dispare']);
const YES_WORDS = new Set(['sim', 's', 'ok', 'okay', 'isso', 'beleza', 'blz', 'bora', 'certo', 'perfeito', 'otimo', 'claro', 'show', 'fechado']);
const CANCEL_WORDS = new Set(['cancela', 'cancele', 'cancelar', 'cancelado', 'cancelada', 'nao', 'esquece', 'esqueca', 'deixa', 'desiste']);
const FILLER_WORDS = new Set([
  'pode', 'vai', 'ja', 'agora', 'envio', 'logo', 'entao', 'ai', 'la', 'mesmo', 'tudo', 'bom', 'ta', 'e', 'de', 'vez', 'ser',
  'a', 'o', 'as', 'os', 'essa', 'esse', 'esta', 'este', 'ela', 'ele', 'elas', 'eles', 'mensagem', 'mensagens', 'msg',
  'por', 'favor', 'pf', 'pfv', 'pra', 'pro', 'para', 'p', 'no', 'na', 'whatsapp', 'whats', 'zap', 'wpp',
]);
const words = (s) => strip(String(s || '')).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

function parseSendReply(text, names = []) {
  const ws = words(text);
  if (!ws.length || ws.length > 12) return null;
  const nameWords = new Set(names.flatMap(words));
  const known = (w) => SEND_WORDS.has(w) || YES_WORDS.has(w) || CANCEL_WORDS.has(w) || FILLER_WORDS.has(w) || nameWords.has(w);
  if (!ws.every(known)) return null;
  if (ws.some((w) => CANCEL_WORDS.has(w))) return 'cancel'; // "não envia", "deixa pra lá": na dúvida, não envia
  if (ws.some((w) => SEND_WORDS.has(w))) return 'confirm';
  if (ws.some((w) => YES_WORDS.has(w))) return 'yes';
  return null;
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

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

// Quanto o nome salvo combina com o que ele falou (0 = nada). Aceita parte do nome ("Tata" → "Tata Souza"),
// apelido no começo ("vó" → "Vó Maria") e erro de transcrição ("tatar" → "Tata").
function contactScore(query, title) {
  const q = norm(query).replace(/[^a-z0-9 ]/g, '').trim();
  const t = norm(title).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q || !t) return 0;
  if (t === q) return 100;
  const tw = t.split(' ');
  const qw = q.split(' ');
  if (t.startsWith(`${q} `)) return 92;
  if (tw.includes(q)) return 88;
  if (qw.every((w) => tw.some((x) => x === w))) return 86;
  if (t.startsWith(q)) return 80;
  if (qw.every((w) => tw.some((x) => x.startsWith(w)))) return 75;
  if (q.length >= 4 && t.includes(q)) return 65;
  // Parecido (erro de transcrição): melhor palavra do nome contra a primeira palavra falada.
  const best = Math.max(...tw.map((x) => 1 - editDistance(x, qw[0]) / Math.max(x.length, qw[0].length)));
  return best >= 0.6 && qw[0].length >= 3 ? Math.round(best * 60) : 0;
}

// Escolhe o contato pelo melhor score; se dois ficarem empatados no topo, é ambíguo (pergunta em vez de chutar).
function pickContact(query, titles) {
  const q = norm(query);
  const uniq = [...new Set(titles.filter(Boolean))];
  const ranked = uniq.map((t) => ({ t, s: contactScore(query, t) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  if (ranked.length === 1 || (ranked.length > 1 && ranked[0].s - ranked[1].s >= 8)) return { name: ranked[0].t };
  if (ranked.length > 1) {
    const top = ranked.filter((x) => x.s === ranked[0].s).map((x) => x.t);
    return { error: `Tem mais de um contato parecido com "${query}": ${top.slice(0, 4).join(', ')}. Qual deles?`, candidates: top };
  }
  const exact = uniq.filter((t) => norm(t) === q);
  if (exact.length === 1) return { name: exact[0] };
  if (uniq.length === 1) return { name: uniq[0] }; // a própria busca do WhatsApp achou só um (ex.: pelo número)
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

module.exports = { WhatsApp, wantsWhatsApp, toWhatsAppText, splitMessage, formatTasksMessage, extractDrafts, pickContact, parseSendReply };
