const test = require('node:test');
const assert = require('node:assert');
const { parseQuickAction, matchStartApp, googleUrl } = require('../src/core/quick-actions');

test('reconhece pedidos de abrir app ou site', () => {
  assert.deepEqual(parseQuickAction('abre o Spotify'), { type: 'open', target: 'spotify' });
  assert.deepEqual(parseQuickAction('Abra a calculadora.'), { type: 'open', target: 'calculadora' });
  assert.deepEqual(parseQuickAction('abrir o vs code pra mim'), { type: 'open', target: 'vs code' });
  assert.deepEqual(parseQuickAction('inicia o Discord'), { type: 'open', target: 'discord' });
});

test('reconhece pesquisas no Google mantendo o texto original', () => {
  assert.deepEqual(parseQuickAction('pesquisa no Google receita de pão de queijo'), { type: 'google', query: 'receita de pão de queijo' });
  assert.deepEqual(parseQuickAction('busca na internet sobre preço do dólar hoje'), { type: 'google', query: 'preço do dólar hoje' });
  assert.deepEqual(parseQuickAction('procura horário do jogo do Flamengo no google'), { type: 'google', query: 'horário do jogo do Flamengo' });
  assert.deepEqual(parseQuickAction('googla clima em São Paulo'), { type: 'google', query: 'clima em São Paulo' });
});

test('deixa para a IA o que não é uma ação simples', () => {
  for (const t of [
    'abre o Spotify e toca rock',
    'abre a pasta do projeto ohara',
    'pesquisa as melhores bibliotecas de gráfico para React e compara',
    'qual a capital da Austrália?',
    'abre o arquivo README e corrige os erros',
  ]) assert.equal(parseQuickAction(t), null, t);
});

test('escolhe o app certo do menu Iniciar', () => {
  const apps = [
    { Name: 'Spotify', AppID: 'SpotifyAB.Spotify' },
    { Name: 'Discord', AppID: 'com.squirrel.Discord.Discord' },
    { Name: 'Uninstall Discord', AppID: 'x' },
    { Name: 'Visual Studio Code', AppID: 'vscode' },
    { Name: 'Visual Studio Code - Insiders', AppID: 'insiders' },
    { Name: 'OBS Studio', AppID: 'obs' },
  ];
  assert.equal(matchStartApp('spotify', apps).AppID, 'SpotifyAB.Spotify');
  assert.equal(matchStartApp('discord', apps).AppID, 'com.squirrel.Discord.Discord');
  assert.equal(matchStartApp('Visual Studio Code', apps).AppID, 'vscode');
  assert.equal(matchStartApp('obs', apps).AppID, 'obs');
  assert.equal(matchStartApp('photoshop', apps), null);
});

test('monta a URL de busca do Google', () => {
  assert.equal(googleUrl('pão de queijo & café'), 'https://www.google.com/search?q=p%C3%A3o%20de%20queijo%20%26%20caf%C3%A9');
});

test('aceita "abriu", como o Whisper às vezes transcreve "abre"', () => {
  assert.deepEqual(parseQuickAction('abriu o Spotify.'), { type: 'open', target: 'spotify' });
});
