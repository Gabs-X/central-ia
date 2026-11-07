const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dedupe, meetingKeyFromFile, loadMeeting } = require('../src/core/transcript');

const u = (time, speaker, text) => {
  const [h, m, s] = time.split(':').map(Number);
  return { time, sec: h * 3600 + m * 60 + s, speaker, text };
};

test('remove falas repetidas que vão crescendo', () => {
  const out = dedupe([
    u('15:24:06', 'Pedro', 'conta normal, se quiser botar nome e-mail, senha'),
    u('15:24:15', 'Pedro', 'conta normal, se quiser botar nome e-mail, senha aí tem para confirmar'),
    u('15:24:20', 'Eu', 'Certo'),
  ]);
  assert.equal(out.length, 2);
  assert.match(out[0].text, /confirmar/);
  assert.equal(out[0].time, '15:24:06');
});

test('mantém falas diferentes da mesma pessoa', () => {
  const out = dedupe([u('10:00:00', 'Ana', 'Vou revisar a PR'), u('10:00:05', 'Ana', 'Depois subo o deploy')]);
  assert.equal(out.length, 2);
});

test('agrupa partes "-2" na mesma reunião', () => {
  const a = meetingKeyFromFile('meet-2026-11-05-meetpkw-peob-wvh.md');
  const b = meetingKeyFromFile('meet-2026-11-05-meetpkw-peob-wvh-2.md');
  assert.equal(a.key, b.key);
  assert.equal(b.part, 2);
});

test('lê cabeçalho e troca "Eu" pelo nome', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
  const f = path.join(dir, 'meet-2026-11-05-abc-defg-hij.md');
  fs.writeFileSync(
    f,
    '# Reunião 05/11/2026 — abc-defg-hij\n\n2 falas · quem falou: Pedro, Eu\n15:00:00 → 15:10:00 · capturado\n\n---\n\n**15:00:00 — Pedro:** Oi\n\n**15:00:05 — Eu:** Te mando amanhã\n',
  );
  const m = loadMeeting([f], { selfName: 'Gabriel' });
  assert.equal(m.durationMin, 10);
  assert.match(m.text, /15:00 Gabriel \(eu\): Te mando amanhã/);
  fs.rmSync(dir, { recursive: true, force: true });
});
