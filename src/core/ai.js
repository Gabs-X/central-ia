// Chamada de IA "de uma vez" (sem ferramentas), usada pelas funções automáticas:
// reuniões, briefing, busca, cobranças, Slack. Respeita o orçamento de cota de cada função.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runJsonl, shorten } = require('./providers/common');
const { resolveCodex } = require('./providers/codex');
const { claudeEnv, friendlyError } = require('./providers/claude');

class DeferError extends Error {
  constructor(retryAt, reason) {
    super(reason);
    this.retryAt = retryAt;
    this.deferred = true;
  }
}

const util = (l) => (l ? Math.max(l.fiveHour ?? 0, l.weekly ?? 0) : 0);

/**
 * Decide o provedor de uma função conforme o orçamento.
 * Funções de segundo plano têm teto menor, para sobrar cota para você usar no chat.
 * @returns {{provider:'claude'|'codex'} | {defer:number, reason:string}}
 */
function pickProvider(feature, limits, config) {
  const f = config.features?.[feature] || {};
  if (f.provider === 'claude' || f.provider === 'codex') return { provider: f.provider };

  const background = !!f.background;
  const b = config.budgets;
  const claudeMax = background ? b.backgroundClaude : config.quota.claudeAvoidAt;
  const codexMax = background ? b.backgroundCodex : config.quota.codexAvoidAt;
  const c = limits.claude;
  const x = limits.codex;

  if (c?.status !== 'rejected' && util(c) < claudeMax) return { provider: 'claude' };
  if (x?.status !== 'rejected' && util(x) < codexMax) return { provider: 'codex' };
  if (!background) return { provider: 'claude' }; // pedido seu: tenta mesmo assim

  // Adia até a primeira janela que renovar.
  const resets = [c?.fiveHourResetsAt, x?.fiveHourResetsAt].filter(Boolean).map((s) => s * 1000).filter((t) => t > Date.now());
  const retryAt = resets.length ? Math.min(...resets) + 60_000 : Date.now() + 30 * 60_000;
  return { defer: retryAt, reason: `cota acima do orçamento de segundo plano (Claude ${Math.round(util(c) * 100)}%, Codex ${Math.round(util(x) * 100)}%)` };
}

function tryJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(String(s).trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    return null;
  }
}

async function claudeOnce({ prompt, schema, model, effort, config, usage, signal }) {
  let out = null;
  let text = '';
  let u = {};
  let resolvedModel = model;
  let error = null;
  let cost = 0;
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--effort', effort,
    '--tools', '', '--no-session-persistence', '--disable-slash-commands'];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  const { code, stderr } = await runJsonl({
    cmd: config.claude.bin,
    args,
    env: claudeEnv(config),
    cwd: os.tmpdir(),
    input: prompt,
    signal,
    onJson: (ev) => {
      if (ev.type === 'system' && ev.subtype === 'init' && ev.model) resolvedModel = ev.model;
      if (ev.type === 'rate_limit_event') usage.updateClaudeLimits(ev.rate_limit_info);
      if (ev.type === 'result') {
        u = ev.usage || {};
        cost = ev.total_cost_usd || 0;
        if (ev.is_error) error = ev.result || ev.subtype;
        text = ev.result || '';
        out = schema ? ev.structured_output || tryJson(ev.result) : text;
      }
    },
  });
  if (!out) throw new Error(friendlyError(error) || shorten(stderr, 300) || `claude saiu com código ${code}`);
  return {
    provider: 'claude',
    model: resolvedModel,
    data: out,
    tokens: { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cached: u.cache_read_input_tokens || 0, output: u.output_tokens || 0, costUsd: cost },
  };
}

async function codexOnce({ prompt, schema, effort, config, usage, signal }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ohara-'));
  const outFile = path.join(tmp, 'saida.txt');
  const { cmd, pre } = resolveCodex(config);
  let u = {};
  try {
    const args = [...pre, 'exec', '--json', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', tmp, '-o', outFile,
      '-c', `model_reasoning_effort="${effort === 'high' ? 'high' : effort === 'low' ? 'low' : 'medium'}"`];
    if (schema) {
      const schemaFile = path.join(tmp, 'schema.json');
      fs.writeFileSync(schemaFile, JSON.stringify(schema));
      args.push('--output-schema', schemaFile);
    }
    if (config.codex.model) args.push('-m', config.codex.model);
    args.push('-');
    const { code, stderr } = await runJsonl({
      cmd, args, cwd: tmp, input: prompt, signal,
      onJson: (ev) => { if (ev.type === 'turn.completed') u = ev.usage || {}; },
    });
    const raw = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
    const data = schema ? tryJson(raw) : raw.trim();
    if (!data) throw new Error(shorten(stderr, 300) || `codex saiu com código ${code}`);
    usage.refreshCodexLimits();
    const cached = u.cached_input_tokens || 0;
    return {
      provider: 'codex',
      model: config.codex.model || 'padrão do Codex',
      data,
      tokens: { input: Math.max(0, (u.input_tokens || 0) - cached), cached, output: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0) },
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * @param {object} o
 * @param {string} o.feature   chave em config.features (meetings, briefing, busca, cobranca, slack...)
 * @param {string} o.prompt
 * @param {object} [o.schema]  JSON Schema estrito; sem schema devolve texto
 * @param {object} o.config
 * @param {import('./usage').UsageTracker} o.usage
 */
async function askOnce(o) {
  const f = o.config.features?.[o.feature] || {};
  const choice = pickProvider(o.feature, o.usage.limits(), o.config);
  if (choice.defer) throw new DeferError(choice.defer, choice.reason);
  const model = o.config.claude.models[f.model] || f.model || o.config.claude.models.equilibrado;
  const effort = f.effort || 'medium';
  const run = choice.provider === 'codex' ? codexOnce : claudeOnce;
  const result = await run({ ...o, model, effort });
  o.usage.record(result.provider, result.model, result.tokens, o.feature);
  return result;
}

module.exports = { askOnce, pickProvider, DeferError, tryJson };
