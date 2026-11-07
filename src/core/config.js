// Configuração padrão. O usuário pode sobrescrever qualquer chave em
// %APPDATA%/central-ia/config.json (o app cria o arquivo na primeira execução).

const DEFAULT_CONFIG = {
  // Pasta padrão de trabalho dos agentes.
  workspaceRoot: 'C:\\repositorios',
  defaultCwd: 'C:\\Users\\gabri',
  // Onde salvar arquivos gerados para você (exportações de reunião etc.).
  outputDir: 'C:\\Users\\gabri\\Claude\\Central-IA',

  hotkeys: {
    toggle: 'CommandOrControl+Space', // mostra/esconde a janela principal
    quick: 'Alt+Space', // janela rápida
    clipboard: 'CommandOrControl+Alt+Space', // janela rápida com o conteúdo copiado
    voice: 'CommandOrControl+Alt+V', // fala → texto (Whisper)
  },

  claude: {
    bin: 'claude',
    // "auto" = o próprio Claude Code decide com classificador de segurança.
    // "bypassPermissions" = acesso total (ative no app só quando quiser).
    permissionMode: 'auto',
    models: {
      rapido: 'haiku',
      equilibrado: 'sonnet',
      profundo: 'opus',
    },
  },

  codex: {
    // Vazio = usa o modelo padrão configurado no ~/.codex/config.toml.
    model: '',
    sandbox: 'workspace-write',
  },

  // Limites de uso (0 a 1) que mudam o roteamento do chat.
  quota: {
    claudeDowngradeAt: 0.7, // acima disso, opus vira sonnet
    claudeAvoidAt: 0.9, // acima disso, tarefas vão para o Codex quando possível
    codexAvoidAt: 0.9, // acima disso, tarefas de código voltam para o Claude
  },

  // Orçamento das funções automáticas (segundo plano): acima destes limites elas
  // trocam de IA e, se as duas estiverem altas, esperam a janela renovar.
  budgets: {
    backgroundClaude: 0.7,
    backgroundCodex: 0.85,
  },

  // Modelo e prioridade de cada função automática.
  // model: rapido | equilibrado | profundo (ou um id); provider: auto | claude | codex
  features: {
    meetings: { background: true, model: 'equilibrado', effort: 'medium', provider: 'auto' },
    briefing: { background: true, model: 'rapido', effort: 'low', provider: 'auto' },
    busca: { background: false, model: 'equilibrado', effort: 'medium', provider: 'auto' },
    cobranca: { background: false, model: 'rapido', effort: 'low', provider: 'auto' },
    slack: { background: true, model: 'rapido', effort: 'low', provider: 'auto' },
  },

  // Roteador que aprende com as suas trocas manuais de modelo.
  learning: {
    enabled: true,
    minVotes: 3, // quantas escolhas iguais (das últimas 5) para virar padrão
  },

  // Reuniões: transcripts salvos pelo bot após cada call.
  meetings: {
    enabled: true,
    folder: 'C:\\Users\\gabri\\Downloads\\Gutenberg',
    selfName: 'Gabriel',
    stableSeconds: 30, // espera o arquivo parar de mudar
    minUtterances: 15, // abaixo disso a reunião é ignorada (não gasta token)
    ignoreBefore: null, // "AAAA-MM-DD": não processa reuniões anteriores
    prepMinutes: 5, // aviso com a pauta antes de reuniões recorrentes
  },

  integrations: {
    // Google Agenda → Configurações → (sua agenda) → "Endereço secreto no formato iCal".
    calendarIcsUrl: '',
    github: {
      enabled: true,
      // Contas do `gh` a consultar (precisam estar logadas: gh auth login).
      accounts: ['Gabs-X'],
    },
    slack: {
      // Token de usuário (xoxp-...) de um app Slack com os escopos do README.
      token: '',
      importMentions: false,
    },
  },

  voice: {
    ttsVoice: 'Microsoft Maria Desktop',
    speakReplies: false,
    whisperModel: 'base', // tiny | base | small (maior = mais preciso e mais lento)
    language: 'pt',
    wakeWord: false, // escuta contínua: diga "Central, ..." (precisa do Whisper)
    autoSendVoice: true, // na janela rápida, envia assim que transcreve
  },
};

module.exports = { DEFAULT_CONFIG };
