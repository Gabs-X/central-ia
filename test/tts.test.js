const test = require('node:test');
const assert = require('node:assert');
const { cleanForSpeech, splitForSpeech, isNeural } = require('../src/integrations/tts');

test('limpa markdown, código, links e emojis antes de falar', () => {
  const md = '## Pronto ✅\n\n**Abri** o `Spotify`.\n\n- item um\n- item dois\n\nVeja [a doc](https://x.com/a) ou https://y.com\n\n```js\nconsole.log(1)\n```';
  const out = cleanForSpeech(md);
  assert.equal(out, 'Pronto. Abri o Spotify. item um item dois. Veja a doc ou o link. (tem um trecho de código na tela)');
});

test('divide textos longos em trechos por frase', () => {
  const frase = 'Esta é uma frase de teste com algumas palavras. ';
  const chunks = splitForSpeech(frase.repeat(30).trim(), 450);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 450));
  assert.ok(chunks.every((c) => c.endsWith('.')), 'não corta no meio da frase');
  assert.deepEqual(splitForSpeech('Oi.'), ['Oi.']);
});

test('identifica vozes neurais', () => {
  assert.ok(isNeural('pt-BR-FranciscaNeural'));
  assert.ok(!isNeural('Microsoft Maria Desktop'));
});

const { takeSpeakable } = require('../src/integrations/tts');

test('leitura em fluxo: só libera frases completas', () => {
  assert.equal(takeSpeakable('Abri o Spotify'), null, 'frase ainda chegando');
  assert.equal(takeSpeakable('Oi.', 60), null, 'curto demais para o primeiro trecho');
  const r = takeSpeakable('Abri o Spotify pra você e coloquei a playlist de foco para tocar agora. Quer mais', 30);
  assert.equal(r.piece, 'Abri o Spotify pra você e coloquei a playlist de foco para tocar agora.');
  assert.equal(r.rest, ' Quer mais');
  assert.equal(takeSpeakable('O valor é 3.5 reais', 5), null, 'ponto decimal não é fim de frase');
  assert.equal(takeSpeakable('Terminei a tarefa toda.', 5), null, 'espera ver o que vem depois do ponto');
});

test('não lê as marcações internas', () => {
  assert.equal(cleanForSpeech('Ainda não sei ler PDF. Quer que eu aprenda?\n[[melhoria: ler arquivos PDF]]'), 'Ainda não sei ler PDF. Quer que eu aprenda?');
  assert.equal(cleanForSpeech('Posso aprender isso. [[melhoria: ler PD'), 'Posso aprender isso.');
  assert.equal(cleanForSpeech('F e DOCX]]'), '');
});

test('pronuncia "Ohara" como em japonês (Orrara)', () => {
  assert.equal(cleanForSpeech('Oi! Eu sou a Ohara.'), 'Oi! Eu sou a Orrara.');
  assert.equal(cleanForSpeech('Na ilha de OHARA'), 'Na ilha de Orrara');
});
