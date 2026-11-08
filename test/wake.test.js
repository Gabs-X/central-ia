const test = require('node:test');
const assert = require('node:assert');
const { matchWake } = require('../src/core/wake');

test('reconhece os jeitos como o Whisper escreve "Ohara"', () => {
  const casos = {
    'Ohara, abre o Spotify.': 'abre o Spotify.',
    'O Herra abriu o Spotify.': 'abriu o Spotify.',
    'O Hara, pesquisa no Google receita de bolo': 'pesquisa no Google receita de bolo',
    'Oara me lembra de beber água': 'me lembra de beber água',
    'Orara, que horas são?': 'que horas são?',
    'Ohhara abre o Discord': 'abre o Discord',
    'Oh, Hara, abre o YouTube': 'abre o YouTube',
    'Ei, Ohara, abre a calculadora': 'abre a calculadora',
    'Oi Ohara tudo bem?': 'tudo bem?',
    'Ohana, abre o Chrome': 'abre o Chrome',
  };
  for (const [fala, cmd] of Object.entries(casos)) {
    const r = matchWake(fala);
    assert.ok(r, `não reconheceu: ${fala}`);
    assert.equal(r.command, cmd, fala);
    assert.equal(r.wakeOnly, false);
  }
});

test('"Ohara" sozinho fica esperando o pedido', () => {
  for (const fala of ['Ohara.', 'Ohara?', 'O Hara...', 'Ei, Ohara!']) {
    const r = matchWake(fala);
    assert.ok(r, fala);
    assert.equal(r.wakeOnly, true, fala);
  }
});

test('não ativa com frases comuns', () => {
  for (const fala of [
    'Agora vamos ver o código',
    'Para de falar',
    'O carro quebrou',
    'Hora de ir embora',
    'Abre o Spotify',
    'Vou falar com a Sara amanhã',
    'Obrigado pela reunião',
    '',
    '[música]',
  ]) assert.equal(matchWake(fala), null, fala);
});
