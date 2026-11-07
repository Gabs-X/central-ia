// Inteligência sobre as reuniões: busca, pessoas, briefings, cobranças, pauta e exportação.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { askOnce } = require('./ai');
const { normalize } = require('./router');

const STOP = new Set(
  'que para com uma por mais como quando onde qual quais sobre isso essa esse esta este ele ela eles elas voce voces nos nossa nosso foi era sao ser ter tem tinha the and dos das nas nos uns umas pelo pela pelos pelas entre ate depois antes ainda tambem muito pouco ja nao sim aqui ali mim meu minha falou falamos disse reuniao call'.split(' '),
);

function ymd(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const addDays = (iso, n) => ymd(new Date(new Date(`${iso}T12:00:00`).getTime() + n * 864e5));
const br = (iso) => (iso ? iso.split('-').reverse().slice(0, 2).join('/') : '');
const toMin = (hms) => (hms ? Number(hms.slice(0, 2)) * 60 + Number(hms.slice(3, 5)) : null);

function terms(text) {
  return [...new Set(normalize(text).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
}

// Nome canônico: junta "Sanderlan Jales" e "Sanderlan Jales Pontes".
function personKey(name) {
  return normalize(name).trim().split(' ').slice(0, 2).join(' ');
}
const isSelfOrBot = (name) => /\(eu\)$/.test(name) || /^apresenta[cç][aã]o de /i.test(name);

class Insights {
  constructor({ meetings, store, usage, getConfig, emit, notify, calendar }) {
    this.meetings = meetings; // MeetingsService
    this.store = store; // JsonStore { briefings: [], prepNotified: {}, nudges: {} }
    this.usage = usage;
    this.getConfig = getConfig;
    this.emit = emit;
    this.notify = notify;
    this.calendar = calendar;
    if (!this.store.data.briefings) this.store.data.briefings = [];
    if (!this.store.data.prepNotified) this.store.data.prepNotified = {};
  }

  get data() {
    return this.meetings.store.data;
  }

  processed() {
    return this.meetings.meetingsRaw().filter((m) => m.analysis);
  }

  // ---------- Busca ----------
  async search(question) {
    const config = this.getConfig();
    const qTerms = terms(question);
    const stems = qTerms.map((t) => t.slice(0, Math.max(4, Math.min(6, t.length))));
    const meetings = this.processed().sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    const chunks = [];

    for (const m of meetings) {
      const lines = this.meetings.transcriptText(m.key).split('\n');
      const meta = normalize(`${m.title} ${(m.participants || []).join(' ')} ${m.analysis?.resumo || ''} ${(m.analysis?.topicos || []).join(' ')}`);
      const metaHits = stems.filter((s) => meta.includes(s)).length;
      for (let i = 0; i < lines.length; i += 25) {
        const piece = lines.slice(Math.max(0, i - 3), i + 28).join('\n');
        const low = normalize(piece);
        let score = 0;
        for (const s of stems) {
          const n = low.split(s).length - 1;
          if (n) score += 1 + Math.min(n, 5) * 0.3;
        }
        if (score > 0) chunks.push({ m, piece, score: score + metaHits * 0.5 });
      }
    }
    chunks.sort((a, b) => b.score - a.score);

    let budget = 26000;
    const picked = [];
    for (const c of chunks) {
      if (budget - c.piece.length < 0) continue;
      picked.push(c);
      budget -= c.piece.length;
      if (picked.length >= 14) break;
    }

    const catalog = meetings
      .slice(0, 60)
      .map((m) => `- [${m.key}] ${br(m.isoDate)} ${m.start?.slice(0, 5) || ''} "${m.title}" (${(m.participants || []).join(', ')}): ${m.analysis.resumo}`)
      .join('\n');
    const excerpts = picked
      .map((c) => `### [${c.m.key}] "${c.m.title}" — ${br(c.m.isoDate)}\n${c.piece}`)
      .join('\n\n');

    const prompt = [
      `Você responde perguntas do ${config.meetings.selfName} sobre as reuniões dele, usando SÓ o material abaixo.`,
      'As transcrições vêm de reconhecimento de fala e têm erros: interprete pelo contexto.',
      'Responda em português, direto, e cite a origem de cada afirmação no formato (Título · dd/mm hh:mm).',
      'Se o material não responder, diga isso claramente em vez de inventar.',
      '',
      `PERGUNTA: ${question}`,
      '',
      'CATÁLOGO DE REUNIÕES (resumos):',
      catalog || '(nenhuma reunião processada)',
      '',
      'TRECHOS MAIS RELEVANTES DAS TRANSCRIÇÕES:',
      excerpts || '(nenhum trecho encontrado pelas palavras da pergunta)',
    ].join('\n');

    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['resposta', 'fontes'],
      properties: {
        resposta: { type: 'string', description: 'Resposta em Markdown' },
        fontes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['reuniao', 'horario', 'trecho'],
            properties: { reuniao: { type: 'string', description: 'chave entre colchetes, ex.: 2026-11-05_meetabc' }, horario: { type: ['string', 'null'] }, trecho: { type: 'string' } },
          },
        },
      },
    };
    const r = await askOnce({ feature: 'busca', prompt, schema, config, usage: this.usage });
    this.emit('usage:update', this.usage.summary());
    const fontes = (r.data.fontes || []).map((f) => {
      const m = this.data.meetings[f.reuniao];
      return { ...f, title: m?.title || f.reuniao, date: m?.isoDate || null, exists: !!m };
    });
    return { answer: r.data.resposta, sources: fontes, model: r.model, scanned: meetings.length, excerpts: picked.length };
  }

  // ---------- Pessoas ----------
  people() {
    const map = new Map();
    const get = (name) => {
      const k = personKey(name);
      if (!map.has(k)) map.set(k, { key: k, name, meetings: [], tasks: [], waiting: [] });
      const p = map.get(k);
      if (name.length > p.name.length) p.name = name; // fica com o nome mais completo
      return p;
    };
    for (const m of this.meetings.meetingsRaw()) {
      if (m.status === 'ignorada') continue;
      for (const n of m.participants || []) if (!isSelfOrBot(n)) get(n).meetings.push(m.key);
    }
    for (const t of this.data.tasks) if (t.requestedBy && !isSelfOrBot(t.requestedBy)) get(t.requestedBy).tasks.push(t.id);
    for (const w of this.data.waiting) if (w.person) get(w.person).waiting.push(w.id);

    return [...map.values()]
      .map((p) => {
        const ms = p.meetings.map((k) => this.data.meetings[k]).filter(Boolean).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
        return {
          key: p.key,
          name: p.name,
          meetingCount: ms.length,
          lastMeeting: ms[0] ? { key: ms[0].key, title: ms[0].title, date: ms[0].isoDate } : null,
          recent: ms.slice(0, 5).map((m) => ({ key: m.key, title: m.title, date: m.isoDate, resumo: m.analysis?.resumo || '' })),
          openTasks: p.tasks.filter((id) => this.data.tasks.find((t) => t.id === id)?.status !== 'done'),
          allTasks: p.tasks,
          openWaiting: p.waiting.filter((id) => {
            const w = this.data.waiting.find((x) => x.id === id);
            return w?.status === 'open' && w.forMe !== false;
          }),
          allWaiting: p.waiting,
        };
      })
      .sort((a, b) => b.openWaiting.length + b.openTasks.length - (a.openWaiting.length + a.openTasks.length) || b.meetingCount - a.meetingCount);
  }

  // ---------- Cobranças ----------
  overdueWaiting(today = ymd()) {
    return this.data.waiting.filter((w) => w.status === 'open' && w.forMe !== false && w.deadline && w.deadline < today);
  }

  // Itens antigos sem a marca "para mim": classifica de uma vez com o modelo rápido.
  async classifyWaiting() {
    const pending = this.data.waiting.filter((w) => w.forMe === undefined);
    if (!pending.length) return 0;
    const config = this.getConfig();
    const self = config.meetings.selfName;
    const lines = pending.map((w) => {
      const m = this.data.meetings[w.meetingKey];
      return `- id=${w.id} | reunião "${m?.title || '?'}" (${m?.analysis?.tipo || '?'}) | ${w.person}: ${w.text}`;
    });
    const prompt = [
      `Para cada combinado abaixo, diga se é algo que a outra pessoa deve entregar ao ${self} ou de que ele depende (para_mim=true),`,
      `ou se é só tarefa da própria pessoa sem relação direta com ele (para_mim=false). Ex.: tarefas de um mentorado no projeto dele = false.`,
      '',
      ...lines,
    ].join('\n');
    const schema = {
      type: 'object', additionalProperties: false, required: ['itens'],
      properties: { itens: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'para_mim'], properties: { id: { type: 'string' }, para_mim: { type: 'boolean' } } } } },
    };
    const r = await askOnce({ feature: 'briefing', prompt, schema, config, usage: this.usage });
    const map = new Map((r.data.itens || []).map((i) => [i.id, i.para_mim]));
    for (const w of pending) if (map.has(w.id)) w.forMe = map.get(w.id);
    this.meetings.store.save();
    this.emit('meetings:update', this.meetings.snapshot());
    return map.size;
  }

  checkFollowups() {
    const today = ymd();
    const due = this.overdueWaiting(today).filter((w) => !w.lastAlertDay || w.lastAlertDay !== today);
    if (!due.length) return 0;
    for (const w of due) w.lastAlertDay = today;
    this.meetings.store.save();
    const people = [...new Set(due.map((w) => w.person.split(' ')[0]))];
    this.notify(
      `${due.length} entrega${due.length > 1 ? 's' : ''} atrasada${due.length > 1 ? 's' : ''} para você`,
      `Aguardando ${people.slice(0, 4).join(', ')}${people.length > 4 ? '…' : ''}. Abra para gerar a cobrança.`,
      'today',
    );
    return due.length;
  }

  async nudgeMessage(waitingId) {
    const config = this.getConfig();
    const w = this.data.waiting.find((x) => x.id === waitingId);
    if (!w) throw new Error('Item não encontrado');
    const m = this.data.meetings[w.meetingKey];
    const prompt = [
      `Escreva uma mensagem curta de Slack, em português informal e simpático, do ${config.meetings.selfName} para ${w.person}, cobrando com educação:`,
      `"${w.text}"${w.deadline ? ` (prazo combinado: ${br(w.deadline)})` : ''}.`,
      m ? `Isso foi combinado na reunião "${m.title}" de ${br(m.isoDate)}.` : '',
      'Sem saudação longa, sem emojis em excesso, no máximo 3 frases. Responda só com a mensagem.',
    ].join('\n');
    const r = await askOnce({ feature: 'cobranca', prompt, config, usage: this.usage });
    this.emit('usage:update', this.usage.summary());
    return { text: String(r.data).trim(), person: w.person };
  }

  // ---------- Briefings ----------
  #snapshotFor(kind) {
    const today = ymd();
    const d = this.data;
    const open = d.tasks.filter((t) => t.status !== 'done');
    const weekStart = addDays(today, -((new Date().getDay() + 6) % 7)); // segunda
    const lastWorkday = (() => {
      let x = addDays(today, -1);
      while ([0, 6].includes(new Date(`${x}T12:00:00`).getDay())) x = addDays(x, -1);
      return x;
    })();
    const ms = this.processed();
    const since = kind === 'weekly' ? weekStart : kind === 'eod' ? today : lastWorkday;
    return {
      today,
      overdue: open.filter((t) => t.deadline && t.deadline < today),
      dueToday: open.filter((t) => t.deadline === today),
      dueSoon: open.filter((t) => t.deadline && t.deadline > today && t.deadline <= addDays(today, 3)),
      doing: open.filter((t) => t.status === 'doing'),
      noDeadline: open.filter((t) => !t.deadline),
      waitingOverdue: this.overdueWaiting(today),
      waitingOpen: d.waiting.filter((w) => w.status === 'open' && w.forMe !== false),
      meetings: ms.filter((m) => m.isoDate >= since && (kind !== 'daily' || m.isoDate < today || true)).sort((a, b) => a.endedAt - b.endedAt),
      doneInPeriod: d.tasks.filter((t) => t.status === 'done' && t.doneAt && ymd(new Date(t.doneAt)) >= since),
      createdInPeriod: d.tasks.filter((t) => ymd(new Date(t.createdAt)) >= since),
      since,
    };
  }

  async briefing(kind = 'daily') {
    const config = this.getConfig();
    const s = this.#snapshotFor(kind);
    const fmtT = (t) => `- ${t.text}${t.deadline ? ` (prazo ${br(t.deadline)})` : ''}${t.requestedBy ? ` — pedido por ${t.requestedBy}` : ''} [${t.status === 'doing' ? 'em andamento' : t.status === 'done' ? 'feito' : 'a fazer'}]`;
    const fmtW = (w) => `- ${w.person}: ${w.text}${w.deadline ? ` (prazo ${br(w.deadline)})` : ''}`;
    const fmtM = (m) => `- ${br(m.isoDate)} ${m.start?.slice(0, 5) || ''} "${m.title}": ${m.analysis.resumo}${m.analysis.decisoes?.length ? ` Decisões: ${m.analysis.decisoes.join('; ')}` : ''}`;

    const goal = {
      daily: 'um briefing da manhã: o que priorizar hoje, o que está atrasado, o que cobrar de outras pessoas e um parágrafo pronto para ele falar na daily (o que fez no último dia útil, o que vai fazer hoje, impedimentos).',
      weekly: 'um resumo da semana: principais assuntos e decisões, o que ele entregou, o que ficou aberto para a próxima semana e cobranças pendentes.',
      eod: 'um fechamento do dia: o que avançou hoje, o que ficou pendente e o que deixar preparado para amanhã.',
    }[kind];

    const prompt = [
      `Escreva para o ${config.meetings.selfName}, em português, ${goal}`,
      'Use Markdown com títulos curtos (###) e listas. Seja objetivo; não invente nada além dos dados.',
      `Hoje é ${br(s.today)} (${new Date().toLocaleDateString('pt-BR', { weekday: 'long' })}).`,
      '',
      `ATRASADAS:\n${s.overdue.map(fmtT).join('\n') || '(nenhuma)'}`,
      `VENCEM HOJE:\n${s.dueToday.map(fmtT).join('\n') || '(nenhuma)'}`,
      `PRÓXIMOS 3 DIAS:\n${s.dueSoon.map(fmtT).join('\n') || '(nenhuma)'}`,
      `EM ANDAMENTO:\n${s.doing.map(fmtT).join('\n') || '(nenhuma)'}`,
      `SEM PRAZO (abertas):\n${s.noDeadline.slice(0, 15).map(fmtT).join('\n') || '(nenhuma)'}`,
      `CONCLUÍDAS NO PERÍODO:\n${s.doneInPeriod.map(fmtT).join('\n') || '(nenhuma)'}`,
      `AGUARDANDO OUTROS (atrasadas primeiro):\n${[...s.waitingOverdue, ...s.waitingOpen.filter((w) => !s.waitingOverdue.includes(w))].slice(0, 15).map(fmtW).join('\n') || '(nada)'}`,
      `REUNIÕES DESDE ${br(s.since)}:\n${s.meetings.map(fmtM).join('\n') || '(nenhuma)'}`,
    ].join('\n\n');

    const r = await askOnce({ feature: 'briefing', prompt, config, usage: this.usage });
    const b = {
      id: crypto.randomUUID(),
      kind,
      at: Date.now(),
      text: String(r.data).trim(),
      model: r.model,
      stats: { overdue: s.overdue.length, dueToday: s.dueToday.length, waitingOverdue: s.waitingOverdue.length, meetings: s.meetings.length },
    };
    this.store.data.briefings.unshift(b);
    this.store.data.briefings = this.store.data.briefings.slice(0, 60);
    this.store.save();
    this.emit('briefing:new', b);
    this.emit('usage:update', this.usage.summary());
    const label = { daily: 'Briefing da manhã', weekly: 'Resumo da semana', eod: 'Fechamento do dia' }[kind];
    this.notify(label, `${s.overdue.length} atrasada(s), ${s.dueToday.length} para hoje, ${s.waitingOverdue.length} cobrança(s).`, 'today');
    return b;
  }

  briefings() {
    return this.store.data.briefings;
  }

  // Painel "Hoje" sem IA (instantâneo).
  todayBoard() {
    const s = this.#snapshotFor('daily');
    return {
      today: s.today,
      overdue: s.overdue,
      dueToday: s.dueToday,
      dueSoon: s.dueSoon,
      doing: s.doing,
      waitingOverdue: s.waitingOverdue,
      waitingOpen: s.waitingOpen,
      recentMeetings: s.meetings.slice(-6).reverse().map((m) => ({ key: m.key, title: m.title, date: m.isoDate, start: m.start })),
      upcoming: this.upcoming(),
      lastBriefing: this.store.data.briefings[0] || null,
    };
  }

  // ---------- Pauta antes da call ----------
  // Reuniões recorrentes: mesmo código do Meet em dias diferentes.
  recurring() {
    const byCode = {};
    for (const m of this.meetings.meetingsRaw()) {
      if (!m.start) continue;
      (byCode[m.code] ||= []).push(m);
    }
    const out = [];
    for (const [code, list] of Object.entries(byCode)) {
      const days = [...new Set(list.map((m) => m.isoDate))];
      if (days.length < 2) continue;
      const mins = list.map((m) => toMin(m.start)).sort((a, b) => a - b);
      const median = mins[Math.floor(mins.length / 2)];
      const weekdays = [...new Set(days.map((d) => new Date(`${d}T12:00:00`).getDay()))];
      const last = list.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))[0];
      out.push({ code, title: last.title || code, minutes: median, weekdays, participants: [...new Set(list.flatMap((m) => m.participants || []))], keys: list.map((m) => m.key) });
    }
    return out;
  }

  // Próximas reuniões de hoje (agenda + padrão das recorrentes).
  upcoming() {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const today = ymd(now);
    const items = [];
    const calEvents = this.calendar?.eventsToday() || [];
    const calCodes = new Set(calEvents.map((e) => e.meetCode).filter(Boolean));
    for (const e of calEvents) {
      const startMin = e.start.getHours() * 60 + e.start.getMinutes();
      if (startMin + 5 < nowMin) continue;
      items.push({ id: `cal:${e.uid}:${today}`, title: e.summary, minutes: startMin, source: 'agenda', code: e.meetCode, attendees: e.attendees || [] });
    }
    // Recorrentes sem evento na agenda: usa o horário de costume, se for dia útil comum.
    const weekday = now.getDay();
    for (const r of this.recurring()) {
      if (calCodes.has(r.code)) continue;
      const usual = r.weekdays.includes(weekday) || (r.weekdays.every((d) => d >= 1 && d <= 5) && weekday >= 1 && weekday <= 5);
      if (!usual || r.minutes + 5 < nowMin) continue;
      const happened = this.meetings.meetingsRaw().some((m) => m.code === r.code && m.isoDate === today);
      if (happened) continue;
      items.push({ id: `rec:${r.code}:${today}`, title: r.title, minutes: r.minutes, source: 'recorrente', code: r.code, attendees: r.participants });
    }
    return items.sort((a, b) => a.minutes - b.minutes).map((i) => ({ ...i, time: `${String(Math.floor(i.minutes / 60)).padStart(2, '0')}:${String(i.minutes % 60).padStart(2, '0')}`, prep: this.prep(i) }));
  }

  // Pauta: pendências ligadas às pessoas/reunião.
  prep(item) {
    const keys = new Set(item.attendees.filter((n) => !isSelfOrBot(n)).map(personKey));
    const codeMeetings = this.meetings.meetingsRaw().filter((m) => item.code && m.code === item.code && m.analysis).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
    const codeKeys = new Set(codeMeetings.map((m) => m.key));
    const tasks = this.data.tasks.filter((t) => t.status !== 'done' && (codeKeys.has(t.meetingKey) || (t.requestedBy && keys.has(personKey(t.requestedBy)))));
    const waiting = this.data.waiting.filter((w) => w.status === 'open' && w.forMe !== false && (codeKeys.has(w.meetingKey) || keys.has(personKey(w.person))));
    const last = codeMeetings[0];
    return {
      tasks: tasks.map((t) => t.id),
      waiting: waiting.map((w) => w.id),
      last: last ? { key: last.key, title: last.title, date: last.isoDate, resumo: last.analysis.resumo } : null,
    };
  }

  checkPrep() {
    const lead = this.getConfig().meetings.prepMinutes ?? 5;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    for (const u of this.upcoming()) {
      const diff = u.minutes - nowMin;
      if (diff < 0 || diff > lead || this.store.data.prepNotified[u.id]) continue;
      this.store.data.prepNotified[u.id] = Date.now();
      const n = u.prep.tasks.length + u.prep.waiting.length;
      this.notify(`${u.title} às ${u.time}`, n ? `${u.prep.tasks.length} pendência(s) suas e ${u.prep.waiting.length} cobrança(s) com essas pessoas.` : 'Nenhuma pendência com essas pessoas.', 'today');
    }
    // Limpa marcas antigas.
    for (const [k, t] of Object.entries(this.store.data.prepNotified)) if (Date.now() - t > 3 * 864e5) delete this.store.data.prepNotified[k];
    this.store.save();
  }

  // ---------- Exportar ----------
  markdown(key) {
    const m = this.data.meetings[key];
    if (!m) throw new Error('Reunião não encontrada');
    const a = m.analysis || {};
    const tasks = this.data.tasks.filter((t) => t.meetingKey === key);
    const waiting = this.data.waiting.filter((w) => w.meetingKey === key);
    const lines = [
      `# ${m.title || m.code}`,
      '',
      `**Data:** ${br(m.isoDate)}/${m.isoDate?.slice(0, 4)} · ${m.start?.slice(0, 5) || '?'}–${m.end?.slice(0, 5) || '?'}${m.durationMin != null ? ` (${m.durationMin} min)` : ''}  `,
      `**Participantes:** ${(m.participants || []).join(', ')}`,
      '',
      '## Resumo',
      a.resumo || '',
      '',
      '## Tópicos',
      ...(a.topicos?.length ? a.topicos.map((t) => `- ${t}`) : ['- Nenhum']),
      '',
      '## Decisões',
      ...(a.decisoes?.length ? a.decisoes.map((t) => `- ${t}`) : ['- Nenhuma']),
      '',
      '## Minhas demandas',
      ...(tasks.length ? tasks.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] ${t.text}${t.deadline ? ` (até ${br(t.deadline)})` : ''}`) : ['- Nenhuma']),
      '',
      '## Combinados com outras pessoas',
      ...(waiting.length ? waiting.map((w) => `- [${w.status === 'done' ? 'x' : ' '}] **${w.person}:** ${w.text}${w.deadline ? ` (até ${br(w.deadline)})` : ''}`) : ['- Nenhum']),
      '',
    ];
    return lines.join('\n');
  }

  saveMarkdown(key) {
    const m = this.data.meetings[key];
    const dir = path.join(this.getConfig().outputDir, 'Reunioes');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(m.title || m.code).replace(/[\\/:*?"<>|]/g, '-').slice(0, 80);
    const file = path.join(dir, `${m.isoDate} - ${safe}.md`);
    fs.writeFileSync(file, this.markdown(key), 'utf8');
    return file;
  }

  mailto(key) {
    const m = this.data.meetings[key];
    const body = this.markdown(key).replace(/\*\*/g, '');
    const subject = `Resumo: ${m.title} (${br(m.isoDate)})`;
    return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.slice(0, 1800))}`;
  }

  // ---------- Demanda → repositório ----------
  suggestRepo(taskId, repos) {
    const t = this.data.tasks.find((x) => x.id === taskId);
    if (!t) return null;
    const m = t.meetingKey ? this.data.meetings[t.meetingKey] : null;
    const hay = normalize(`${t.text} ${t.evidence || ''} ${m?.title || ''} ${(m?.analysis?.topicos || []).join(' ')}`);
    let best = null;
    for (const r of repos) {
      const name = normalize(path.basename(r)).trim();
      const variants = [name, name.replace(/[-_]/g, ' '), name.replace(/[-_]/g, '')];
      const hit = variants.some((v) => v.length >= 4 && hay.includes(v));
      if (hit && (!best || name.length > best.len)) best = { cwd: r, len: name.length };
    }
    const pr = t.text.match(/\bPR\s*#?\s*(\d{2,6})/i)?.[1] || null;
    const wt = t.text.match(/\bWT\s*#?\s*(\d{2,6})/i)?.[1] || null;
    return { cwd: best?.cwd || null, pr, wt };
  }
}

module.exports = { Insights, ymd, personKey };
