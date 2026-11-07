const test = require('node:test');
const assert = require('node:assert');
const { route, classify } = require('../src/core/router');
const { DEFAULT_CONFIG: config } = require('../src/core/config');

const r = (prompt, extra = {}) => route(prompt, { config, usage: {}, ...extra });

test('pergunta curta vai para o Haiku', () => {
  const d = r('quanto é 15% de 240?');
  assert.equal(d.provider, 'claude');
  assert.equal(d.model, 'haiku');
});

test('comando no Windows vai para o Claude com ferramentas', () => {
  assert.equal(classify('abre o spotify pra mim').category, 'sistema');
  assert.equal(r('abre o spotify pra mim').provider, 'claude');
});

test('tarefa de código vai para o Codex', () => {
  const d = r('corrige o bug na função de login do repositório');
  assert.equal(d.category, 'codigo');
  assert.equal(d.provider, 'codex');
});

test('código complexo vai para o Opus', () => {
  const d = r('refatore a arquitetura do projeto inteiro e corrija o bug de performance');
  assert.equal(d.category, 'codigo_complexo');
  assert.equal(d.model, 'opus');
});

test('pesquisa vai para o Sonnet', () => {
  const d = r('pesquise as últimas notícias sobre o Electron');
  assert.equal(d.category, 'pesquisa');
  assert.equal(d.model, 'sonnet');
});

test('imagem anexada vai para visão', () => {
  assert.equal(r('o que é isso?', { hasImage: true }).category, 'visao');
});

test('cota alta do Claude troca Opus por Sonnet', () => {
  const d = r('planeje a estratégia de lançamento do meu SaaS com prós e contras de cada canal, considerando custo, prazo e risco de cada etapa', {
    usage: { claude: { fiveHour: 0.75, weekly: 0.2 } },
  });
  assert.equal(d.model, 'sonnet');
  assert.ok(d.reasons.some((x) => x.includes('Opus trocado')));
});

test('cota esgotada do Claude manda para o Codex', () => {
  const d = r('escreva um email para o cliente', { usage: { claude: { fiveHour: 0.95 }, codex: { fiveHour: 0.1 } } });
  assert.equal(d.provider, 'codex');
});

test('cota esgotada do Codex devolve código ao Claude', () => {
  const d = r('implemente testes para o componente', { usage: { codex: { fiveHour: 0.95 }, claude: { fiveHour: 0.1 } } });
  assert.equal(d.provider, 'claude');
});

test('escolha manual tem prioridade', () => {
  const d = r('oi', { override: 'claude:profundo' });
  assert.equal(d.model, 'opus');
});

const projects = [
  { name: 'central-ia', path: 'C:/repositorios/Projetos-Pessoais/central-ia' },
  { name: 'taverna-bot', path: 'C:/repositorios/Projetos-Pessoais/taverna-bot' },
];

test('pedido de mudança no app citando o projeto não vai para o Haiku', () => {
  const p = 'vamos fazer um ajuste e uma melhora em todos os butoes e funcoes da central IA e revisar se tudo esta funcionando como deveria melhorando e otimizando tudo';
  const d = r(p, { projects });
  assert.equal(d.category, 'codigo_complexo');
  assert.equal(d.model, 'opus');
  assert.equal(d.project.name, 'central-ia');
  assert.notEqual(r('melhore as funcionalidades e botoes da central IA', { projects }).model, 'haiku');
});

test('continuação curta segue a categoria da conversa', () => {
  assert.equal(r('pode fazer', { previous: 'codigo' }).category, 'codigo');
  assert.equal(r('valeu', { previous: 'codigo' }).category, 'rapida');
  assert.equal(r('oi').model, 'haiku');
});

test('pedido vago e mais longo vai para o Sonnet, não para o Haiku', () => {
  const d = r('queria que você desse uma olhada geral nas coisas que eu deixei pendentes por aqui hoje cedo');
  assert.equal(d.model, 'sonnet');
});
