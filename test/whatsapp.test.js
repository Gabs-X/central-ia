const test = require('node:test');
const assert = require('node:assert');
const { wantsWhatsApp, toWhatsAppText, splitMessage, WhatsApp } = require('../src/integrations/whatsapp');

test('reconhece pedidos para mandar no WhatsApp', () => {
  for (const t of [
    'me manda no WhatsApp o resumo da reunião',
    'envia pro meu zap a lista de tarefas',
    'manda no wpp o link',
    'me avisa no whats quando terminar',
    'Me lembra no WhatsApp de pagar o boleto',
  ]) assert.ok(wantsWhatsApp(t), t);
});

test('ignora perguntas sobre o WhatsApp e pedidos sem ele', () => {
  for (const t of [
    'o que é o WhatsApp Business?',
    'me manda o resumo da reunião',
    'como funciona a API do whatsapp',
    'abre o Spotify',
  ]) assert.ok(!wantsWhatsApp(t), t);
});

test('converte markdown para a formatação do WhatsApp', () => {
  const out = toWhatsAppText('## Resumo\n\n**Importante**: veja [o site](https://x.com)\n- item 1\n- item 2');
  assert.equal(out, '*Resumo*\n\n*Importante*: veja o site (https://x.com)\n• item 1\n• item 2');
});

test('divide mensagens longas em partes', () => {
  const para = 'palavra '.repeat(120).trim(); // ~960 caracteres
  const parts = splitMessage([para, para, para].join('\n\n'), 1500);
  assert.equal(parts.length, 3); // corta nos parágrafos em vez de no meio do texto
  assert.ok(parts.every((p) => p === para));
  assert.ok(parts.every((p) => p.length <= 1500));
  assert.equal(splitMessage('oi').length, 1);
});

test('limita a quantidade de partes', () => {
  const parts = splitMessage('x '.repeat(10000), 1500, 4);
  assert.equal(parts.length, 4);
  assert.ok(parts[3].endsWith('(continua na Ohara)'));
});

test('não envia sem número e chave configurados', async () => {
  const wa = new WhatsApp({ getConfig: () => ({ integrations: { whatsapp: { phone: '', apikey: '' } } }) });
  assert.equal(wa.configured, false);
  await assert.rejects(() => wa.send('oi'), /não configurado/);
});

test('envia para o número configurado e mascara o número no status', async () => {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    calls.push(new URL(url));
    return { ok: true, text: async () => '<p>Message queued. You will receive it in a few seconds.</p>' };
  };
  try {
    const wa = new WhatsApp({ getConfig: () => ({ integrations: { whatsapp: { phone: '+5511999998888', apikey: '123456' } } }) });
    assert.equal(await wa.send('**oi**'), 1);
    assert.equal(calls[0].searchParams.get('phone'), '+5511999998888');
    assert.equal(calls[0].searchParams.get('text'), '*oi*');
    assert.equal(wa.status().phone, '+5511•••88');
  } finally {
    global.fetch = original;
  }
});

test('erro do CallMeBot vira exceção', async () => {
  const original = global.fetch;
  global.fetch = async () => ({ ok: true, text: async () => 'APIKey is invalid.' });
  try {
    const wa = new WhatsApp({ getConfig: () => ({ integrations: { whatsapp: { phone: '+5511999998888', apikey: 'x' } } }) });
    await assert.rejects(() => wa.send('oi'), /CallMeBot: APIKey is invalid/);
  } finally {
    global.fetch = original;
  }
});

const { extractDrafts, formatTasksMessage, pickContact } = require('../src/integrations/whatsapp');

test('separa o rascunho para contato do resto da resposta', () => {
  const r = extractDrafts('Preparei a mensagem.\n\n[[whatsapp para="João Silva"]]\nOi João, vou atrasar 10 min.\n[[/whatsapp]]');
  assert.equal(r.text, 'Preparei a mensagem.');
  assert.deepEqual(r.drafts, [{ to: 'João Silva', text: 'Oi João, vou atrasar 10 min.' }]);
  assert.deepEqual(extractDrafts('só texto').drafts, []);
});

test('monta o aviso de demandas novas da reunião', () => {
  const msg = formatTasksMessage('Daily', [
    { text: 'Revisar a PR 12', priority: 'alta', deadline: '2026-11-10', requestedBy: 'Ana' },
    { text: 'Atualizar o README', priority: 'baixa' },
  ]);
  assert.match(msg, /2 demandas novas para você/);
  assert.match(msg, /Reunião: Daily/);
  assert.match(msg, /🔴 Revisar a PR 12\n {3}_até 10\/11\/2026 · pedido por Ana_/);
  assert.match(msg, /🟢 Atualizar o README/);
});

test('escolhe o contato certo ou recusa quando é ambíguo', () => {
  assert.equal(pickContact('joao', ['João', 'João Pedro']).name, 'João');
  assert.equal(pickContact('Mãe', ['Mãe ❤️']).name, 'Mãe ❤️');
  assert.match(pickContact('Ana', ['Ana Paula', 'Ana Clara']).error, /mais de um contato parecido/);
  assert.match(pickContact('Zé', []).error, /Não achei/);
});

const { parseSendReply } = require('../src/integrations/whatsapp');

test('entende a confirmação do envio por texto ou voz', () => {
  for (const t of ['confirmado', 'Confirmado!', 'envie', 'envie a mensagem', 'pode enviar', 'Pode mandar agora, por favor', 'manda pra ela', 'envia pra Tata', 'confirma o envio no zap']) {
    assert.equal(parseSendReply(t, ['Tata']), 'confirm', t);
  }
  for (const t of ['sim', 'ok', 'isso']) assert.equal(parseSendReply(t), 'yes', t);
  for (const t of ['cancela', 'não envia', 'não, deixa', 'esquece essa mensagem']) assert.equal(parseSendReply(t), 'cancel', t);
  for (const t of ['manda pro João no zap que vou atrasar', 'muda o texto antes', 'qual a previsão do tempo?', '', 'envia pro Pedro']) {
    assert.equal(parseSendReply(t, ['Tata']), null, t);
  }
});

test('acha o contato por parte do nome, apelido ou erro de transcrição', () => {
  const { pickContact: pick } = require('../src/integrations/whatsapp');
  assert.equal(pick('Tata', ['Tata Souza', 'Tatiane Lima']).name, 'Tata Souza');
  assert.equal(pick('tatar', ['Tata Souza']).name, 'Tata Souza');
  assert.equal(pick('vó', ['Vó Maria', 'Vovô Zé']).name, 'Vó Maria');
  assert.match(pick('vó', ['Vó Maria', 'Vó Lúcia']).error, /mais de um contato parecido/);
});
