const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// IA falsa: cada chamada espera até ser liberada pelo teste.
const calls = [];
function fakeProvider(provider) {
  return async (opts) => {
    const call = { provider, opts };
    calls.push(call);
    await new Promise((resolve) => { call.finish = resolve; });
    return { provider, model: opts.model || 'fake', text: call.answer ?? `resposta: ${opts.prompt.split('\n').pop()}`, tokens: {}, sessionId: `sess-${calls.indexOf(call)}` };
  };
}
const stub = (rel, exports) => {
  const file = require.resolve(path.join('../src/core', rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stub('providers/claude', { runClaude: fakeProvider('claude') });
stub('providers/codex', { runCodex: fakeProvider('codex') });

const { Orchestrator } = require('../src/core/orchestrator');
const { DEFAULT_CONFIG } = require('../src/core/config');

function setup(extra = {}) {
  calls.length = 0;
  const events = [];
  const store = (data) => ({ data, save() {} });
  const usage = { updateClaudeLimits() {}, summary: () => ({}), record() {}, refreshCodexLimits() {}, limits: () => ({}), current: () => ({}) };
  const o = new Orchestrator({
    chatsStore: store({ chats: [] }),
    prefsStore: store({ overrides: [] }),
    usage,
    getConfig: () => structuredClone(DEFAULT_CONFIG),
    emit: (ch, p) => events.push([ch, p]),
    ...extra,
  });
  return { o, events };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

test('aceita um segundo pedido enquanto o primeiro roda, em paralelo', async () => {
  const { o } = setup();
  const chat = o.create('C:\\tmp');
  const p1 = o.send(chat.id, { text: 'explique a arquitetura do projeto em detalhes', runId: 'r1' });
  await tick();
  assert.equal(o.isRunning(chat.id), true);

  const p2 = o.send(chat.id, { text: 'qual a capital da França?', runId: 'r2' });
  await tick();
  assert.equal(calls.length, 2, 'os dois agentes rodam ao mesmo tempo');
  assert.equal(calls[1].opts.sessionId, undefined, 'o paralelo não reaproveita a sessão em uso');
  assert.match(calls[1].opts.systemPrompt, /rodando em paralelo/);

  calls[1].finish(); // o segundo termina primeiro
  const a2 = await p2;
  assert.equal(a2.parallel, true);
  assert.equal(o.isRunning(chat.id), true, 'o primeiro continua rodando');

  calls[0].finish();
  const a1 = await p1;
  assert.equal(a1.parallel, false);
  assert.equal(o.isRunning(chat.id), false);
  // Só o agente principal guarda a sessão.
  assert.equal(chat.sessions[a1.provider].id, 'sess-0');
});

test('cancelar sem runId para todos os agentes da conversa', async () => {
  const { o } = setup();
  const chat = o.create('C:\\tmp');
  o.send(chat.id, { text: 'tarefa 1 bem longa de análise', runId: 'a' });
  o.send(chat.id, { text: 'tarefa 2', runId: 'b' });
  await tick();
  o.cancel(chat.id);
  assert.ok(calls.every((c) => c.opts.signal.aborted));
  calls.forEach((c) => c.finish());
});

test('pedido para contato vira rascunho e só sai depois da confirmação', async () => {
  const sent = [];
  const whatsappWeb = { send: async (to, text) => { sent.push({ to, text }); return { to: 'João Silva' }; } };
  const { o } = setup({ whatsappWeb });
  const chat = o.create('C:\\tmp');
  const p = o.send(chat.id, { text: 'manda pro João no zap que vou atrasar 10 min', runId: 'w1' });
  await tick();
  assert.match(calls[0].opts.systemPrompt, /\[\[whatsapp para=/);
  calls[0].answer = 'Preparei a mensagem.\n[[whatsapp para="João"]]\nOi João, vou atrasar uns 10 min!\n[[/whatsapp]]';
  calls[0].finish();
  const msg = await p;

  assert.equal(msg.text, 'Preparei a mensagem.');
  assert.equal(msg.whatsappDrafts[0].status, 'pending');
  assert.equal(sent.length, 0, 'nada é enviado sem confirmação');

  const d = await o.confirmWhatsApp(chat.id, msg.id, 0);
  assert.equal(d.status, 'sent');
  assert.deepEqual(sent, [{ to: 'João', text: 'Oi João, vou atrasar uns 10 min!' }]);
});

test('ação local responde sem chamar a IA', async () => {
  const opened = [];
  const { o } = setup({ openExternal: async (u) => opened.push(u) });
  const chat = o.create('C:\\tmp');
  const msg = await o.send(chat.id, { text: 'pesquisa no Google receita de bolo', runId: 'g1' });
  assert.equal(calls.length, 0);
  assert.equal(msg.provider, 'local');
  assert.deepEqual(opened, ['https://www.google.com/search?q=receita%20de%20bolo']);
});

test('oferece se alterar e, com o "sim", implementa no próprio repositório com o modelo forte', async () => {
  const { o } = setup();
  const chat = o.create('C:\\tmp');
  const p1 = o.send(chat.id, { text: 'lê esse PDF pra mim', runId: 'm1' });
  await tick();
  assert.match(calls[0].opts.systemPrompt, /resolutiva/);
  assert.match(calls[0].opts.systemPrompt, /bom humor/);
  calls[0].answer = 'Ainda não consigo ler PDF. Quer que eu me altere para aprender?\n[[melhoria: ler arquivos PDF anexados]]';
  calls[0].finish();
  const offer = await p1;
  assert.equal(offer.text, 'Ainda não consigo ler PDF. Quer que eu me altere para aprender?', 'a marcação some do texto');
  assert.equal(offer.improvementOffer, 'ler arquivos PDF anexados');

  const p2 = o.send(chat.id, { text: 'sim, pode fazer', runId: 'm2' });
  await tick();
  const run = calls[1].opts;
  assert.equal(run.cwd, 'C:\\repositorios\\Projetos-Pessoais\\ohara');
  assert.equal(run.model, 'opus');
  assert.match(run.prompt, /aceitou que você se altere para conseguir: ler arquivos PDF anexados/);
  assert.match(run.prompt, /Pedido original dele: "lê esse PDF pra mim"/);
  assert.equal(run.sessionId, undefined);
  calls[1].finish();
  await p2;
  assert.equal(chat.cwd, 'C:\\tmp', 'a conversa continua na pasta dela');
});

test('a oferta vale só para a resposta seguinte', async () => {
  const { o } = setup();
  const chat = o.create('C:\\tmp');
  const p1 = o.send(chat.id, { text: 'manda um fax', runId: 'f1' });
  await tick();
  calls[0].answer = 'Não tenho fax.\n[[melhoria: enviar fax]]';
  calls[0].finish();
  await p1;
  const p2 = o.send(chat.id, { text: 'deixa, me fala a previsão do tempo', runId: 'f2' });
  await tick();
  assert.notEqual(calls[1].opts.cwd, 'C:\\repositorios\\Projetos-Pessoais\\ohara');
  calls[1].finish();
  await p2;
  const p3 = o.send(chat.id, { text: 'sim', runId: 'f3' });
  await tick();
  assert.equal(calls[2].opts.cwd, 'C:\\tmp', '"sim" atrasado não dispara a automelhoria');
  calls[2].finish();
  await p3;
});

async function draftChat(extra = {}) {
  const sent = [];
  const whatsappWeb = { send: async (to, text) => { sent.push({ to, text }); return { to: 'Tata Souza' }; } };
  const { o, events } = setup({ whatsappWeb, ...extra });
  const chat = o.create('C:\\tmp');
  const p = o.send(chat.id, { text: 'envia mensagem pra Tata no meu WhatsApp se apresentando', runId: 'd1' });
  await tick();
  calls[0].answer = 'Preparei a mensagem.\n[[whatsapp para="Tata"]]\nOi! Aqui é a Ohara.\n[[/whatsapp]]';
  calls[0].finish();
  const draft = await p;
  return { o, events, chat, draft, sent };
}

test('"confirmado" por texto envia o rascunho pendente sem outro clique e sem chamar a IA', async () => {
  const { o, chat, draft, sent } = await draftChat();
  const reply = await o.send(chat.id, { text: 'confirmado', runId: 'd2' });
  assert.equal(calls.length, 1, 'a confirmação não passa pela IA');
  assert.deepEqual(sent, [{ to: 'Tata', text: 'Oi! Aqui é a Ohara.' }]);
  assert.equal(draft.whatsappDrafts[0].status, 'sent');
  assert.equal(reply.provider, 'local');
  assert.match(reply.text, /enviei a mensagem para Tata Souza/);

  // Já enviado: um segundo "envia" não manda de novo, vai para a IA.
  const p = o.send(chat.id, { text: 'envia', runId: 'd3' });
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(sent.length, 1);
  calls[1].finish();
  await p;
});

test('confirmação por voz também envia e a resposta é curta para falar', async () => {
  const { o, chat, sent, events } = await draftChat();
  const reply = await o.send(chat.id, { text: 'Pode enviar a mensagem.', source: 'voice', runId: 'v1' });
  assert.equal(sent.length, 1);
  assert.equal(reply.text, 'Pronto, enviei a mensagem para Tata Souza no WhatsApp.');
  assert.ok(events.some(([ch, p]) => ch === 'chat:done' && p.runId === 'v1' && p.source === 'voice'));
});

test('"cancela" descarta o rascunho e um pedido novo segue para a IA', async () => {
  const { o, chat, draft, sent } = await draftChat();
  // Troca de IA de propósito: a outra só conhece o rascunho pelo contexto transferido.
  const other = draft.provider === 'codex' ? 'claude:rapido' : 'codex';
  const p = o.send(chat.id, { text: 'muda o texto pra ficar mais curto', override: other, runId: 'c1' });
  await tick();
  assert.equal(calls.length, 2, 'ajuste no texto vai para a IA');
  assert.match(calls[1].opts.prompt, /Mensagem de WhatsApp para "Tata" \(aguardando confirmação\): Oi! Aqui é a Ohara\./, 'a IA vê o rascunho');
  calls[1].answer = 'Encurtei.\n[[whatsapp para="Tata"]]\nOi, sou a Ohara!\n[[/whatsapp]]';
  calls[1].finish();
  const second = await p;
  assert.equal(second.whatsappDrafts[0].status, 'pending', 'o rascunho vale mesmo sem citar o WhatsApp no pedido');

  const reply = await o.send(chat.id, { text: 'não envia, cancela', runId: 'c2' });
  assert.equal(second.whatsappDrafts[0].status, 'cancelled');
  assert.equal(draft.whatsappDrafts[0].status, 'pending', 'só a última resposta conta');
  assert.match(reply.text, /cancelei/);
  assert.equal(sent.length, 0);
});

test('"sim" com oferta de melhoria aberta é para a melhoria, não para o envio', async () => {
  const sent = [];
  const whatsappWeb = { send: async (to, text) => { sent.push({ to, text }); return { to }; } };
  const { o } = setup({ whatsappWeb });
  const chat = o.create('C:\\tmp');
  const p1 = o.send(chat.id, { text: 'manda pra Tata no zap um oi', runId: 's1' });
  await tick();
  calls[0].answer = 'Preparei.\n[[whatsapp para="Tata"]]\nOi!\n[[/whatsapp]]\nPosso aprender a enviar sozinha.\n[[melhoria: enviar sem confirmação]]';
  calls[0].finish();
  await p1;
  const p2 = o.send(chat.id, { text: 'sim', runId: 's2' });
  await tick();
  assert.equal(sent.length, 0);
  assert.equal(calls[1].opts.cwd, 'C:\\repositorios\\Projetos-Pessoais\\ohara');
  calls[1].finish();
  await p2;
});
