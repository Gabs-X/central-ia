const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findWhisperExe } = require('../src/integrations/whisper');

test('prefere o whisper-cli.exe ao main.exe obsoleto', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ohara-whisper-'));
  const rel = path.join(root, 'Release');
  fs.mkdirSync(rel);
  for (const n of ['bench.exe', 'main.exe', 'whisper-cli.exe']) fs.writeFileSync(path.join(rel, n), '');
  assert.equal(findWhisperExe(root), path.join(rel, 'whisper-cli.exe'));
  fs.rmSync(path.join(rel, 'whisper-cli.exe'));
  assert.equal(findWhisperExe(root), path.join(rel, 'main.exe'), 'versões antigas, sem whisper-cli, ainda funcionam');
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(findWhisperExe(root), null);
});
