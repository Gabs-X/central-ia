// Reuniões: observa a pasta de transcripts, gera resumo e extrai as demandas
// do Gabriel para o painel. Cada reunião vira uma chamada de IA sem ferramentas.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { loadMeeting, meetingKeyFromFile } = require('./transcript');
const { runJsonl, shorten } = require('./providers/common');
const { resolveCodex } = require('./providers/codex');

// Schema "estrito" (tudo obrigatório, null quando não houver) para funcionar no Claude e no Codex.
const nullableString = { type: ['string', 'null'] };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['relevante', 'titulo', 'tipo', 'resumo', 'topicos', 'decisoes', 'minhas_demandas', 'demandas_de_outros'],
  properties: {
    relevante: { type: 'boolean', description: 'false se for só conversa informal/teste sem conteúdo de trabalho' },
    titulo: { type: 'string', description: 'Título curto da reunião (até 60 caracteres)' },
    tipo: { type: 'string', enum: ['daily', 'alinhamento', '1:1', 'apresentacao', 'cliente', 'mentoria', 'informal', 'outro'] },
    resumo: { type: 'string', description: 'Resumo de 3 a 6 frases do que foi a call' },
    topicos: { type: 'array', items: { type: 'string' }, description: 'Principais assuntos, um por item' },
    decisoes: { type: 'array', items: { type: 'string' } },
    minhas_demandas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['descricao', 'pedido_por', 'prazo', 'prioridade', 'evidencia', 'horario'],
        properties: {
          descricao: { type: 'string', description: 'Ação concreta, começando com verbo no infinitivo' },
          pedido_por: nullableString,
          prazo: { ...nullableString, description: 'Data AAAA-MM-DD se houver prazo, senão null' },
          prioridade: { type: 'string', enum: ['alta', 'media', 'baixa'] },
          evidencia: { type: 'string', description: 'Trecho curto da fala que originou a demanda' },
          horario: nullableString,
        },
      },
    },
    demandas_de_outros: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['responsavel', 'descricao', 'prazo'],
        properties: {
          responsavel: { type: 'string' },
          descricao: { type: 'string' },
          prazo: nullableString,
        },
      },
    },
  },
};

function instructions(meeting, selfName) {
  const weekday = meeting.isoDate ? new Date(`${meeting.isoDate}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long' }) : '';
  return [
    `Você analisa a transcrição automática de uma reunião do ${selfName}. "${selfName} (eu)" é ele, o dono deste painel.`,
    'A transcrição vem de reconhecimento de fala: tem erros, frases cortadas e repetições. Interprete pelo contexto e não copie os erros.',
    `Data da reunião: ${meeting.isoDate} (${weekday}), das ${meeting.start || '?'} às ${meeting.end || '?'}. Participantes: ${meeting.participants.join(', ')}.`,
    '',
    'Gere:',
    '- titulo, tipo e um resumo objetivo em português do que foi a call;',
    '- topicos e decisoes realmente tomadas;',
    `- minhas_demandas: SÓ o que ficou para o ${selfName} fazer — algo que ele se comprometeu ("vou fazer", "deixa comigo", "te mando") ou que pediram diretamente a ele. Uma demanda por ação, sem duplicar, escrita no infinitivo e sem citar o ${selfName} em terceira pessoa (ex.: "Enviar o review da PR 1587 ao Mateus", nunca "ele deve..."). Converta prazos relativos ("amanhã", "sexta") em datas AAAA-MM-DD a partir da data da reunião. Prioridade alta se tiver prazo curto ou bloquear alguém;`,
    '- demandas_de_outros: o que outras pessoas ficaram de fazer (principalmente se for entregar algo ao Gabriel).',
    'Não invente demandas. Conversa informal, papo ou teste sem conteúdo de trabalho: relevante=false e listas vazias.',
    '',
    'TRANSCRIÇÃO:',
  ].join('\n');
}

class MeetingsService {
  constructor({ store, usage, getConfig, emit, notify }) {
    this.store = store; // JsonStore { meetings: {}, tasks: [] }
    this.usage = usage;
    this.getConfig = getConfig;
    this.emit = emit;
    this.notify = notify || (() => {});
    this.queue = [];
    this.busy = false;
    this.watcher = null;
    this.timers = new Map();
    this.scanTimer = null;
    if (!this.store.data.meetings) this.store.data.meetings = {};
    if (!this.store.data.tasks) this.store.data.tasks = [];
  }

  get cfg() {
    return this.getConfig().meetings;
  }

  start() {
    this.stop();
    const dir = this.cfg.folder;
    if (!this.cfg.enabled || !dir || !fs.existsSync(dir)) return;
    try {
      this.watcher = fs.watch(dir, { recursive: true }, (_ev, name) => {
        if (name && name.toLowerCase().endsWith('.md')) this.#debounceScan();
      });
      this.watcher.on('error', () => {});
    } catch {
      /* sem watch: o scan periódico cobre */
    }
    // Rede de segurança: o watch do Windows às vezes perde eventos.
    this.scanTimer = setInterval(() => this.scan(), 2 * 60 * 1000);
    this.scan();
  }

  stop() {
    this.watcher?.close();
    this.watcher = null;
    clearInterval(this.scanTimer);
  }

  #debounceScan() {
    clearTimeout(this.timers.get('scan'));
    this.timers.set('scan', setTimeout(() => this.scan(), 5000));
  }

  #listFiles() {
    const out = [];
    const walk = (d, depth) => {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory() && depth < 4) walk(p, depth + 1);
        else if (e.isFile() && /^meet-.*\.md$/i.test(e.name)) out.push(p);
      }
    };
    walk(this.cfg.folder, 0);
    return out;
  }

  // Descobre reuniões novas ou que ganharam partes novas.
  scan() {
    if (!this.cfg.enabled) return;
    const groups = {};
    for (const f of this.#listFiles()) {
      const info = meetingKeyFromFile(f);
      if (!info) continue;
      const st = fs.statSync(f);
      (groups[info.key] ||= { ...info, files: [] }).files.push({ path: f, mtime: st.mtimeMs, size: st.size });
    }

    const now = Date.now();
    const stableMs = (this.cfg.stableSeconds ?? 30) * 1000;
    const cutoff = this.cfg.ignoreBefore ? new Date(`${this.cfg.ignoreBefore}T00:00:00`).getTime() : 0;
    let changed = false;

    for (const g of Object.values(groups)) {
      const m = this.store.data.meetings[g.key];
      const sig = g.files.map((f) => `${f.path}|${f.size}|${Math.round(f.mtime)}`).sort().join(';');
      if (m && m.signature === sig) continue;
      const newest = Math.max(...g.files.map((f) => f.mtime));
      if (now - newest < stableMs) {
        // Ainda sendo gravado: tenta de novo depois.
        clearTimeout(this.timers.get(g.key));
        this.timers.set(g.key, setTimeout(() => this.scan(), stableMs - (now - newest) + 1000));
        continue;
      }
      const meeting = m || { key: g.key, code: g.code, isoDate: g.date, createdAt: now };
      meeting.files = g.files.map((f) => f.path).sort();
      meeting.signature = sig;
      meeting.endedAt = newest;
      // Registra antes de enfileirar: a fila pode começar a processar na hora.
      this.store.data.meetings[g.key] = meeting;
      if (cutoff && newest < cutoff) {
        meeting.status = 'ignorada';
        meeting.reason = 'anterior à ativação do painel';
      } else {
        meeting.status = 'na fila';
        this.#enqueue(g.key);
      }
      changed = true;
    }
    if (changed) {
      this.store.save();
      this.emit('meetings:update', this.snapshot());
    }
  }

  reprocess(key) {
    const m = this.store.data.meetings[key];
    if (!m) return;
    m.status = 'na fila';
    m.force = true;
    this.#enqueue(key);
    this.emit('meetings:update', this.snapshot());
  }

  #enqueue(key) {
    if (!this.queue.includes(key)) this.queue.push(key);
    this.#pump();
  }

  async #pump() {
    if (this.busy) return;
    const key = this.queue.shift();
    if (!key) return;
    this.busy = true;
    try {
      await this.#process(key);
    } catch (err) {
      const m = this.store.data.meetings[key];
      if (m) {
        m.status = 'erro';
        m.reason = shorten(err.message, 300);
      }
    } finally {
      this.busy = false;
      this.store.save();
      this.emit('meetings:update', this.snapshot());
      this.#pump();
    }
  }

  async #process(key) {
    const config = this.getConfig();
    const m = this.store.data.meetings[key];
    const selfName = this.cfg.selfName;
    const data = loadMeeting(m.files, { selfName });
    Object.assign(m, {
      start: data.start,
      end: data.end,
      durationMin: data.durationMin,
      participants: data.participants,
      falas: data.count,
    });

    // Filtro barato antes de gastar token.
    const minFalas = this.cfg.minUtterances ?? 15;
    if (!m.force && (data.count < minFalas || data.speakers < 2)) {
      m.status = 'ignorada';
      m.reason = data.speakers < 2 ? 'só uma pessoa falando' : `curta demais (${data.count} falas)`;
      return;
    }
    delete m.force;

    m.status = 'processando';
    this.emit('meetings:update', this.snapshot());

    const prompt = `${instructions({ ...data, isoDate: m.isoDate }, selfName)}\n${data.text}`;
    const result = await this.#analyze(prompt, config);

    m.analysis = result.data;
    m.title = result.data.titulo || m.title;
    m.provider = result.provider;
    m.model = result.model;
    m.tokens = result.tokens;
    m.processedAt = Date.now();
    m.status = result.data.relevante === false ? 'sem demandas' : 'pronta';
    m.reason = null;
    this.usage.record(result.provider, result.model, result.tokens);

    const added = this.#mergeTasks(m, result.data.minhas_demandas || []);
    this.emit('usage:update', this.usage.summary());
    if (added > 0 || result.data.relevante !== false) {
      this.notify(
        `Reunião resumida: ${m.title}`,
        added ? `${added} demanda${added > 1 ? 's' : ''} nova${added > 1 ? 's' : ''} para você` : 'Nenhuma demanda para você',
      );
    }
  }

  // Substitui as demandas antigas da reunião que você ainda não mexeu.
  #mergeTasks(m, demandas) {
    const tasks = this.store.data.tasks;
    const keep = tasks.filter((t) => t.meetingKey !== m.key || t.touched || t.status !== 'todo');
    const keepNorm = new Set(keep.filter((t) => t.meetingKey === m.key).map((t) => normText(t.text)));
    let added = 0;
    for (const d of demandas) {
      if (!d?.descricao || keepNorm.has(normText(d.descricao))) continue;
      keep.push({
        id: crypto.randomUUID(),
        meetingKey: m.key,
        text: d.descricao,
        requestedBy: d.pedido_por || null,
        deadline: /^\d{4}-\d{2}-\d{2}$/.test(d.prazo || '') ? d.prazo : null,
        priority: ['alta', 'media', 'baixa'].includes(d.prioridade) ? d.prioridade : 'media',
        evidence: d.evidencia || '',
        time: d.horario || null,
        status: 'todo',
        touched: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      added++;
    }
    this.store.data.tasks = keep;
    return added;
  }

  async #analyze(prompt, config) {
    const lim = this.usage.limits();
    const claudeUtil = Math.max(lim.claude?.fiveHour ?? 0, lim.claude?.weekly ?? 0);
    const useCodex =
      this.cfg.provider === 'codex' ||
      (this.cfg.provider !== 'claude' && (lim.claude?.status === 'rejected' || claudeUtil >= config.quota.claudeAvoidAt));
    return useCodex ? this.#analyzeCodex(prompt, config) : this.#analyzeClaude(prompt, config);
  }

  async #analyzeClaude(prompt, config) {
    const model = this.cfg.model || config.claude.models.equilibrado;
    let out = null;
    let usage = {};
    let resolvedModel = model;
    let error = null;
    const { code, stderr } = await runJsonl({
      cmd: config.claude.bin,
      args: [
        '-p', '--output-format', 'stream-json', '--verbose',
        '--model', model, '--effort', this.cfg.effort || 'medium',
        '--tools', '', '--no-session-persistence', '--disable-slash-commands',
        '--json-schema', JSON.stringify(SCHEMA),
      ],
      cwd: os.tmpdir(),
      input: prompt,
      onJson: (ev) => {
        if (ev.type === 'system' && ev.subtype === 'init' && ev.model) resolvedModel = ev.model;
        if (ev.type === 'rate_limit_event') this.usage.updateClaudeLimits(ev.rate_limit_info);
        if (ev.type === 'result') {
          usage = ev.usage || {};
          if (ev.is_error) error = ev.result || ev.subtype;
          out = ev.structured_output || tryJson(ev.result);
        }
      },
    });
    if (!out) throw new Error(error || shorten(stderr, 300) || `claude saiu com código ${code}`);
    return {
      provider: 'claude',
      model: resolvedModel,
      data: out,
      tokens: {
        input: (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
        cached: usage.cache_read_input_tokens || 0,
        output: usage.output_tokens || 0,
      },
    };
  }

  async #analyzeCodex(prompt, config) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'central-ia-'));
    const schemaFile = path.join(tmp, 'schema.json');
    const outFile = path.join(tmp, 'saida.json');
    fs.writeFileSync(schemaFile, JSON.stringify(SCHEMA));
    const { cmd, pre } = resolveCodex(config);
    let usage = {};
    try {
      const args = [...pre, 'exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', tmp,
        '--output-schema', schemaFile, '-o', outFile, '-c', 'model_reasoning_effort="low"'];
      if (config.codex.model) args.push('-m', config.codex.model);
      args.push('-');
      const { code, stderr } = await runJsonl({
        cmd, args, cwd: tmp, input: prompt,
        onJson: (ev) => { if (ev.type === 'turn.completed') usage = ev.usage || {}; },
      });
      const data = fs.existsSync(outFile) ? tryJson(fs.readFileSync(outFile, 'utf8')) : null;
      if (!data) throw new Error(shorten(stderr, 300) || `codex saiu com código ${code}`);
      this.usage.refreshCodexLimits();
      const cached = usage.cached_input_tokens || 0;
      return {
        provider: 'codex',
        model: config.codex.model || 'padrão do Codex',
        data,
        tokens: { input: Math.max(0, (usage.input_tokens || 0) - cached), cached, output: (usage.output_tokens || 0) + (usage.reasoning_output_tokens || 0) },
      };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ---- Painel ----
  snapshot() {
    const meetings = Object.values(this.store.data.meetings)
      .map(({ signature, analysis, ...m }) => ({
        ...m,
        summary: analysis
          ? { resumo: analysis.resumo, tipo: analysis.tipo, topicos: analysis.topicos, decisoes: analysis.decisoes, outros: analysis.demandas_de_outros }
          : null,
      }))
      .sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    return { meetings, tasks: this.store.data.tasks, busy: this.busy, queue: this.queue.length, enabled: this.cfg.enabled, folder: this.cfg.folder };
  }

  updateTask(id, patch) {
    const t = this.store.data.tasks.find((x) => x.id === id);
    if (!t) return null;
    for (const k of ['status', 'text', 'deadline', 'priority']) if (k in patch) t[k] = patch[k];
    t.touched = true;
    t.updatedAt = Date.now();
    if (patch.status === 'done') t.doneAt = Date.now();
    this.store.save();
    this.emit('meetings:update', this.snapshot());
    return t;
  }

  addTask({ text, deadline = null, priority = 'media' }) {
    const t = { id: crypto.randomUUID(), meetingKey: null, text, deadline, priority, evidence: '', status: 'todo', touched: true, createdAt: Date.now(), updatedAt: Date.now() };
    this.store.data.tasks.push(t);
    this.store.save();
    this.emit('meetings:update', this.snapshot());
    return t;
  }

  deleteTask(id) {
    this.store.data.tasks = this.store.data.tasks.filter((t) => t.id !== id);
    this.store.save();
    this.emit('meetings:update', this.snapshot());
  }
}

function normText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w ]/g, '').replace(/\s+/g, ' ').trim();
}

function tryJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(String(s).replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return null;
  }
}

module.exports = { MeetingsService, SCHEMA };
