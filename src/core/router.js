// Roteador: decide qual IA (Claude ou Codex), qual modelo e qual esforço usar
// para cada pedido. É 100% local (heurística), então não gasta token para decidir.

const CATEGORIES = {
  rapida: {
    label: 'Pergunta rápida',
    target: { provider: 'claude', tier: 'rapido', effort: 'low' },
  },
  geral: {
    label: 'Pedido geral',
    target: { provider: 'claude', tier: 'equilibrado', effort: 'medium' },
  },
  sistema: {
    label: 'Comando no Windows',
    target: { provider: 'claude', tier: 'equilibrado', effort: 'low' },
  },
  codigo: {
    label: 'Código',
    target: { provider: 'codex', effort: 'medium' },
  },
  codigo_complexo: {
    label: 'Código complexo / arquitetura',
    target: { provider: 'claude', tier: 'profundo', effort: 'high' },
  },
  pesquisa: {
    label: 'Pesquisa na web',
    target: { provider: 'claude', tier: 'equilibrado', effort: 'medium' },
  },
  escrita: {
    label: 'Escrita / texto',
    target: { provider: 'claude', tier: 'equilibrado', effort: 'medium' },
  },
  raciocinio: {
    label: 'Planejamento / análise',
    target: { provider: 'claude', tier: 'profundo', effort: 'high' },
  },
  visao: {
    label: 'Imagem / tela',
    target: { provider: 'claude', tier: 'equilibrado', effort: 'medium' },
  },
};

// Palavras-chave por categoria (sem acento; o texto é normalizado antes).
const KEYWORDS = {
  sistema: [
    'abre', 'abrir', 'abra', 'fecha', 'fechar', 'feche', 'executa', 'executar', 'execute', 'rode', 'rodar',
    'powershell', 'cmd', 'terminal', 'instala', 'instalar', 'instale', 'desinstal', 'processo', 'pasta',
    'diretorio', 'mover', 'mova', 'copiar', 'copie', 'renomear', 'renomeie', 'apagar', 'apague', 'deletar',
    'espaco em disco', 'wifi', 'volume', 'desligar', 'reiniciar', 'programa', 'aplicativo', 'app ',
    'area de trabalho', 'downloads', 'notepad', 'explorer', 'spotify', 'discord', 'obs', 'vscode',
  ],
  codigo: [
    'codigo', 'funcao', 'funcoes', 'funcionalidade', 'botao', 'botoes', 'butao', 'butoes', 'tela', 'telas',
    'interface', 'layout', 'frontend', 'front-end', 'backend', 'back-end', 'feature', 'bug', 'erro', 'corrige', 'corrija', 'corrigir', 'implementa', 'implemente',
    'implementar', 'refatora', 'refatore', 'teste', 'testes', 'commit', 'branch', 'git ', 'repositorio',
    'repo', 'componente', 'endpoint', 'api', 'script', 'typescript', 'javascript', 'python', 'react',
    'node', 'npm', 'css', 'html', 'sql', 'banco de dados', 'deploy', 'build', 'compila', 'lint', 'classe',
    'metodo', 'variavel', 'stack trace', 'exception', 'pull request', ' pr ',
  ],
  complexo: [
    'arquitetura', 'projeto inteiro', 'todo o projeto', 'do zero', 'sistema completo', 'migrar', 'migracao',
    'reescrever', 'reescreva', 'escalabilidade', 'seguranca', 'auditoria', 'performance', 'otimiza',
    'dificil', 'complexo', 'investigue', 'investigar', 'causa raiz', 'todos os', 'todas as', 'tudo',
    'revisar', 'revise', 'revisao geral',
  ],
  pesquisa: [
    'pesquisa', 'pesquise', 'pesquisar', 'busca na internet', 'procure na internet', 'procura na web',
    'noticia', 'noticias', 'preco', 'cotacao', 'hoje', 'atual', 'ultimas', 'site', 'google', 'web',
    'link', 'documentacao oficial', 'navegador', 'chrome',
  ],
  escrita: [
    'escreva', 'escreve', 'redija', 'redigir', 'email', 'e-mail', 'mensagem', 'post', 'legenda', 'texto',
    'resuma', 'resumo', 'traduza', 'traducao', 'revise', 'reescreva o texto', 'carta', 'proposta', 'roteiro',
  ],
  raciocinio: [
    'planeje', 'planejar', 'plano', 'estrategia', 'compare', 'comparar', 'analise', 'analisar', 'decida',
    'decidir', 'pros e contras', 'vale a pena', 'qual o melhor', 'recomende', 'avalie',
  ],
};

function normalize(text) {
  return ` ${String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')} `;
}

function countHits(text, words) {
  let hits = 0;
  for (const w of words) if (text.includes(w)) hits++;
  return hits;
}

// Acha um projeto citado pelo nome ("taverna bot" → taverna-bot).
function findProject(text, projects = []) {
  const flat = text.replace(/[-_]/g, ' ');
  let found = null;
  for (const p of projects) {
    const name = normalize(p.name).trim().replace(/[-_]/g, ' ');
    if (name.length < 4) continue;
    if (flat.includes(` ${name} `) || flat.includes(` ${name.replace(/ /g, '')} `)) {
      if (!found || name.length > found.len) found = { ...p, len: name.length };
    }
  }
  return found && { name: found.name, path: found.path };
}

const CONTINUABLE = new Set(['codigo', 'codigo_complexo', 'raciocinio', 'pesquisa', 'escrita', 'sistema']);

/**
 * @param {string} prompt
 * @param {object} [o]
 * @param {boolean} [o.hasImage]
 * @param {{name:string, path:string}[]} [o.projects] repositórios conhecidos
 * @param {string} [o.previous] categoria do último pedido desta conversa
 */
function classify(prompt, { hasImage = false, projects = [], previous = null } = {}) {
  const text = normalize(prompt);
  const words = text.trim().split(' ').filter(Boolean).length;

  if (hasImage) return { category: 'visao', scores: {} };

  const project = findProject(text, projects);
  const scores = {
    sistema: countHits(text, KEYWORDS.sistema) * 1.2,
    codigo: countHits(text, KEYWORDS.codigo) * 1.5 + (project ? 2 : 0),
    pesquisa: countHits(text, KEYWORDS.pesquisa) * 1.3,
    escrita: countHits(text, KEYWORDS.escrita),
    raciocinio: countHits(text, KEYWORDS.raciocinio),
  };
  const complexo = countHits(text, KEYWORDS.complexo);

  // Pedidos longos tendem a ser mais complexos.
  if (words > 120) scores.raciocinio += 1;

  const [best, bestScore] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];

  if (bestScore === 0) {
    // "pode fazer", "e o resto?" no meio de uma tarefa: segue a categoria da conversa.
    const courtesy = /^ (ok|okay|obrigad|valeu|vlw|blz|beleza|oi|ola|opa|bom dia|boa tarde|boa noite|tchau)\b/.test(text);
    if (previous && CONTINUABLE.has(previous) && words <= 40 && !courtesy) return { category: previous, scores, project, continued: true };
    // Só cumprimento ou pergunta curta vai para o Haiku; pedido mais longo e vago vai para o Sonnet.
    return { category: words <= 12 ? 'rapida' : words <= 40 ? 'geral' : 'raciocinio', scores, project };
  }
  if (best === 'codigo' && (complexo >= 1 || words > 150)) {
    return { category: 'codigo_complexo', scores, project };
  }
  if (best === 'raciocinio' && complexo === 0 && bestScore <= 1 && words <= 15) {
    // "qual o melhor X?" curto não precisa de Opus.
    return { category: 'escrita', scores, project };
  }
  return { category: best, scores, project };
}

// Retorna o maior uso (0..1) entre as janelas conhecidas de um provedor.
function maxUtil(usage) {
  if (!usage) return 0;
  return Math.max(usage.fiveHour ?? 0, usage.weekly ?? 0);
}

/**
 * Decide a rota final.
 * @param {string} prompt
 * @param {object} opts { hasImage, override, usage: { claude, codex }, config }
 */
function route(prompt, opts = {}) {
  const { hasImage = false, override = 'auto', usage = {}, config } = opts;
  const models = config.claude.models;
  const reasons = [];

  // Escolha manual na interface.
  if (override && override !== 'auto') {
    const [provider, tier] = override.split(':');
    if (provider === 'codex') {
      return { provider: 'codex', model: config.codex.model || 'padrão', effort: tier || 'medium', category: 'manual', label: 'Escolha manual', reasons: ['escolhido manualmente'] };
    }
    return { provider: 'claude', model: models[tier] || tier, tier, effort: tier === 'profundo' ? 'high' : 'medium', category: 'manual', label: 'Escolha manual', reasons: ['escolhido manualmente'] };
  }

  const { category, project, continued } = classify(prompt, { hasImage, projects: opts.projects, previous: opts.previous });
  const cat = CATEGORIES[category];
  let { provider, tier, effort } = { ...cat.target };
  reasons.push(`categoria: ${cat.label}`);
  if (continued) reasons.push('continua o assunto da conversa');
  if (project) reasons.push(`projeto citado: ${project.name}`);

  // Preferência aprendida: você costuma trocar esta categoria para outro modelo.
  const learned = opts.learned?.[category];
  if (learned) {
    const [lp, lt] = learned.split(':');
    if (lp === 'codex') {
      provider = 'codex';
      effort = lt === 'high' ? 'high' : lt === 'low' ? 'low' : 'medium';
    } else if (models[lt]) {
      provider = 'claude';
      tier = lt;
      effort = lt === 'profundo' ? 'high' : lt === 'rapido' ? 'low' : 'medium';
    }
    reasons.push(`aprendido: você costuma usar ${learnedLabel(learned)} aqui`);
  }

  const claudeUtil = maxUtil(usage.claude);
  const codexUtil = maxUtil(usage.codex);
  const claudeBlocked = usage.claude?.status === 'rejected';
  const codexBlocked = codexUtil >= 0.99;
  const q = config.quota;

  // O Codex também executa comandos e aceita imagem (-i), então serve de reserva para tudo.
  if (provider === 'claude') {
    if ((claudeBlocked || claudeUtil >= q.claudeAvoidAt) && !codexBlocked && codexUtil < q.codexAvoidAt) {
      provider = 'codex';
      reasons.push(`cota do Claude em ${Math.round(claudeUtil * 100)}%: enviado ao Codex`);
    } else if (tier === 'profundo' && claudeUtil >= q.claudeDowngradeAt) {
      tier = 'equilibrado';
      reasons.push(`cota do Claude em ${Math.round(claudeUtil * 100)}%: Opus trocado por Sonnet`);
    }
  } else if (provider === 'codex') {
    if ((codexBlocked || codexUtil >= q.codexAvoidAt) && !claudeBlocked && claudeUtil < q.claudeAvoidAt) {
      provider = 'claude';
      tier = 'equilibrado';
      reasons.push(`cota do Codex em ${Math.round(codexUtil * 100)}%: enviado ao Claude`);
    }
  }

  if (provider === 'codex') {
    return { provider, model: config.codex.model || 'padrão', effort, category, label: cat.label, reasons, project };
  }
  return { provider, tier, model: models[tier], effort, category, label: cat.label, reasons, project };
}

function learnedLabel(choice) {
  return (
    { 'claude:rapido': 'Haiku', 'claude:equilibrado': 'Sonnet', 'claude:profundo': 'Opus', 'codex:medium': 'Codex', 'codex:high': 'Codex (alto)', 'codex:low': 'Codex' }[choice] ||
    choice
  );
}

/**
 * Transforma o histórico de trocas manuais em preferências por categoria.
 * @param {{category:string, choice:string}[]} overrides
 */
function learnPreferences(overrides, minVotes = 3) {
  const byCat = {};
  for (const o of overrides) (byCat[o.category] ||= []).push(o.choice);
  const out = {};
  for (const [cat, choices] of Object.entries(byCat)) {
    const recent = choices.slice(-5);
    const counts = {};
    for (const c of recent) counts[c] = (counts[c] || 0) + 1;
    const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (n >= minVotes) out[cat] = best;
  }
  return out;
}

module.exports = { route, classify, learnPreferences, learnedLabel, CATEGORIES, normalize };
