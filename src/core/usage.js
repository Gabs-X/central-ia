// Gestão de tokens e cota das assinaturas.
// - Claude: o CLI emite "rate_limit_event" com o uso real das janelas de 5h e 7 dias.
// - Codex: cada sessão salva em ~/.codex/sessions guarda "rate_limits" (5h e semanal).
const fs = require('fs');
const os = require('os');
const path = require('path');

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function emptyDay() {
  const p = () => ({ calls: 0, input: 0, cached: 0, output: 0, costUsd: 0, byModel: {} });
  return { claude: p(), codex: p() };
}

class UsageTracker {
  constructor(store) {
    this.store = store; // JsonStore { days: {}, limits: { claude, codex } }
    if (!this.store.data.days) this.store.data.days = {};
    if (!this.store.data.limits) this.store.data.limits = { claude: null, codex: null };
  }

  day(key = today()) {
    if (!this.store.data.days[key]) this.store.data.days[key] = emptyDay();
    return this.store.data.days[key];
  }

  record(provider, model, { input = 0, cached = 0, output = 0, costUsd = 0 } = {}) {
    const p = this.day()[provider];
    p.calls += 1;
    p.input += input;
    p.cached += cached;
    p.output += output;
    p.costUsd += costUsd;
    const m = (p.byModel[model] ||= { calls: 0, tokens: 0 });
    m.calls += 1;
    m.tokens += input + cached + output;
    this.store.save();
  }

  // Evento "rate_limit_event" do Claude Code.
  updateClaudeLimits(info) {
    if (!info) return;
    const w = info.unifiedWindows || {};
    this.store.data.limits.claude = {
      status: info.status,
      fiveHour: w.five_hour?.utilization ?? null,
      fiveHourResetsAt: w.five_hour?.resetsAt ?? info.resetsAt ?? null,
      weekly: w.seven_day?.utilization ?? null,
      weeklyResetsAt: w.seven_day?.resetsAt ?? null,
      updatedAt: Date.now(),
    };
    this.store.save();
  }

  // Lê o "rate_limits" mais recente das sessões do Codex.
  refreshCodexLimits() {
    const file = latestCodexSession();
    if (!file) return this.store.data.limits.codex;
    try {
      const text = readTail(file, 256 * 1024);
      const lines = text.split('\n').reverse();
      for (const line of lines) {
        if (!line.includes('"rate_limits"')) continue;
        const obj = JSON.parse(line);
        const rl = findKey(obj, 'rate_limits');
        if (!rl?.primary) continue;
        this.store.data.limits.codex = {
          status: rl.primary.used_percent >= 100 ? 'rejected' : 'allowed',
          fiveHour: rl.primary.used_percent / 100,
          fiveHourResetsAt: rl.primary.resets_at ?? null,
          weekly: rl.secondary ? rl.secondary.used_percent / 100 : null,
          weeklyResetsAt: rl.secondary?.resets_at ?? null,
          updatedAt: Date.now(),
        };
        this.store.save();
        break;
      }
    } catch {
      /* sessão em escrita ou formato inesperado: mantém o último valor */
    }
    return this.store.data.limits.codex;
  }

  limits() {
    const l = this.store.data.limits;
    // Se a janela já reiniciou, zera o valor exibido.
    const now = Date.now() / 1000;
    const fix = (x) => {
      if (!x) return x;
      const y = { ...x };
      if (y.fiveHourResetsAt && now > y.fiveHourResetsAt) y.fiveHour = 0;
      if (y.weeklyResetsAt && now > y.weeklyResetsAt) y.weekly = 0;
      return y;
    };
    return { claude: fix(l.claude), codex: fix(l.codex) };
  }

  summary() {
    const days = this.store.data.days;
    const keys = Object.keys(days).sort().slice(-7);
    return { today: this.day(), last7: keys.map((k) => ({ date: k, ...days[k] })), limits: this.limits() };
  }
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function latestCodexSession() {
  const root = path.join(codexHome(), 'sessions');
  let best = null;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // As pastas são ano/mês/dia: basta olhar as mais recentes.
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse().slice(0, 2);
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const full = path.join(dir, e.name);
        const mtime = fs.statSync(full).mtimeMs;
        if (!best || mtime > best.mtime) best = { full, mtime };
      }
    }
    if (depth < 3) for (const d of dirs) walk(path.join(dir, d), depth + 1);
  };
  walk(root, 0);
  return best?.full || null;
}

function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function findKey(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const r = findKey(v, key);
    if (r) return r;
  }
  return null;
}

module.exports = { UsageTracker, latestCodexSession };
