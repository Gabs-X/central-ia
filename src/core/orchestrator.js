// Orquestrador: recebe um pedido, escolhe a rota, chama o provedor e
// mantém o contexto quando a conversa alterna entre Claude e Codex.
const crypto = require('crypto');
const { route, classify, learnPreferences } = require('./router');
const { runClaude } = require('./providers/claude');
const { runCodex } = require('./providers/codex');
const path = require('path');
const { listRepos } = require('./system');
const { wantsWhatsApp, extractDrafts } = require('../integrations/whatsapp');
const { parseQuickAction, runQuickAction } = require('./quick-actions');

const WHATSAPP_NOTE = [
  'O pedido envolve WhatsApp. Não tente enviar nada você mesmo: a Ohara cuida do envio.',
  '- Se o destino é o próprio Gabriel ("me manda", "pra mim", "me avisa"): faça o que foi pedido e escreva a resposta final já como a mensagem (curta, sem tabelas); a Ohara envia para o WhatsApp dele.',
  '- Se o destino é outra pessoa: escreva a mensagem como se fosse o Gabriel escrevendo (primeira pessoa, no tom dele) e coloque no fim da resposta exatamente:',
  '[[whatsapp para="Nome do contato como ele falou, ou número com DDI"]]',
  'texto da mensagem',
  '[[/whatsapp]]',
  'Fora do bloco, diga em uma frase o que preparou. A Ohara mostra a mensagem para o Gabriel confirmar antes de enviar; nunca diga que já enviou.',
].join('\n');

const VOICE_NOTE =
  'Este pedido veio por voz e a sua resposta será lida em voz alta. Responda como numa conversa falada: curto (1 a 3 frases), direto, sem markdown, listas, tabelas, links ou emojis. Se fizer uma ação, diga em uma frase o que fez.';

// Na conversa por voz, o que não exige raciocínio vai para o modelo rápido (resposta em menos tempo).
const VOICE_FAST = new Set(['rapida', 'geral', 'escrita', 'sistema']);

const PARALLEL_NOTE =
  'Outra tarefa desta mesma conversa ainda está rodando em paralelo. Faça só o que este pedido pede e evite mexer nos mesmos arquivos que a outra tarefa sem necessidade.';

const MAX_CONTEXT_CHARS = 9000;
const MAX_MSG_CHARS = 1800;

function systemPrompt(config, cwd) {
  return [
    'Você é a Ohara, assistente pessoal do Gabriel rodando no PC dele (Windows 11).',
    'Responda sempre em português do Brasil, de forma direta.',
    `Diretório de trabalho atual: ${cwd}. Os repositórios ficam em ${config.workspaceRoot}.`,
    'Para ações no sistema use PowerShell (Start-Process para abrir programas e sites, Get-ChildItem, etc.).',
    'Antes de qualquer ação destrutiva ou difícil de desfazer (apagar arquivos, desinstalar, git push, force, formatar), pare e peça confirmação explícita na resposta em vez de executar.',
    'Ao terminar uma tarefa, diga em uma ou duas frases o que foi feito.',
    '',
    'Seu jeito: você é resolutiva. Seu objetivo é resolver o problema do Gabriel, não só responder. Tente de verdade antes de dizer que não dá:',
    'procure outro caminho (PowerShell, um app, um site, um script), e se faltar uma informação pergunte só o essencial. Nunca termine só com "não consigo".',
    'Você tem bom humor: é leve, espirituosa e às vezes solta uma piada curta ou um comentário divertido, como uma amiga que manja muito.',
    'Não faça referências a One Piece nem a animes. O humor nunca atrapalha a tarefa: primeiro resolve, depois a graça;',
    'nada de piada quando ele estiver com problema sério, irritado ou com pressa, e nunca às custas dele. Sem exagero: no máximo uma brincadeira por resposta.',
    `Você pode melhorar a si mesma: o seu código-fonte está em ${config.selfRepo} (app Electron; integrações em src/integrations, lógica em src/core, telas em src/renderer, testes em test/).`,
    'Quando um pedido esbarrar em algo que você ainda não sabe ou não consegue fazer (uma integração que não existe, um recurso que falta, um erro seu),',
    'explique em uma frase o que falta, ofereça-se para se alterar e, no fim da resposta, inclua exatamente uma linha:',
    '[[melhoria: o que mudar em você, em uma frase objetiva]]',
    'Essa linha não aparece para ele; se ele aceitar, você recebe o pedido para implementar a mudança. Não ofereça melhoria quando der para resolver agora de outro jeito.',
  ].join('\n');
}

// A Ohara se oferece para se alterar: "[[melhoria: ...]]" no fim da resposta.
const IMPROVE_RE = /\n?\[\[melhoria:\s*([^\]]+?)\s*\]\]\s*/i;
// "sim", "pode fazer", "manda ver"... aceitando a oferta.
const YES_RE = /^(sim|s|pode|pode sim|pode fazer|faz|faca|faca isso|faz isso|manda ver|bora|vai|quero|claro|ok|beleza|blz|isso|por favor|com certeza|aceito|implementa|se altera)\b/;

function selfImprovePrompt(desc, request) {
  return [
    `O Gabriel aceitou que você se altere para conseguir: ${desc}.`,
    request ? `Pedido original dele: "${request}".` : '',
    'Implemente a mudança no seu próprio código (você está no repositório da Ohara), seguindo o padrão do projeto:',
    'leia os arquivos relacionados antes, faça a mudança completa, escreva ou ajuste testes em test/ e rode `npm test` até passar.',
    'Faça commit local com uma mensagem em português descrevendo a mudança (sem linha de coautoria). Não dê push, não gere instalador e não publique nada.',
    'No fim, diga em poucas frases o que mudou e pergunte se ele quer que você publique a versão nova (ela só passa a valer depois de instalada).',
  ].filter(Boolean).join('\n');
}

function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

class Orchestrator {
  constructor({ chatsStore, prefsStore, usage, getConfig, emit, whatsapp = null, whatsappWeb = null, openExternal = null }) {
    this.openExternal = openExternal; // abre URLs/URIs (shell.openExternal); habilita as ações locais

    this.whatsapp = whatsapp; // CallMeBot: mensagens para o próprio Gabriel (opcional)
    this.whatsappWeb = whatsappWeb; // WhatsApp Web: mensagens para contatos, sempre com confirmação (opcional)
    this.chats = chatsStore; // JsonStore { chats: [] }
    this.prefs = prefsStore; // JsonStore { overrides: [] }
    this.usage = usage;
    this.getConfig = getConfig;
    this.emit = emit; // (channel, payload) => void
    this.running = new Map(); // runId -> { chatId, ac }: vários agentes por conversa
  }

  list() {
    return this.chats.data.chats
      .map(({ id, title, cwd, updatedAt }) => ({ id, title, cwd, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    return this.chats.data.chats.find((c) => c.id === id) || null;
  }

  create(cwd, title) {
    const config = this.getConfig();
    const chat = {
      id: crypto.randomUUID(),
      title: title || 'Nova conversa',
      cwd: cwd || config.defaultCwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      sessions: {},
    };
    this.chats.data.chats.push(chat);
    this.chats.save();
    return chat;
  }

  remove(id) {
    this.cancel(id);
    this.chats.data.chats = this.chats.data.chats.filter((c) => c.id !== id);
    this.chats.save();
  }

  setCwd(id, cwd) {
    const chat = this.get(id);
    if (!chat) return;
    chat.cwd = cwd;
    chat.sessions = {}; // sessões dos CLIs ficam presas ao diretório: recomeça com contexto transferido
    this.chats.save();
  }

  isRunning(chatId) {
    for (const r of this.running.values()) if (r.chatId === chatId) return true;
    return false;
  }

  // Sem runId, para todos os agentes da conversa.
  cancel(chatId, runId) {
    for (const [id, r] of this.running) if (r.chatId === chatId && (!runId || id === runId)) r.ac.abort();
  }

  // Preferências aprendidas com as suas trocas manuais de modelo.
  learned() {
    const config = this.getConfig();
    if (!config.learning?.enabled || !this.prefs) return {};
    return learnPreferences(this.prefs.data.overrides || [], config.learning.minVotes);
  }

  #remember(text, hasImage, override) {
    if (!this.prefs || !override || override === 'auto') return;
    const { category } = classify(text, { hasImage });
    const list = (this.prefs.data.overrides ||= []);
    list.push({ category, choice: override, at: Date.now() });
    if (list.length > 300) list.splice(0, list.length - 300);
    this.prefs.save();
  }

  forgetLearning() {
    if (!this.prefs) return;
    this.prefs.data.overrides = [];
    this.prefs.save();
  }

  // Repositórios conhecidos (para reconhecer "na ohara", "no taverna-bot"...). Cache de 5 min.
  #projects() {
    const root = this.getConfig().workspaceRoot;
    if (!this.projCache || this.projCache.root !== root || Date.now() - this.projCache.at > 5 * 60_000) {
      let list = [];
      try {
        list = listRepos(root).map((p) => ({ name: path.basename(p), path: p }));
      } catch {}
      this.projCache = { root, at: Date.now(), list };
    }
    return this.projCache.list;
  }

  // Categoria do último pedido roteado automaticamente nesta conversa.
  #previousCategory(chat) {
    for (let i = (chat?.messages.length || 0) - 1; i >= 0; i--) {
      const r = chat.messages[i].route;
      if (r && r.category !== 'manual') return r.category;
    }
    return null;
  }

  #route(chat, text, { hasImage, override }) {
    return route(text, {
      hasImage,
      override,
      usage: this.usage.limits(),
      config: this.getConfig(),
      learned: this.learned(),
      projects: this.#projects(),
      previous: this.#previousCategory(chat),
    });
  }

  preview(prompt, { hasImage, override, chatId }) {
    const action = !hasImage && (!override || override === 'auto') ? parseQuickAction(prompt) : null;
    if (action) {
      return { provider: 'local', model: 'ação local', category: 'local', label: action.type === 'google' ? 'Pesquisa no Google' : 'Abrir app/site', reasons: ['resolvido na hora, sem IA (se não achar o app, vai para a IA)'] };
    }
    return this.#route(chatId ? this.get(chatId) : null, prompt, { hasImage, override });
  }

  // Monta o contexto que o provedor ainda não viu.
  // upTo: índice da mensagem atual (fica de fora). fresh: sessão nova, manda todo o histórico.
  #handoff(chat, provider, { upTo = chat.messages.length, fresh = false } = {}) {
    const sess = fresh ? null : chat.sessions[provider];
    const history = chat.messages.slice(0, upTo);
    // syncedUpTo marca até onde este provedor já viu; o resto veio da outra IA ou de agentes paralelos.
    const unseen = history.slice(sess ? sess.syncedUpTo : 0).filter((m) => m.text);
    if (!unseen.length) return '';

    const out = [];
    let total = 0;
    for (const m of [...unseen].reverse()) {
      const line = `${m.role === 'user' ? 'Gabriel' : `Assistente (${m.provider})`}: ${clip(m.text, MAX_MSG_CHARS)}`;
      if (total + line.length > MAX_CONTEXT_CHARS) break;
      out.unshift(line);
      total += line.length;
    }
    return `[Contexto anterior desta conversa, respondido por outra IA da Ohara]\n${out.join('\n\n')}\n[Fim do contexto]\n\n`;
  }

  // Vários agentes por conversa: cada pedido roda por conta própria. Se já houver um rodando,
  // o novo vai em paralelo, numa sessão separada que recebe o histórico como contexto.
  async send(chatId, { text, images = [], override = 'auto', permissionMode, source = 'chat', runId: clientRunId, onDelta }) {
    const config = this.getConfig();
    const chat = this.get(chatId);
    if (!chat) throw new Error('Conversa não encontrada');

    // Ela se ofereceu para se alterar e ele aceitou: implementa no próprio repositório, com o modelo mais forte.
    const improvement = this.#acceptedImprovement(chat, text);
    if (improvement) override = 'claude:profundo';

    // "abre o Spotify", "pesquisa no Google X": resolve na hora, sem IA e sem gastar cota.
    if (this.openExternal && !images.length && (!override || override === 'auto')) {
      const local = await this.#tryQuickAction(chat, text, clientRunId, source);
      if (local) return local;
    }

    const parallel = this.isRunning(chatId);

    const decision = this.#route(chat, text, { hasImage: images.length > 0, override });
    if (source === 'voice' && decision.provider === 'claude' && VOICE_FAST.has(decision.category) && (!override || override === 'auto')) {
      Object.assign(decision, { tier: 'rapido', model: config.claude.models.rapido, effort: 'low' });
      decision.reasons = [...(decision.reasons || []), 'conversa por voz: modelo rápido'];
    }
    if (improvement) decision.reasons = [...(decision.reasons || []), 'melhoria aceita: a Ohara vai se alterar'];
    if (source === 'chat' && !improvement) this.#remember(text, images.length > 0, override);

    // Conversa nova na pasta padrão citando um projeto: já trabalha dentro dele.
    if (decision.project && !chat.messages.length && chat.cwd === config.defaultCwd) {
      chat.cwd = decision.project.path;
      this.emit('chats:changed', {});
    }

    const userIndex = chat.messages.length;
    chat.messages.push({ role: 'user', text, images, at: Date.now() });
    if (chat.title === 'Nova conversa') chat.title = clip(text.replace(/\s+/g, ' '), 48);
    const runId = clientRunId || crypto.randomUUID();
    const assistant = {
      id: runId,
      role: 'assistant',
      text: '',
      provider: decision.provider,
      model: decision.model,
      route: decision,
      tools: [],
      parallel,
      at: Date.now(),
    };
    chat.messages.push(assistant);
    chat.updatedAt = Date.now();
    this.chats.save();
    this.emit('chat:route', { chatId, runId, route: decision });

    const ac = new AbortController();
    this.running.set(runId, { chatId, ac });

    // Agente paralelo não reaproveita a sessão (ela está em uso): começa limpo, com o histórico.
    // A automelhoria também roda à parte, porque trabalha em outra pasta (o repositório da Ohara).
    const isolated = parallel || !!improvement;
    const sess = isolated ? null : chat.sessions[decision.provider];
    const context = this.#handoff(chat, decision.provider, { upTo: userIndex, fresh: isolated });
    const cwd = improvement ? config.selfRepo : chat.cwd;
    const request = improvement ? `${selfImprovePrompt(improvement.desc, improvement.request)}\n\nResposta do Gabriel: ${text}` : text;
    const askWhatsApp = wantsWhatsApp(text) && !!(this.whatsapp || this.whatsappWeb);
    const onEvent = (ev) => {
      if (ev.kind === 'limits') {
        this.usage.updateClaudeLimits(ev.info);
        this.emit('usage:update', this.usage.summary());
        return;
      }
      if (ev.kind === 'tool') assistant.tools.push(ev.text);
      if (ev.kind === 'delta' && onDelta) onDelta(ev.text); // voz: começa a falar antes da resposta terminar
      this.emit('chat:event', { chatId, runId, ...ev });
    };

    const extra = [source === 'voice' ? VOICE_NOTE : '', parallel ? PARALLEL_NOTE : '', askWhatsApp ? WHATSAPP_NOTE : ''].filter(Boolean).join('\n');
    const common = {
      prompt: context + request,
      cwd,
      effort: decision.effort,
      sessionId: sess?.id,
      images,
      config,
      systemPrompt: systemPrompt(config, cwd) + (extra ? '\n' + extra : ''),
      onEvent,
      signal: ac.signal,
    };

    let result;
    try {
      result =
        decision.provider === 'codex'
          ? await runCodex({ ...common, sandbox: permissionMode === 'bypassPermissions' ? 'danger-full-access' : undefined })
          : await runClaude({ ...common, model: decision.model, permissionMode });

      // Sessão expirada/inválida: tenta de novo do zero com o histórico transferido.
      if (result.error && sess?.id && !ac.signal.aborted && !result.text) {
        delete chat.sessions[decision.provider];
        const retryCtx = this.#handoff(chat, decision.provider, { upTo: userIndex, fresh: true });
        const retry = { ...common, prompt: retryCtx + request, sessionId: undefined };
        result =
          decision.provider === 'codex'
            ? await runCodex({ ...retry, sandbox: permissionMode === 'bypassPermissions' ? 'danger-full-access' : undefined })
            : await runClaude({ ...retry, model: decision.model, permissionMode });
      }
    } catch (err) {
      result = { provider: decision.provider, model: decision.model, text: '', error: err.message, tokens: {} };
    } finally {
      this.running.delete(runId);
    }

    assistant.text = result.text || '';
    assistant.error = result.error || null;
    assistant.model = result.model || decision.model;
    assistant.tokens = result.tokens;
    if (askWhatsApp && assistant.text && !assistant.error) await this.#handleWhatsApp(assistant);

    // Oferta de automelhoria: guarda para o próximo "sim" e tira a marcação do texto.
    const offer = assistant.text.match(IMPROVE_RE);
    if (offer) {
      assistant.text = assistant.text.replace(IMPROVE_RE, '').trim();
      assistant.improvementOffer = offer[1];
      chat.pendingImprovement = { desc: offer[1], request: text, at: Date.now() };
    }

    // Só o agente principal guarda a sessão; o que ele não viu entra como contexto na próxima vez.
    if (result.sessionId && !isolated) {
      chat.sessions[decision.provider] = { id: result.sessionId, syncedUpTo: chat.messages.indexOf(assistant) + 1 };
    }
    chat.updatedAt = Date.now();
    this.chats.save();

    if (result.tokens && (result.tokens.input || result.tokens.output)) {
      this.usage.record(decision.provider, assistant.model, result.tokens, source);
    }
    if (decision.provider === 'codex') this.usage.refreshCodexLimits();
    this.emit('usage:update', this.usage.summary());
    this.emit('chat:done', { chatId, runId, message: assistant, source, running: this.isRunning(chatId) });
    return assistant;
  }

  // "sim"/"pode fazer" logo depois de ela oferecer uma melhoria (até 30 min depois).
  #acceptedImprovement(chat, text) {
    const pending = chat.pendingImprovement;
    if (!pending) return null;
    const plain = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^[^a-z]+/, '').trim();
    const fresh = Date.now() - pending.at < 30 * 60_000;
    delete chat.pendingImprovement; // vale só para a resposta seguinte
    if (!fresh || !YES_RE.test(plain) || plain.split(/\s+/).length > 12) return null;
    return pending;
  }

  async #tryQuickAction(chat, text, clientRunId, source) {
    const action = parseQuickAction(text);
    if (!action) return null;
    let done;
    try {
      done = await runQuickAction(action, { openExternal: this.openExternal });
    } catch {
      done = null;
    }
    if (!done) return null; // não achou o app: a IA tenta

    const runId = clientRunId || crypto.randomUUID();
    const route = { provider: 'local', model: 'ação local', category: 'local', label: action.type === 'google' ? 'Pesquisa no Google' : 'Abrir app/site', reasons: ['resolvido na hora, sem IA'] };
    chat.messages.push({ role: 'user', text, images: [], at: Date.now() });
    if (chat.title === 'Nova conversa') chat.title = clip(text.replace(/\s+/g, ' '), 48);
    const assistant = { id: runId, role: 'assistant', text: done.text, provider: 'local', model: 'ação local', route, tools: [], at: Date.now() };
    chat.messages.push(assistant);
    chat.updatedAt = Date.now();
    this.chats.save();
    this.emit('chat:route', { chatId: chat.id, runId, route });
    this.emit('chat:done', { chatId: chat.id, runId, message: assistant, source, running: this.isRunning(chat.id) });
    return assistant;
  }

  // Contato → rascunho para confirmar; sem rascunho → a resposta vai para o próprio Gabriel.
  async #handleWhatsApp(assistant) {
    const { text, drafts } = extractDrafts(assistant.text);
    if (drafts.length) {
      assistant.text = text || 'Mensagem pronta para enviar:';
      assistant.whatsappDrafts = drafts.map((d) => ({ ...d, status: 'pending' }));
      if (!this.whatsappWeb) {
        for (const d of assistant.whatsappDrafts) Object.assign(d, { status: 'error', error: 'Envio para contatos indisponível.' });
      }
      return;
    }
    if (!this.whatsapp?.configured) {
      assistant.whatsapp = { sent: false, error: 'WhatsApp não configurado: informe o número e a chave do CallMeBot em Ajustes.' };
      return;
    }
    try {
      const parts = await this.whatsapp.send(assistant.text);
      assistant.whatsapp = { sent: true, parts, at: Date.now() };
    } catch (err) {
      assistant.whatsapp = { sent: false, error: err.message };
    }
  }

  #findDraft(chatId, messageId, index = 0) {
    const chat = this.get(chatId);
    const msg = chat?.messages.find((m) => m.id === messageId);
    const draft = msg?.whatsappDrafts?.[index];
    if (!draft) throw new Error('Rascunho não encontrado.');
    return { chat, msg, draft };
  }

  /** Envia um rascunho para o contato. Só é chamado pelo botão "Enviar" da interface. */
  async confirmWhatsApp(chatId, messageId, index = 0) {
    const { chat, msg, draft } = this.#findDraft(chatId, messageId, index);
    if (draft.status === 'sent') return draft;
    if (draft.status === 'sending') throw new Error('Já está enviando.');
    if (!this.whatsappWeb) throw new Error('Envio para contatos indisponível.');
    draft.status = 'sending';
    draft.error = null;
    this.emit('chat:message', { chatId, message: msg });
    try {
      const { to } = await this.whatsappWeb.send(draft.to, draft.text);
      Object.assign(draft, { status: 'sent', sentTo: to, sentAt: Date.now() });
    } catch (err) {
      Object.assign(draft, { status: 'error', error: err.message });
    }
    chat.updatedAt = Date.now();
    this.chats.save();
    this.emit('chat:message', { chatId, message: msg });
    if (draft.status === 'error') throw new Error(draft.error);
    return draft;
  }

  cancelWhatsApp(chatId, messageId, index = 0) {
    const { msg, draft } = this.#findDraft(chatId, messageId, index);
    if (draft.status === 'sent' || draft.status === 'sending') return draft;
    draft.status = 'cancelled';
    this.chats.save();
    this.emit('chat:message', { chatId, message: msg });
    return draft;
  }
}

module.exports = { Orchestrator };
