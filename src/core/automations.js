// Atalhos de rotina (um clique) e agendamentos (rodam sozinhos com o app na bandeja).
const crypto = require('crypto');
const { ymd } = require('./insights');
const { askOnce, DeferError } = require('./ai');

const WEEKDAYS = [1, 2, 3, 4, 5];

const DEFAULT_ROUTINES = [
  {
    id: 'vagas',
    name: 'Rotina de vagas',
    icon: '💼',
    prompt: '/vagas',
    cwd: 'C:\\Users\\gabri',
    override: 'claude:equilibrado',
  },
  {
    id: 'taverna-lancar',
    name: 'Lançar versão do taverna-bot',
    icon: '🍺',
    prompt:
      'No taverna-bot: veja o que mudou desde a última versão lançada e me mostre um resumo. Antes de lançar, me pergunte se há mais alguma coisa para incluir. Só depois que eu confirmar, rode `npm run lancar`.',
    cwd: 'C:\\repositorios\\Projetos-Pessoais\\taverna-bot',
    override: 'claude:equilibrado',
  },
  {
    id: 'prs-review',
    name: 'Revisar PRs aguardando você',
    icon: '🔀',
    prompt:
      'Liste as PRs abertas em que meu review foi pedido (`gh search prs --review-requested=@me --state=open`) e faça um review resumido de cada uma: riscos, possíveis bugs e sugestões. Não aprove, não comente e não altere nada no GitHub sem eu pedir.',
    cwd: 'C:\\repositorios',
    override: 'claude:equilibrado',
  },
  {
    id: 'repos-status',
    name: 'Status dos repositórios',
    icon: '📦',
    prompt:
      'Para cada repositório git em C:\\repositorios (até 2 níveis de pasta), mostre numa tabela: branch atual, quantos arquivos com mudanças não commitadas e quantos commits não enviados ao remoto. Só leitura: não altere nada.',
    cwd: 'C:\\repositorios',
    override: 'claude:rapido',
  },
];

const DEFAULT_SCHEDULES = [
  { id: 'briefing', name: 'Briefing da manhã', days: WEEKDAYS, times: ['08:30'], action: { type: 'briefing', kind: 'daily' }, enabled: true, catchUp: true },
  { id: 'cobrancas', name: 'Verificar cobranças atrasadas', days: WEEKDAYS, times: ['10:00', '15:00'], action: { type: 'followups' }, enabled: true, catchUp: false },
  { id: 'semana', name: 'Resumo da semana', days: [5], times: ['17:30'], action: { type: 'briefing', kind: 'weekly' }, enabled: true, catchUp: true },
  { id: 'fechamento', name: 'Fechamento do dia', days: WEEKDAYS, times: ['18:00'], action: { type: 'briefing', kind: 'eod' }, enabled: false, catchUp: false },
  { id: 'slack', name: 'Importar menções do Slack', days: WEEKDAYS, times: ['09:00', '13:00', '17:00'], action: { type: 'slackImport' }, enabled: false, catchUp: false },
];

const SLACK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['demandas'],
  properties: {
    demandas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['descricao', 'pedido_por', 'prazo', 'prioridade', 'evidencia', 'ts'],
        properties: {
          descricao: { type: 'string' },
          pedido_por: { type: ['string', 'null'] },
          prazo: { type: ['string', 'null'] },
          prioridade: { type: 'string', enum: ['alta', 'media', 'baixa'] },
          evidencia: { type: 'string' },
          ts: { type: 'string', description: 'ts da mensagem de origem' },
        },
      },
    },
  },
};

class Automations {
  constructor({ store, orchestrator, insights, meetings, slack, usage, getConfig, emit, notify }) {
    Object.assign(this, { store, orchestrator, insights, meetings, slack, usage, getConfig, emit, notify });
    const d = this.store.data;
    if (!d.seeded) {
      d.routines = structuredClone(DEFAULT_ROUTINES);
      d.schedules = structuredClone(DEFAULT_SCHEDULES);
      d.seeded = true;
    }
    d.runs ||= [];
    d.lastRun ||= {};
    d.slackSeen ||= [];
    this.store.save();
    this.timer = null;
  }

  snapshot() {
    const d = this.store.data;
    return { routines: d.routines, schedules: d.schedules, runs: d.runs.slice(0, 30), lastRun: d.lastRun };
  }

  #changed() {
    this.store.save();
    this.emit('automations:update', this.snapshot());
  }

  // ---------- CRUD ----------
  saveRoutine(r) {
    const list = this.store.data.routines;
    const i = list.findIndex((x) => x.id === r.id);
    const clean = { id: r.id || crypto.randomUUID(), name: r.name || 'Rotina', icon: r.icon || '⚡', prompt: r.prompt || '', cwd: r.cwd || this.getConfig().defaultCwd, override: r.override || 'auto' };
    if (i >= 0) list[i] = clean;
    else list.push(clean);
    this.#changed();
    return clean;
  }

  deleteRoutine(id) {
    this.store.data.routines = this.store.data.routines.filter((r) => r.id !== id);
    this.store.data.schedules = this.store.data.schedules.filter((s) => !(s.action.type === 'routine' && s.action.routineId === id));
    this.#changed();
  }

  saveSchedule(s) {
    const list = this.store.data.schedules;
    const i = list.findIndex((x) => x.id === s.id);
    const clean = {
      id: s.id || crypto.randomUUID(),
      name: s.name || 'Agendamento',
      days: (s.days || []).map(Number).filter((n) => n >= 0 && n <= 6),
      times: (s.times || []).filter((t) => /^\d{2}:\d{2}$/.test(t)),
      action: s.action,
      enabled: s.enabled !== false,
      catchUp: !!s.catchUp,
    };
    if (i >= 0) list[i] = clean;
    else list.push(clean);
    this.#changed();
    return clean;
  }

  deleteSchedule(id) {
    this.store.data.schedules = this.store.data.schedules.filter((s) => s.id !== id);
    this.#changed();
  }

  // ---------- Execução ----------
  #log(name, status, detail = '') {
    this.store.data.runs.unshift({ at: Date.now(), name, status, detail: String(detail).slice(0, 300) });
    this.store.data.runs = this.store.data.runs.slice(0, 100);
    this.#changed();
  }

  async runRoutine(id, { background = false } = {}) {
    const r = this.store.data.routines.find((x) => x.id === id);
    if (!r) throw new Error('Rotina não encontrada');
    const chat = this.orchestrator.create(r.cwd, `${r.icon} ${r.name}`);
    this.emit('chats:changed', { openId: background ? null : chat.id });
    this.#log(r.name, 'iniciada');
    // Não espera: a conversa aparece na lista e responde em tempo real.
    this.orchestrator
      .send(chat.id, { text: r.prompt, override: r.override, source: 'routine' })
      .then((msg) => {
        this.#log(r.name, msg.error ? 'erro' : 'concluída', msg.error || '');
        if (background) this.notify(`${r.icon} ${r.name}`, (msg.text || msg.error || 'Concluída').slice(0, 140), 'chat', chat.id);
      })
      .catch((err) => this.#log(r.name, 'erro', err.message));
    return chat.id;
  }

  async runAction(action, label) {
    switch (action.type) {
      case 'routine':
        return this.runRoutine(action.routineId, { background: true });
      case 'briefing':
        return this.insights.briefing(action.kind || 'daily');
      case 'followups':
        return this.insights.checkFollowups();
      case 'slackImport':
        return this.importSlack();
      default:
        throw new Error(`Ação desconhecida: ${action.type} (${label})`);
    }
  }

  async runSchedule(id) {
    const s = this.store.data.schedules.find((x) => x.id === id);
    if (!s) throw new Error('Agendamento não encontrado');
    try {
      const r = await this.runAction(s.action, s.name);
      if (s.action.type !== 'routine') this.#log(s.name, 'concluída', typeof r === 'number' ? `${r} item(ns)` : '');
      return r;
    } catch (err) {
      if (err instanceof DeferError || err.deferred) {
        this.#log(s.name, 'adiada', err.message);
        // Tenta de novo quando a cota renovar.
        setTimeout(() => this.runSchedule(id).catch(() => {}), Math.max(60_000, err.retryAt - Date.now()));
      } else {
        this.#log(s.name, 'erro', err.message);
      }
      throw err;
    }
  }

  // Confere a cada 30 s se algum agendamento venceu.
  start() {
    this.stop();
    const startedAt = new Date();
    const tick = (first = false) => {
      const now = new Date();
      const today = ymd(now);
      const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      for (const s of this.store.data.schedules) {
        if (!s.enabled || !s.days.includes(now.getDay())) continue;
        for (const t of s.times) {
          const key = `${s.id}@${today}@${t}`;
          if (this.store.data.lastRun[key]) continue;
          const due = t === hm;
          // Ao abrir o app depois do horário (PC ligado mais tarde), roda o que perdeu nas últimas 4 h.
          const missed = first && s.catchUp && t < hm && minutesBetween(t, hm) <= 240 && startedAt.getHours() * 60 + startedAt.getMinutes() > toMin(t);
          if (!due && !missed) continue;
          this.store.data.lastRun[key] = Date.now();
          this.runSchedule(s.id).catch(() => {});
        }
      }
      // Limpa marcas com mais de 7 dias.
      for (const k of Object.keys(this.store.data.lastRun)) if (Date.now() - this.store.data.lastRun[k] > 7 * 864e5) delete this.store.data.lastRun[k];
      this.store.save();
    };
    this.timer = setInterval(() => tick(false), 30_000);
    setTimeout(() => tick(true), 15_000); // dá tempo do app carregar
  }

  stop() {
    clearInterval(this.timer);
  }

  // ---------- Slack → demandas ----------
  async importSlack() {
    const config = this.getConfig();
    if (!config.integrations.slack.token) throw new Error('Slack não configurado');
    const since = ymd(new Date(Date.now() - 2 * 864e5));
    const seen = new Set(this.store.data.slackSeen);
    const msgs = (await this.slack.mentionsSince(since)).filter((m) => !seen.has(m.ts));
    if (!msgs.length) return 0;
    const prompt = [
      `Abaixo estão mensagens do Slack que mencionam o ${config.meetings.selfName}. Extraia SÓ pedidos ou tarefas concretas para ele.`,
      'Ignore avisos, agradecimentos e conversas sem ação. Prazos relativos viram AAAA-MM-DD a partir da data de hoje: ' + ymd() + '.',
      '',
      ...msgs.map((m) => `[ts=${m.ts}] #${m.channel} — ${m.user}: ${m.text}`),
    ].join('\n');
    const r = await askOnce({ feature: 'slack', prompt, schema: SLACK_SCHEMA, config, usage: this.usage });
    const byTs = new Map(msgs.map((m) => [m.ts, m]));
    let added = 0;
    for (const d of r.data.demandas || []) {
      const src = byTs.get(d.ts);
      this.meetings.addTask({
        text: d.descricao,
        deadline: /^\d{4}-\d{2}-\d{2}$/.test(d.prazo || '') ? d.prazo : null,
        priority: d.prioridade,
        requestedBy: d.pedido_por,
        evidence: d.evidencia,
        source: 'slack',
        link: src?.permalink || null,
      });
      added++;
    }
    this.store.data.slackSeen = [...seen, ...msgs.map((m) => m.ts)].slice(-2000);
    this.store.save();
    if (added) this.notify('Slack', `${added} demanda(s) nova(s) vinda(s) do Slack`, 'meetings');
    return added;
  }
}

function toMin(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}
function minutesBetween(a, b) {
  return toMin(b) - toMin(a);
}

module.exports = { Automations, DEFAULT_ROUTINES, DEFAULT_SCHEDULES };
