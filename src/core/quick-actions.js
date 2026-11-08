// Ações locais instantâneas (sem IA): abrir aplicativos/sites e pesquisar no Google.
// Pensadas para a voz ("Ohara, abre o Spotify"), mas valem no chat também.
// Só pedidos simples entram aqui; qualquer coisa a mais ("abre o Spotify e toca rock") segue para a IA.
const { execFile, spawn } = require('child_process');

const strip = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// Sites conhecidos: "abre o youtube" abre no navegador.
const SITES = {
  youtube: 'https://www.youtube.com',
  google: 'https://www.google.com',
  gmail: 'https://mail.google.com',
  'google agenda': 'https://calendar.google.com',
  agenda: 'https://calendar.google.com',
  'google drive': 'https://drive.google.com',
  drive: 'https://drive.google.com',
  github: 'https://github.com',
  linkedin: 'https://www.linkedin.com',
  netflix: 'https://www.netflix.com',
  'chat gpt': 'https://chatgpt.com',
  chatgpt: 'https://chatgpt.com',
  claude: 'https://claude.ai',
  instagram: 'https://www.instagram.com',
  twitter: 'https://x.com',
  x: 'https://x.com',
  twitch: 'https://www.twitch.tv',
  'whatsapp web': 'https://web.whatsapp.com',
};

// Apelidos falados → nome no menu Iniciar ou comando do Windows.
const ALIASES = {
  calculadora: { cmd: 'calc' },
  'bloco de notas': { cmd: 'notepad' },
  notepad: { cmd: 'notepad' },
  explorador: { cmd: 'explorer' },
  'explorador de arquivos': { cmd: 'explorer' },
  explorer: { cmd: 'explorer' },
  configuracoes: { uri: 'ms-settings:' },
  configuracao: { uri: 'ms-settings:' },
  'gerenciador de tarefas': { cmd: 'taskmgr' },
  terminal: { cmd: 'wt' },
  powershell: { cmd: 'powershell' },
  paint: { cmd: 'mspaint' },
  navegador: { url: 'https://www.google.com' },
  'vs code': { app: 'Visual Studio Code' },
  vscode: { app: 'Visual Studio Code' },
  code: { app: 'Visual Studio Code' },
  word: { app: 'Word' },
  excel: { app: 'Excel' },
  'power point': { app: 'PowerPoint' },
  powerpoint: { app: 'PowerPoint' },
  obs: { app: 'OBS Studio' },
};

// "abriu"/"abri": o Whisper às vezes transcreve "abre" assim.
const OPEN = /^(?:abr[ae]|abrir|abriu|abri|abre ai|inici[ae]|iniciar|execut[ae]|executar|ligue|liga|rod[ae])\s+(?:(?:o|a|os|as|meu|minha)\s+)?(.+)$/;
const GOOGLE = [
  /^(?:pesquis\w*|busc\w*|procur\w*|googl\w*)\s+(?:(?:no|pelo|na)\s+google|na internet|na web)\s+(?:(?:por|sobre|o que e|o que sao)\s+)?(.+)$/,
  /^(?:pesquis\w*|busc\w*|procur\w*)\s+(.+?)\s+(?:no|pelo)\s+google$/,
  /^(?:googl\w*|da um google em|da um google sobre)\s+(.+)$/,
];

/**
 * Interpreta o pedido. Retorna null quando não é uma ação simples (aí vai para a IA).
 * @returns {{ type: 'google', query: string } | { type: 'open', target: string } | null}
 */
function parseQuickAction(text) {
  const raw = String(text || '').trim().replace(/[.!?]+$/, '');
  const t = strip(raw);
  if (!t || t.length > 120) return null;

  for (const re of GOOGLE) {
    const m = t.match(re);
    if (m) {
      // Mantém acentos e maiúsculas do texto original na busca.
      const start = t.lastIndexOf(m[1]);
      const query = raw.slice(start, start + m[1].length).trim() || m[1];
      return query ? { type: 'google', query } : null;
    }
  }

  const m = t.match(OPEN);
  if (!m) return null;
  const target = m[1].replace(/\s+(pra|para) mim$/, '').replace(/\s+(por favor|pf|pfv)$/, '').trim();
  // "abre o spotify e toca X", "abre a pasta do projeto"...: deixa para a IA.
  if (!target || target.split(' ').length > 4 || /\b(e|depois|pasta|arquivo|projeto|repositorio|site d[oa])\b/.test(target)) return null;
  return { type: 'open', target };
}

function googleUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

// ---- Execução ----
let startAppsCache = null;
let startAppsAt = 0;

// Lista os apps do menu Iniciar (Name + AppID). Fica em cache por 10 min.
function listStartApps() {
  if (startAppsCache && Date.now() - startAppsAt < 10 * 60_000) return Promise.resolve(startAppsCache);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress'],
      { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(startAppsCache || []);
        try {
          const list = JSON.parse(stdout || '[]');
          startAppsCache = (Array.isArray(list) ? list : [list]).filter((a) => a?.Name && a?.AppID);
          startAppsAt = Date.now();
        } catch {
          startAppsCache = startAppsCache || [];
        }
        resolve(startAppsCache);
      },
    );
  });
}

// Melhor app para o nome falado: igual > começa com > contém (preferindo nomes curtos). Ignora desinstaladores.
function matchStartApp(name, apps) {
  const q = strip(name);
  const candidates = apps.filter((a) => !/uninstall|desinstal/i.test(a.Name));
  const by = (fn) => candidates.filter((a) => fn(strip(a.Name))).sort((a, b) => a.Name.length - b.Name.length)[0];
  return by((n) => n === q) || by((n) => n.startsWith(q)) || by((n) => n.split(/[\s.-]+/).includes(q)) || by((n) => n.includes(q)) || null;
}

function launch(file, args = []) {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

/**
 * Executa a ação. `openExternal` abre URLs/URIs no navegador ou app padrão (shell.openExternal do Electron).
 * Retorna { ok, text } com a frase para mostrar/ler, ou null se não souber resolver (aí vai para a IA).
 */
async function runQuickAction(action, { openExternal }) {
  if (action.type === 'google') {
    await openExternal(googleUrl(action.query));
    return { ok: true, text: `Pesquisando no Google: **${action.query}**` };
  }

  const key = strip(action.target);
  const alias = ALIASES[key];
  if (alias?.url || SITES[key]) {
    await openExternal(alias?.url || SITES[key]);
    return { ok: true, text: `Abrindo ${action.target}.` };
  }
  if (alias?.uri) {
    await openExternal(alias.uri);
    return { ok: true, text: `Abrindo ${action.target}.` };
  }
  if (alias?.cmd) {
    launch(alias.cmd);
    return { ok: true, text: `Abrindo ${action.target}.` };
  }

  const app = matchStartApp(alias?.app || action.target, await listStartApps());
  if (app) {
    launch('explorer.exe', [`shell:AppsFolder\\${app.AppID}`]);
    return { ok: true, text: `Abrindo ${app.Name}.` };
  }
  return null;
}

module.exports = { parseQuickAction, runQuickAction, matchStartApp, googleUrl };
