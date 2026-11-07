// Provedor Codex: usa "codex exec --json" com a sua assinatura do ChatGPT.
const fs = require('fs');
const path = require('path');
const { runJsonl, shorten } = require('./common');

// O "codex" do npm é um .cmd/.ps1; chamar o JS direto com node evita problemas de aspas no Windows.
function resolveCodex(config) {
  if (config.codex.bin) return { cmd: config.codex.bin, pre: [] };
  const js = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (fs.existsSync(js)) return { cmd: 'node', pre: [js] };
  return { cmd: 'codex', pre: [] };
}

function describeItem(item) {
  switch (item.type) {
    case 'command_execution':
      return `Comando: ${shorten(item.command, 140)}${item.exit_code != null && item.exit_code !== 0 ? ` (código ${item.exit_code})` : ''}`;
    case 'file_change':
      return `Arquivos: ${(item.changes || []).map((c) => `${c.kind || ''} ${path.basename(c.path || '')}`.trim()).join(', ')}`;
    case 'mcp_tool_call':
      return `MCP: ${item.server || ''}.${item.tool || ''}`;
    case 'web_search':
      return `Busca: ${shorten(item.query, 120)}`;
    default:
      return null;
  }
}

async function runCodex(o) {
  const { config } = o;
  const { cmd, pre } = resolveCodex(config);
  const common = ['exec', '--json', '--skip-git-repo-check', '-s', o.sandbox || config.codex.sandbox, '-C', o.cwd];
  if (config.workspaceRoot && config.workspaceRoot !== o.cwd) common.push('--add-dir', config.workspaceRoot);
  if (config.codex.model) common.push('-m', config.codex.model);
  common.push('-c', `model_reasoning_effort="${o.effort === 'low' ? 'low' : o.effort === 'high' ? 'high' : 'medium'}"`);

  const images = (o.images || []).flatMap((p) => ['-i', p]);
  const args = o.sessionId ? [...pre, ...common, 'resume', o.sessionId, ...images, '-'] : [...pre, ...common, ...images, '-'];

  const prompt = o.sessionId ? o.prompt : `${o.systemPrompt}\n\n---\n\n${o.prompt}`;

  const state = { sessionId: o.sessionId || null, text: '', usage: null, error: null };
  const onJson = (ev) => {
    switch (ev.type) {
      case 'thread.started':
        state.sessionId = ev.thread_id;
        break;
      case 'item.started': {
        const d = ev.item && describeItem(ev.item);
        if (d && ev.item.type === 'command_execution') o.onEvent({ kind: 'tool', text: d });
        break;
      }
      case 'item.completed': {
        const item = ev.item || {};
        if (item.type === 'agent_message' && item.text) {
          const chunk = (state.text ? '\n\n' : '') + item.text;
          state.text += chunk;
          o.onEvent({ kind: 'delta', text: chunk });
        } else if (item.type !== 'command_execution') {
          const d = describeItem(item);
          if (d) o.onEvent({ kind: 'tool', text: d });
        }
        break;
      }
      case 'turn.completed':
        state.usage = ev.usage || null;
        break;
      case 'turn.failed':
        state.error = ev.error?.message || 'Falha no Codex';
        break;
      case 'error':
        state.error = ev.message || 'Erro no Codex';
        break;
      default:
        break;
    }
  };

  const { code, stderr, aborted } = await runJsonl({ cmd, args, cwd: o.cwd, input: prompt, onJson, signal: o.signal });
  if (aborted) state.error = 'Cancelado.';
  else if (code !== 0 && !state.text && !state.error) state.error = shorten(stderr, 600) || `codex saiu com código ${code}`;

  const u = state.usage || {};
  const cached = u.cached_input_tokens || 0;
  return {
    provider: 'codex',
    model: config.codex.model || 'padrão do Codex',
    text: state.text.trim(),
    sessionId: state.sessionId,
    error: state.text ? null : state.error,
    tokens: {
      input: Math.max(0, (u.input_tokens || 0) - cached),
      cached,
      output: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0),
      costUsd: 0,
    },
  };
}

module.exports = { runCodex };
