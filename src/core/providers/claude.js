// Provedor Claude: usa o Claude Code em modo headless (claude -p) com a sua assinatura.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runJsonl, shorten } = require('./common');

/**
 * Pasta de login do Claude Code. O Gabriel usa a conta pessoal em ~/.claude-pessoal
 * (o `claude` puro fica na conta da empresa). Vazio = detecta automaticamente.
 */
function claudeConfigDir(config) {
  const dir = config.claude?.configDir;
  if (dir) return dir.replace(/^~(?=$|[\\/])/, os.homedir());
  const pessoal = path.join(os.homedir(), '.claude-pessoal');
  return fs.existsSync(pessoal) ? pessoal : null;
}

function claudeEnv(config) {
  const dir = claudeConfigDir(config);
  return dir ? { CLAUDE_CONFIG_DIR: dir } : {};
}

function friendlyError(msg) {
  if (/not logged in|please run \/login/i.test(msg || '')) {
    return 'O Claude não está logado na pasta usada pela Ohara. Confira em Ajustes → Geral → "Pasta de login do Claude" (a conta pessoal fica em ~/.claude-pessoal).';
  }
  return msg;
}

function describeTool(name, input = {}) {
  const arg =
    input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description || '';
  return `${name}${arg ? `: ${shorten(arg, 140)}` : ''}`;
}

/**
 * @param {object} o
 * @param {string} o.prompt
 * @param {string} o.cwd
 * @param {string} o.model   alias ou id (haiku, sonnet, opus...)
 * @param {string} o.effort  low | medium | high | xhigh | max
 * @param {string} [o.sessionId] para continuar a conversa
 * @param {string[]} [o.images] caminhos de imagens
 * @param {object} o.config  configuração completa
 * @param {(ev:object)=>void} o.onEvent
 * @param {AbortSignal} [o.signal]
 */
async function runClaude(o) {
  const { config } = o;
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', o.model,
    '--effort', o.effort,
    '--permission-mode', o.permissionMode || config.claude.permissionMode,
    '--append-system-prompt', o.systemPrompt,
  ];
  if (config.workspaceRoot) args.push('--add-dir', config.workspaceRoot);
  if (o.sessionId) args.push('--resume', o.sessionId);

  let prompt = o.prompt;
  if (o.images?.length) {
    prompt += `\n\n[Imagens anexadas — abra com a ferramenta Read para ver]\n${o.images.map((p) => `- ${p}`).join('\n')}`;
  }

  const state = { sessionId: o.sessionId || null, text: '', usage: null, costUsd: 0, isError: false, error: null, model: o.model };
  const streamed = new Set(); // ids de mensagens que já vieram em pedaços

  let currentMsg = null;
  const onJson = (ev) => {
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          state.sessionId = ev.session_id;
          if (ev.model) state.model = ev.model;
        }
        break;
      case 'stream_event': {
        const e = ev.event || {};
        if (e.type === 'message_start') currentMsg = e.message?.id;
        if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          if (currentMsg) streamed.add(currentMsg);
          state.text += e.delta.text;
          o.onEvent({ kind: 'delta', text: e.delta.text });
        }
        break;
      }
      case 'assistant': {
        const msg = ev.message || {};
        if (ev.parent_tool_use_id) break; // mensagens de subagentes
        for (const block of msg.content || []) {
          if (block.type === 'tool_use') {
            o.onEvent({ kind: 'tool', text: describeTool(block.name, block.input) });
          } else if (block.type === 'text' && !streamed.has(msg.id) && block.text) {
            state.text += block.text;
            o.onEvent({ kind: 'delta', text: block.text });
          }
        }
        if (msg.content?.some((b) => b.type === 'text')) {
          // Separa blocos de texto de turnos diferentes.
          state.text += '\n\n';
          o.onEvent({ kind: 'delta', text: '\n\n' });
        }
        break;
      }
      case 'rate_limit_event':
        o.onEvent({ kind: 'limits', provider: 'claude', info: ev.rate_limit_info });
        break;
      case 'result':
        state.isError = !!ev.is_error;
        state.costUsd = ev.total_cost_usd || 0;
        state.usage = ev.usage || null;
        if (ev.session_id) state.sessionId = ev.session_id;
        if (state.isError) state.error = ev.result || ev.subtype;
        // A resposta final oficial; útil quando nada veio em streaming.
        if (!state.text.trim() && ev.result) {
          state.text = ev.result;
          o.onEvent({ kind: 'delta', text: ev.result });
        }
        break;
      default:
        break;
    }
  };

  const { code, stderr, aborted } = await runJsonl({
    cmd: config.claude.bin,
    args,
    env: claudeEnv(config),
    cwd: o.cwd,
    input: prompt,
    onJson,
    signal: o.signal,
  });

  if (aborted) state.error = 'Cancelado.';
  else if (code !== 0 && !state.text) state.error = state.error || shorten(stderr, 600) || `claude saiu com código ${code}`;

  state.error = friendlyError(state.error);
  const u = state.usage || {};
  return {
    provider: 'claude',
    model: state.model,
    text: state.text.trim(),
    sessionId: state.sessionId,
    error: state.error,
    tokens: {
      input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      cached: u.cache_read_input_tokens || 0,
      output: u.output_tokens || 0,
      costUsd: state.costUsd,
    },
  };
}

module.exports = { runClaude, claudeEnv, claudeConfigDir, friendlyError };
