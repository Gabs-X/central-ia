// Limpeza de versões antigas: na primeira execução de uma versão nova (app instalado),
// manda para a Lixeira os instaladores/portáteis antigos e remove a instalação da antiga "Central IA".
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FILE_RE = /^(?:Central-IA|Ohara)-(?:Setup|Portatil)-(\d+)\.(\d+)\.(\d+)\.exe(?:\.blockmap)?$/i;

function cmpVersion(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Arquivos de versões ANTERIORES à atual, entre os nomes informados.
 * Nunca inclui a versão atual nem versões mais novas.
 */
function selectOldFiles(names, currentVersion) {
  const cur = String(currentVersion).split('.').map(Number);
  return names.filter((name) => {
    const m = name.match(FILE_RE);
    return m && cmpVersion(m.slice(1, 4).map(Number), cur) < 0;
  });
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * @param {object} o
 * @param {string} o.version      versão atual (app.getVersion())
 * @param {string[]} o.dirs       pastas onde procurar instaladores antigos
 * @param {string[]} o.keep       caminhos que nunca podem ser removidos (o exe em uso)
 * @param {(p: string) => Promise<void>} o.trash  manda para a Lixeira (shell.trashItem)
 * @returns {Promise<string[]>} arquivos removidos
 */
async function trashOldInstallers({ version, dirs, keep = [], trash }) {
  const keepSet = new Set(keep.filter(Boolean).map((p) => path.resolve(p).toLowerCase()));
  const removed = [];
  for (const dir of [...new Set(dirs.filter(Boolean))]) {
    for (const name of selectOldFiles(listDir(dir), version)) {
      const full = path.join(dir, name);
      if (keepSet.has(path.resolve(full).toLowerCase())) continue;
      try {
        await trash(full);
        removed.push(full);
      } catch {
        /* em uso ou sem permissão: tenta na próxima versão */
      }
    }
  }
  return removed;
}

/**
 * Se a instalação antiga da "Central IA" ainda existir (em outra pasta), roda o desinstalador dela em silêncio.
 * Retorna true se iniciou a desinstalação.
 */
function uninstallLegacyApp({ programsDir, currentExe }) {
  const dir = path.join(programsDir, 'Central IA');
  if (!fs.existsSync(dir)) return false;
  if (path.resolve(currentExe).toLowerCase().startsWith(path.resolve(dir).toLowerCase())) return false;
  const uninstaller = path.join(dir, 'Uninstall Central IA.exe');
  if (!fs.existsSync(uninstaller)) return false;
  const child = spawn(uninstaller, ['/S', '/KEEP_APP_DATA'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  return true;
}

module.exports = { selectOldFiles, trashOldInstallers, uninstallLegacyApp };
