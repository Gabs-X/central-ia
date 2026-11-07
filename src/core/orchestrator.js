// Orquestrador: recebe um pedido, escolhe a rota, chama o provedor e
// mantém o contexto quando a conversa alterna entre Claude e Codex.
const crypto = require('crypto');
const { route, classify, learnPreferences } = require('./router');
const { runClaude } = require('./providers/claude');
const { runCodex } = require('./providers/codex');

const MAX_CONTEXT_CHARS = 9000;
const MAX_MSG_CHARS = 1800;

function systemPrompt(config, cwd) {
  return [
    'Você é a Central IA, assistente pessoal do Gabriel rodando no PC dele (Windows 11).',
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
  constructor({ chatsStore, prefsStore, usage, getConfig, emit }) {
    this.chats = chatsStore; // JsonStore { chats: [] }
    this.prefs = prefsStore; // JsonStore { overrides: [] }
    this.usage = usage;
    this.getConfig = getConfig;
    this.emit = emit; // (channel, payload) => void
    this.running = new Map(); // chatId -> AbortController
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

  cancel(id) {
    this.running.get(id)?.abort();
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

  preview(prompt, { hasImage, override }) {
    return route(prompt, { hasImage, override, usage: this.usage.limits(), config: this.getConfig(), learned: this.learned() });
  }

  // Monta o contexto que o provedor ainda não viu.
  #handoff(chat, provider) {
    const sess = chat.sessions[provider];
    const history = chat.messages.slice(0, -1); // sem a mensagem atual
    // syncedUpTo marca até onde este provedor já viu; o resto foi conversado com a outra IA.
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
    return `[Contexto anterior desta conversa, respondido por outra IA da central]\n${out.join('\n\n')}\n[Fim do contexto]\n\n`;
  }

  async send(chatId, { text, images = [], override = 'auto', permissionMode, source = 'chat' }) {
    const config = this.getConfig();
    const chat = this.get(chatId);
    if (!chat) throw new Error('Conversa não encontrada');
    if (this.running.has(chatId)) throw new Error('Já existe uma tarefa rodando nesta conversa');

    const decision = route(text, { hasImage: images.length > 0, override, usage: this.usage.limits(), config, learned: this.learned() });
    if (source === 'chat') this.#remember(text, images.length > 0, override);

    chat.messages.push({ role: 'user', text, images, at: Date.now() });
    if (chat.title === 'Nova conversa') chat.title = clip(text.replace(/\s+/g, ' '), 48);
    const assistant = {
      role: 'assistant',
      text: '',
      provider: decision.provider,
      model: decision.model,
      route: decision,
      tools: [],
      at: Date.now(),
    };
    chat.messages.push(assistant);
    chat.updatedAt = Date.now();
    this.chats.save();
    this.emit('chat:route', { chatId, route: decision });

    const ac = new AbortController();
    this.running.set(chatId, ac);

    const sess = chat.sessions[decision.provider];
    const context = this.#handoff(chat, decision.provider);
    const onEvent = (ev) => {
      if (ev.kind === 'limits') {
        this.usage.updateClaudeLimits(ev.info);
        this.emit('usage:update', this.usage.summary());
        return;
      }
      if (ev.kind === 'tool') assistant.tools.push(ev.text);
      this.emit('chat:event', { chatId, ...ev });
    };

    const common = {
      prompt: context + text,
      cwd: chat.cwd,
      effort: decision.effort,
      sessionId: sess?.id,
      images,
      config,
      systemPrompt: systemPrompt(config, chat.cwd),
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
        const retryCtx = this.#handoff(chat, decision.provider);
        const retry = { ...common, prompt: retryCtx + text, sessionId: undefined };
        result =
          decision.provider === 'codex'
            ? await runCodex({ ...retry, sandbox: permissionMode === 'bypassPermissions' ? 'danger-full-access' : undefined })
            : await runClaude({ ...retry, model: decision.model, permissionMode });
      }
    } catch (err) {
      result = { provider: decision.provider, model: decision.model, text: '', error: err.message, tokens: {} };
    } finally {
      this.running.delete(chatId);
    }

    assistant.text = result.text || '';
    assistant.error = result.error || null;
    assistant.model = result.model || decision.model;
    assistant.tokens = result.tokens;
    if (result.sessionId) {
      chat.sessions[decision.provider] = { id: result.sessionId, syncedUpTo: chat.messages.length };
    }
    chat.updatedAt = Date.now();
    this.chats.save();

    if (result.tokens && (result.tokens.input || result.tokens.output)) {
      this.usage.record(decision.provider, assistant.model, result.tokens, source);
    }
    if (decision.provider === 'codex') this.usage.refreshCodexLimits();
    this.emit('usage:update', this.usage.summary());
    this.emit('chat:done', { chatId, message: assistant, source });
    return assistant;
  }
}

module.exports = { Orchestrator };
