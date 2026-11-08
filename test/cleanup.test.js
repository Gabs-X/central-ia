const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { selectOldFiles, trashOldInstallers } = require('../src/core/cleanup');

test('seleciona só instaladores de versões anteriores', () => {
  const names = [
    'Central-IA-Setup-0.3.4.exe',
    'Central-IA-Portatil-0.3.0.exe',
    'Central-IA-Setup-0.3.4.exe.blockmap',
    'Ohara-Setup-0.4.0.exe',
    'Ohara-Portatil-0.4.1.exe',
    'Ohara-Setup-0.5.0.exe', // atual
    'Ohara-Setup-0.10.0.exe', // mais nova
    'Ohara-Setup-0.5.0 (1).exe', // nome fora do padrão
    'curriculo.pdf',
    'OutroApp-Setup-0.1.0.exe',
  ];
  assert.deepEqual(selectOldFiles(names, '0.5.0'), [
    'Central-IA-Setup-0.3.4.exe',
    'Central-IA-Portatil-0.3.0.exe',
    'Central-IA-Setup-0.3.4.exe.blockmap',
    'Ohara-Setup-0.4.0.exe',
    'Ohara-Portatil-0.4.1.exe',
  ]);
});

test('manda para a lixeira os antigos e preserva o exe em uso', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohara-cleanup-'));
  for (const n of ['Ohara-Setup-0.4.0.exe', 'Ohara-Portatil-0.4.1.exe', 'Ohara-Setup-0.5.0.exe']) fs.writeFileSync(path.join(dir, n), '');
  const trashed = [];
  const removed = await trashOldInstallers({
    version: '0.5.0',
    dirs: [dir, dir, path.join(dir, 'nao-existe')],
    keep: [path.join(dir, 'Ohara-Portatil-0.4.1.exe')], // portátil antigo rodando agora
    trash: async (p) => trashed.push(path.basename(p)),
  });
  assert.deepEqual(trashed, ['Ohara-Setup-0.4.0.exe']);
  assert.equal(removed.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
