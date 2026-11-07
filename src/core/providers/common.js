const { spawn } = require('child_process');
const readline = require('readline');

// Executa um processo, entrega cada linha JSON do stdout para onJson e
// devolve uma promessa com o código de saída e o stderr.
function runJsonl({ cmd, args, cwd, input, env, onJson, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.replace(/^﻿/, '').trim();
      if (!trimmed.startsWith('{')) return;
      try {
        onJson(JSON.parse(trimmed));
      } catch {
        /* linha que não é JSON: ignora */
      }
    });

    const onAbort = () => killTree(child.pid);
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stderr, aborted: !!signal?.aborted });
    });

    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

// No Windows, child.kill() não derruba os subprocessos: usa taskkill /T.
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* já saiu */
    }
  }
}

function shorten(text, max = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

module.exports = { runJsonl, killTree, shorten };
