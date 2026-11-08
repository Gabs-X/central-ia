# Ohara

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

Os dados ficam em `%APPDATA%\Ohara\`. Na primeira execução, os dados da antiga Central IA (`%APPDATA%\central-ia\`) são copiados para lá.

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

## Gerar o executável

```powershell
npm run dist
```

Isso gera, na pasta `dist\`:

- `Ohara-Setup-<versão>.exe`: instalador com atalho na área de trabalho e no menu Iniciar.
- `Ohara-Portatil-<versão>.exe`: roda direto, sem instalar.

O ícone é aplicado pelo `build/after-pack.js` (rcedit), porque a assinatura do electron-builder exige permissão de link simbólico no Windows.
Os executáveis não são assinados, então o SmartScreen pode avisar na primeira execução: clique em "Mais informações" e depois em "Executar assim mesmo".

## Reuniões e painel de demandas

A central observa `C:\Users\gabri\Downloads\Gutenberg`, onde o bot salva um transcript `.md` no fim de cada call. Para cada reunião nova:

1. Espera 30 s com o arquivo parado e junta as partes de reconexão (`-2`, `-3`).
2. Limpa as falas repetidas do reconhecimento de voz.
3. Ignora reuniões curtas (menos de 15 falas) ou em que só uma pessoa falou, sem gastar token.
4. Manda a transcrição ao Claude Sonnet, sem ferramentas e com saída em JSON validado. Se a cota do Claude passar de 90%, usa o Codex.
5. Salva o resumo, os tópicos, as decisões e os combinados com outras pessoas, e manda o que ficou para você ao painel. Uma notificação do Windows avisa.

No painel (aba **Reuniões**):

- As demandas ficam em três colunas: **A fazer**, **Em andamento** e **Feito**. Dá pra arrastar entre colunas e editar com clique duplo.
- Cada demanda mostra o prazo (com destaque se estiver atrasada), a prioridade, quem pediu e o trecho da call.
- **Resolver com IA** abre uma conversa já com o contexto da demanda e da reunião.
- Clicar na reunião de origem abre o resumo completo. Ali dá pra **Reprocessar** ou abrir o transcript.
- Se a reunião ganhar uma parte nova, ela é reprocessada. Demandas em que você já mexeu são mantidas.

O app precisa estar aberto para monitorar a pasta. No app instalado, ative **Iniciar com o Windows** no menu da bandeja: ele inicia escondido. Os transcripts que chegarem com o app fechado são processados quando ele abrir.

Para ajustar (em `config.json`): `meetings.folder`, `meetings.model`, `meetings.minUtterances`, `meetings.ignoreBefore` (não processar reuniões antigas) e `meetings.enabled`.

## Novidades da 0.3

### Telas
| Aba | O que tem |
|---|---|
| ☀️ **Hoje** | Demandas atrasadas, para hoje e para os próximos 3 dias. Próximas reuniões com a pauta (o que você deve a essas pessoas e o que elas te devem). O que outras pessoas te devem. PRs do GitHub. Briefing com IA. |
| 💬 **Conversas** | O chat de sempre. O 🎤 agora usa o Whisper local quando ele está instalado. |
| 📋 **Reuniões** | Painel com a coluna **Aguardando outros** (com **Cobrar**), **busca** em todas as transcrições, **Pessoas** e a página de cada reunião com **Copiar/Salvar .md/E-mail**. |
| ⚡ **Automações** | Atalhos de rotina (um clique, também no menu da bandeja) e agendamentos. |
| 📊 **Uso** | Tokens por dia e por função, evolução da cota, orçamento e o que o roteador aprendeu. |
| ⚙️ **Ajustes** | Agenda, GitHub, Slack, voz, atalhos, reuniões e geral. |

### Atalhos globais (padrão)
| Atalho | Ação |
|---|---|
| `Ctrl+Espaço` | Mostra ou esconde a Central. |
| `Alt+Espaço` | Janela rápida: pergunta e resposta por cima de tudo. |
| `Ctrl+Alt+Espaço` | Janela rápida com o que você copiou: Explicar, Traduzir, Corrigir, Resumir, Diagnosticar erro. |
| `Ctrl+Alt+V` | Fala: grava, transcreve com o Whisper e envia. |

### Funções automáticas e orçamento
Reuniões, briefings e importação do Slack são **de segundo plano**. Elas usam o Claude até o limite do orçamento (padrão: 70%), depois passam para o Codex (até 85%) e, se as duas cotas estiverem altas, **esperam a janela renovar**. Assim sempre sobra cota pra você no chat. Dá pra ajustar em **Uso**.

### Roteador que aprende
Quando você troca o modelo manualmente 3 vezes (das últimas 5) para o mesmo tipo de pedido, essa escolha vira o padrão daquela categoria. Dá pra ver e apagar o que ele aprendeu em **Uso**.

### Aguardando outros e cobranças
Cada reunião também registra o que os outros combinaram de fazer. A IA marca o que depende de você (`para_mim`); o resto fica escondido em "ver todos os combinados". Quando passa do prazo, chega uma notificação (às 10h e às 15h). **Cobrar** gera a mensagem para você copiar ou, com o Slack conectado, enviar por DM.

### Pauta antes da call
Se uma reunião tem o mesmo código do Meet em dias diferentes, ela é tratada como recorrente e a Central aprende o horário. Com a agenda conectada, vale para todos os eventos. Alguns minutos antes, chega a pauta: pendências com essas pessoas e o resumo da última vez.

### Integrações
- **Agenda:** endereço secreto iCal do Google Agenda, sem OAuth. Eventos recorrentes são expandidos e o link do Meet é ligado ao transcript.
- **GitHub:** usa o `gh` já logado; as contas ficam em Ajustes.
- **Slack:** token de usuário (`xoxp-`) com `search:read`, `users:read`, `im:write` e `chat:write`. Envia cobranças por DM e importa menções como demandas.
- **Voz:** whisper.cpp local. Instale em Ajustes → Voz: baixa o binário oficial e o modelo (`tiny`, `base` ou `small`). A escuta contínua ("Central, …") é opcional.

O token do Slack e o endereço da agenda ficam **criptografados com o DPAPI do Windows** (`safeStorage`) no `config.json`, e a interface nunca recebe o valor real.

### Desenvolvimento
- `CENTRAL_DATA_DIR=pasta` roda com outra pasta de dados, ao lado do app instalado.
- `CENTRAL_SNAPSHOT=print.png CENTRAL_VIEW=today` salva um print da tela e fecha; os erros do console vão para `print.png.log`.
- `CENTRAL_SNAPSHOT_QUICK=print.png` faz o mesmo para a janela rápida.
