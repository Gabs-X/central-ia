# Central IA

App desktop (Electron) que usa as **suas assinaturas** do Claude Code e do Codex como um assistente para o PC inteiro.
Para cada pedido, ela escolhe a IA, o modelo e o nível de esforço mais adequados e acompanha a cota de cada assinatura.

## Como rodar

```powershell
npm install
npm start          # abre o app (fica na bandeja)
npm run dev        # mesmo, com DevTools
npm test           # testes do roteador
```

Requisitos: `claude` e `codex` instalados e logados (`claude` e `codex login`).

**Atalho global:** `Ctrl+Espaço` mostra ou esconde a janela. Fechar a janela só a esconde; para sair, use **Sair** no ícone da bandeja.

## O que ela faz

| Recurso | Como funciona |
|---|---|
| Arquivos e repositórios | Escolha a pasta no topo (lista os repositórios de `C:\repositorios`). Os agentes trabalham nela. |
| Comandos e apps do Windows | O Claude Code usa PowerShell (abrir programas, consultar o sistema, mexer em arquivos). |
| Web | O Claude pesquisa e lê páginas (WebSearch/WebFetch); links nas respostas abrem no navegador. |
| Captura de tela | 🖥️ esconde a janela, captura o monitor onde está o mouse e anexa ao pedido. |
| Imagens | 🖼️ anexa arquivos de imagem. |
| Voz | 🎤 abre a digitação por voz do Windows (Win+H, entende pt-BR). Com **Voz** marcado, as respostas são lidas pela voz "Maria". |
| Conversas | Ficam salvas. Dá pra trocar de IA no meio da conversa e o contexto vai junto. |

## Roteamento automático

É feito localmente, por palavras-chave, então não gasta token para decidir.

| Categoria | Destino |
|---|---|
| Pergunta rápida | Claude **Haiku**, esforço baixo |
| Comando no Windows | Claude **Sonnet**, esforço baixo |
| Código (bug, teste, feature) | **Codex** |
| Código complexo / arquitetura | Claude **Opus**, esforço alto |
| Pesquisa na web | Claude **Sonnet** |
| Escrita / texto | Claude **Sonnet** |
| Planejamento / análise | Claude **Opus**, esforço alto |
| Imagem / tela | Claude **Sonnet** |

Enquanto você digita, a barra abaixo do campo mostra para onde o pedido vai. O seletor **Automático** permite forçar um modelo.

### Gestão de cota

- **Claude:** o CLI informa o uso real das janelas de 5h e 7 dias a cada pedido.
- **Codex:** o uso é lido do `rate_limits` das sessões em `~/.codex/sessions`.
- Acima de **70%** no Claude, o Opus vira Sonnet. Acima de **90%**, os pedidos vão para o Codex. Acima de **90%** no Codex, código volta para o Claude.
- O painel lateral mostra as barras de uso, quando cada janela renova e os tokens do dia.

## Segurança

- Por padrão, o Claude roda em `--permission-mode auto` (um classificador aprova ou bloqueia cada ação) e o Codex em `workspace-write`, que só escreve na pasta escolhida.
- **Acesso total** (no topo) libera tudo (`bypassPermissions` / `danger-full-access`). Use com cuidado.
- O prompt de sistema manda a IA pedir confirmação antes de qualquer ação destrutiva.

## Configuração

Os dados ficam em `%APPDATA%\central-ia\`:

- `config.json`: sobrescreve os valores de `src/core/config.js` (atalho, modelos, limites de cota, voz, pasta raiz).
- `chats.json`: conversas.
- `usage.json`: histórico de tokens e últimas cotas.
- `capturas\`: prints de tela anexados.

Exemplo de `config.json`:

```json
{
  "hotkey": "Alt+Space",
  "codex": { "model": "gpt-6.1-sol" },
  "quota": { "claudeDowngradeAt": 0.6 }
}
```

## Estrutura

```
src/
  main.js              janela, bandeja, atalho, captura, IPC
  preload.js           ponte segura renderer ↔ main
  core/
    router.js          classificação e escolha de modelo (com cota)
    orchestrator.js    conversas, sessões, transferência de contexto
    usage.js           tokens e cota (Claude + Codex)
    providers/         claude.js, codex.js: chamam os CLIs em modo JSON
    system.js          voz (TTS), ditado, lista de repositórios
  renderer/            interface (HTML/CSS/JS puro)
```
