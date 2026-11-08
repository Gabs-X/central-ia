// Voz → texto local com whisper.cpp (offline, entende pt-BR).
// Na primeira vez baixa o executável oficial (GitHub ggml-org/whisper.cpp) e o modelo (Hugging Face).
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

function findWhisperExe(root) {
  const found = { cli: null, main: null };
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^whisper-cli\.exe$/i.test(e.name)) found.cli ||= p;
      else if (/^main\.exe$/i.test(e.name)) found.main ||= p;
    }
  };
  walk(root);
  return found.cli || found.main;
}

const MODEL_URL = (name) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${name}.bin`;

class Whisper {
  constructor({ dir, getConfig }) {
    this.dir = dir; // %APPDATA%/Ohara/whisper
    this.getConfig = getConfig;
    this.installing = null;
  }

  get model() {
    return this.getConfig().voice.whisperModel || 'base';
  }

  #binDir() {
    return path.join(this.dir, 'bin');
  }

  // Prefere o whisper-cli.exe. Nas versões novas do whisper.cpp, o main.exe é só um aviso de
  // "binário obsoleto" que sai com código 1; ele só serve em versões antigas, sem whisper-cli.
  #findExe() {
    return findWhisperExe(this.#binDir());
  }

  #modelPath() {
    return path.join(this.dir, 'models', `ggml-${this.model}.bin`);
  }

  status() {
    const exe = this.#findExe();
    const model = this.#modelPath();
    return { installed: !!exe && fs.existsSync(model), exe: !!exe, model: fs.existsSync(model), modelName: this.model, installing: !!this.installing };
  }

  async #download(url, dest, onProgress) {
    const res = await fetch(url, { headers: { 'User-Agent': 'ohara' }, redirect: 'follow' });
    if (!res.ok) throw new Error(`download falhou (${res.status}): ${url}`);
    const total = Number(res.headers.get('content-length')) || 0;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    const out = fs.createWriteStream(tmp);
    let got = 0;
    for await (const chunk of res.body) {
      out.write(chunk);
      got += chunk.length;
      if (total) onProgress?.(got / total);
    }
    await new Promise((r) => out.end(r));
    fs.renameSync(tmp, dest);
  }

  async #latestZipUrl() {
    const res = await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=10', { headers: { 'User-Agent': 'ohara', Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
    for (const rel of await res.json()) {
      const a = rel.assets?.find((x) => x.name === 'whisper-bin-x64.zip');
      if (a) return a.browser_download_url;
    }
    throw new Error('Não encontrei whisper-bin-x64.zip nos releases do whisper.cpp');
  }

  install(onProgress) {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      try {
        if (!this.#findExe()) {
          onProgress?.({ step: 'programa', pct: 0 });
          const zip = path.join(this.dir, 'whisper-bin-x64.zip');
          await this.#download(await this.#latestZipUrl(), zip, (p) => onProgress?.({ step: 'programa', pct: p }));
          // Extrai numa pasta própria (arquivo baixado = não confiável: nada roda de dentro dela além do exe).
          await new Promise((resolve, reject) =>
            execFile('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${this.#binDir()}' -Force`], { windowsHide: true }, (err) => (err ? reject(err) : resolve())),
          );
          fs.rmSync(zip, { force: true });
        }
        if (!fs.existsSync(this.#modelPath())) {
          onProgress?.({ step: 'modelo', pct: 0 });
          await this.#download(MODEL_URL(this.model), this.#modelPath(), (p) => onProgress?.({ step: 'modelo', pct: p }));
        }
        return this.status();
      } finally {
        this.installing = null;
      }
    })();
    return this.installing;
  }

  // Recebe um WAV 16 kHz mono e devolve o texto.
  // prompt: dica de vocabulário para o Whisper (ex.: "Ohara", para ele escrever o nome certo).
  transcribe(wavPath, { prompt } = {}) {
    const exe = this.#findExe();
    if (!exe || !fs.existsSync(this.#modelPath())) return Promise.reject(new Error('Whisper não instalado. Instale em Configurações → Voz.'));
    const lang = this.getConfig().voice.language || 'pt';
    const threads = Math.max(2, Math.min(8, require('os').cpus().length - 1));
    return new Promise((resolve, reject) => {
      const args = ['-m', this.#modelPath(), '-f', wavPath, '-l', lang, '-nt', '-np', '-t', String(threads)];
      if (prompt) args.push('--prompt', prompt);
      const p = spawn(exe, args, { cwd: path.dirname(wavPath), windowsHide: true });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d.toString('utf8')));
      p.stderr.on('data', (d) => (err += d.toString('utf8')));
      p.on('error', reject);
      p.on('close', (code) => {
        if (code !== 0) {
          // Alguns erros vão para a saída normal (ex.: aviso de binário obsoleto).
          const last = (err + '\n' + out).split('\n').map((l) => l.trim()).filter(Boolean).pop();
          return reject(new Error(last ? `Whisper: ${last}` : `whisper saiu com código ${code}`));
        }
        resolve(out.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim());
      });
    });
  }
}

module.exports = { Whisper, findWhisperExe };
