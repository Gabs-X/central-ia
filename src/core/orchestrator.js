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
  ].join('\n');
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
  async send(chatId, { text, images = [], override = 'auto', permissionMode, source = 'chat', runId: clientRunId }) {
    const config = this.getConfig();
    const chat = this.get(chatId);
    if (!chat) throw new Error('Conversa não encontrada');

    // "abre o Spotify", "pesquisa no Google X": resolve na hora, sem IA e sem gastar cota.
    if (this.openExternal && !images.length && (!override || override === 'auto')) {
      const local = await this.#tryQuickAction(chat, text, clientRunId, source);
      if (local) return local;
    }

    const parallel = this.isRunning(chatId);

    const decision = this.#route(chat, text, { hasImage: images.length > 0, override });
    if (source === 'chat') this.#remember(text, images.length > 0, override);

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
    const sess = parallel ? null : chat.sessions[decision.provider];
    const context = this.#handoff(chat, decision.provider, { upTo: userIndex, fresh: parallel });
    const askWhatsApp = wantsWhatsApp(text) && !!(this.whatsapp || this.whatsappWeb);
    const onEvent = (ev) => {
      if (ev.kind === 'limits') {
        this.usage.updateClaudeLimits(ev.info);
        this.emit('usage:update', this.usage.summary());
        return;
      }
      if (ev.kind === 'tool') assistant.tools.push(ev.text);
      this.emit('chat:event', { chatId, runId, ...ev });
    };

    const extra = [parallel ? PARALLEL_NOTE : '', askWhatsApp ? WHATSAPP_NOTE : ''].filter(Boolean).join('\n');
    const common = {
      prompt: context + text,
      cwd: chat.cwd,
      effort: decision.effort,
      sessionId: sess?.id,
      images,
      config,
      systemPrompt: systemPrompt(config, chat.cwd) + (extra ? '\n' + extra : ''),
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
        const retry = { ...common, prompt: retryCtx + text, sessionId: undefined };
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

    // Só o agente principal guarda a sessão; o que ele não viu entra como contexto na próxima vez.
    if (result.sessionId && !parallel) {
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
