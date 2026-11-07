// Configuração padrão. O usuário pode sobrescrever qualquer chave em
// %APPDATA%/central-ia/config.json (o app cria o arquivo na primeira execução).

const DEFAULT_CONFIG = {
  // Pasta padrão de trabalho dos agentes.
  workspaceRoot: 'C:\\repositorios',
  defaultCwd: 'C:\\Users\\gabri',

  // Atalho global para mostrar/esconder a janela.
  hotkey: 'CommandOrControl+Space',

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

  // Limites de uso (0 a 1) que mudam o roteamento.
  quota: {
    claudeDowngradeAt: 0.7, // acima disso, opus vira sonnet
    claudeAvoidAt: 0.9, // acima disso, tarefas vão para o Codex quando possível
    codexAvoidAt: 0.9, // acima disso, tarefas de código voltam para o Claude
  },

  // Reuniões: transcripts salvos pelo bot após cada call.
  meetings: {
    enabled: true,
    folder: 'C:\\Users\\gabri\\Downloads\\Gutenberg',
    selfName: 'Gabriel',
    provider: 'auto', // auto (Claude, cai para o Codex se a cota apertar) | claude | codex
    model: 'sonnet',
    effort: 'medium',
    stableSeconds: 30, // espera o arquivo parar de mudar
    minUtterances: 15, // abaixo disso a reunião é ignorada (não gasta token)
    ignoreBefore: null, // "AAAA-MM-DD": não processa reuniões anteriores
  },

  voice: {
    ttsVoice: 'Microsoft Maria Desktop',
    speakReplies: false,
  },
};

module.exports = { DEFAULT_CONFIG };
