const {
  app, BrowserWindow, Tray, Menu, Notification, globalShortcut, ipcMain, dialog, desktopCapturer, screen, shell, nativeImage, clipboard, session, safeStorage,
} = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_CONFIG } = require('./core/config');
const { JsonStore, deepMerge } = require('./core/store');
const { UsageTracker } = require('./core/usage');
const { Orchestrator } = require('./core/orchestrator');
const { MeetingsService } = require('./core/meetings');
const { Insights } = require('./core/insights');
const { Automations } = require('./core/automations');
const { learnedLabel, CATEGORIES } = require('./core/router');
const { Calendar } = require('./integrations/calendar');
const { GitHub } = require('./integrations/github');
const { Slack } = require('./integrations/slack');
const { Whisper } = require('./integrations/whisper');
const { WhatsApp, formatTasksMessage } = require('./integrations/whatsapp');
const { WhatsAppWeb } = require('./integrations/whatsapp-web');
const system = require('./core/system');
const { trashOldInstallers, uninstallLegacyApp } = require('./core/cleanup');

// Desenvolvimento: CENTRAL_DATA_DIR usa outra pasta de dados (e permite rodar ao lado do app instalado).
if (process.env.CENTRAL_DATA_DIR) app.setPath('userData', process.env.CENTRAL_DATA_DIR);
else migrateLegacyData();

// O app se chamava "Central IA" e guardava os dados em %APPDATA%\central-ia.
// Na primeira execução como Ohara, copia essa pasta para a nova (a antiga fica intacta).
function migrateLegacyData() {
  const target = app.getPath('userData');
  const legacy = path.join(app.getPath('appData'), 'central-ia');
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return;
  try {
    fs.cpSync(legacy, target, { recursive: true });
  } catch (err) {
    console.error('Falha ao migrar os dados da Central IA; usando a pasta antiga.', err);
    app.setPath('userData', legacy);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const dataDir = app.getPath('userData');
const configFile = path.join(dataDir, 'config.json');
const capturesDir = path.join(dataDir, 'capturas');
const ICON = path.join(__dirname, 'assets', 'icon.png');

let win = null;
let quick = null;
let tray = null;
let quitting = false;
const hotkeyStatus = {};

// ---------- Configuração ----------
function readUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    return {};
  }
}

// Segredos (token do Slack, endereço secreto da agenda, chave do WhatsApp) ficam criptografados com o DPAPI do Windows.
const SECRETS = [
  ['integrations', 'slack', 'token'],
  ['integrations', 'calendarIcsUrl'],
  ['integrations', 'whatsapp', 'apikey'],
];
const getIn = (o, p) => p.reduce((x, k) => x?.[k], o);
function setIn(o, p, v) {
  let x = o;
  for (const k of p.slice(0, -1)) x = x[k] ||= {};
  if (v === undefined) delete x[p[p.length - 1]];
  else x[p[p.length - 1]] = v;
}
const encKey = (p) => [...p.slice(0, -1), `${p[p.length - 1]}Enc`];

function encryptSecrets(user) {
  for (const p of SECRETS) {
    const v = getIn(user, p);
    if (v === undefined) continue;
    if (v && safeStorage.isEncryptionAvailable()) {
      setIn(user, encKey(p), safeStorage.encryptString(v).toString('base64'));
      setIn(user, p, undefined);
    } else if (!v) {
      setIn(user, encKey(p), undefined);
    }
  }
  return user;
}

function decryptSecrets(user) {
  for (const p of SECRETS) {
    const enc = getIn(user, encKey(p));
    if (!enc) continue;
    try {
      setIn(user, p, safeStorage.decryptString(Buffer.from(enc, 'base64')));
    } catch {
      /* criptografado em outro usuário do Windows: ignora */
    }
    setIn(user, encKey(p), undefined);
  }
  return user;
}

function loadConfig() {
  if (!fs.existsSync(configFile)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(configFile, '{}');
  }
  const user = decryptSecrets(readUserConfig());
  // Compatibilidade com a 0.1: "hotkey" virou "hotkeys.toggle".
  if (user.hotkey && !user.hotkeys) user.hotkeys = { toggle: user.hotkey };
  return deepMerge(DEFAULT_CONFIG, user);
}

// O que vai para a interface: segredos viram só "configurado".
function publicConfig() {
  const c = structuredClone(config);
  for (const p of SECRETS) {
    const v = getIn(c, p);
    setIn(c, p, v ? '••••••' : '');
    setIn(c, [...p.slice(0, -1), `${p[p.length - 1]}Set`], !!v);
  }
  return c;
}

let config = loadConfig();
const getConfig = () => config;

// ---------- Dados e serviços ----------
const store = (name, defaults) => new JsonStore(path.join(dataDir, name), defaults);
const chatsStore = store('chats.json', { chats: [] });
const usageStore = store('usage.json', { days: {}, limits: { claude: null, codex: null } });
const prefsStore = store('prefs.json', { overrides: [] });
const meetingsStore = store('meetings.json', { meetings: {}, tasks: [], waiting: [] });
const insightsStore = store('insights.json', { briefings: [], prepNotified: {} });
const autoStore = store('automations.json', {});
const stores = [chatsStore, usageStore, prefsStore, meetingsStore, insightsStore, autoStore];

const usage = new UsageTracker(usageStore);

// Envia para todas as janelas (principal e rápida).
const send = (channel, payload) => {
  for (const w of [win, quick]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
};

// Notificação do Windows; ao clicar, abre a tela certa.
function notify(title, body, view = null, chatId = null) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON });
  n.on('click', () => {
    if (view === 'chat' && chatId) {
      showView('chat');
      send('chat:open', chatId);
    } else showView(view || 'today');
  });
  n.show();
}

const whatsapp = new WhatsApp({ getConfig });
const whatsappWeb = new WhatsAppWeb({ icon: ICON });
const orchestrator = new Orchestrator({ chatsStore, prefsStore, usage, getConfig, emit: send, whatsapp, whatsappWeb, openExternal: (url) => shell.openExternal(url) });
const meetings = new MeetingsService({
  store: meetingsStore, usage, getConfig, emit: send, notify: (t, b) => notify(t, b, 'meetings'),
  // Demanda nova depois de uma reunião: avisa no seu WhatsApp.
  onNewTasks: (m, tasks) => {
    if (!whatsapp.configured || getConfig().integrations.whatsapp?.notifyMeetingTasks === false) return;
    whatsapp.send(formatTasksMessage(m.title, tasks)).catch((err) => notify('WhatsApp', `Não consegui avisar das demandas: ${err.message}`));
  },
});
const calendar = new Calendar({ getConfig });
const github = new GitHub({ getConfig });
const slack = new Slack({ getConfig });
const whisper = new Whisper({ dir: path.join(dataDir, 'whisper'), getConfig });
const insights = new Insights({ meetings, store: insightsStore, usage, getConfig, emit: send, notify, calendar });
let trayRebuild = () => {};
const automations = new Automations({
  store: autoStore, orchestrator, insights, meetings, slack, usage, getConfig, notify,
  emit: (ch, p) => {
    send(ch, p);
    if (ch === 'automations:update') trayRebuild(); // atalhos no menu da bandeja
  },
});

// ---------- Janelas ----------
function secureWindow(w) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:|^mailto:/.test(url)) shell.openExternal(url);
    }
  });
}

const webPreferences = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
});

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 780,
    minHeight: 540,
    backgroundColor: '#0f1117',
    title: 'Ohara',
    icon: ICON,
    autoHideMenuBar: true,
    show: false,
    // A escuta de voz roda nesta janela mesmo escondida.
    webPreferences: { ...webPreferences(), backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Ao iniciar com o Windows (--hidden), fica só na bandeja.
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden') && !process.env.CENTRAL_SNAPSHOT_QUICK) win.show();
  });
  // Desenvolvimento: CENTRAL_SNAPSHOT=arquivo.png (+ CENTRAL_VIEW) salva um print e fecha.
  if (process.env.CENTRAL_SNAPSHOT) {
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        if (process.env.CENTRAL_VIEW) {
          send('app:view', process.env.CENTRAL_VIEW);
          await new Promise((r) => setTimeout(r, Number(process.env.CENTRAL_WAIT || 1200)));
        }
        fs.writeFileSync(process.env.CENTRAL_SNAPSHOT, (await win.webContents.capturePage()).toPNG());
        quitting = true;
        app.quit();
      }, 1500),
    );
  }
  // Fechar a janela só a esconde: a Ohara continua nos ícones ocultos da bandeja.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
      notifyHiddenOnce();
    }
  });
  secureWindow(win);
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

// Janela rápida (estilo Spotlight): barra flutuante por cima de tudo.
function createQuick() {
  quick = new BrowserWindow({
    width: 720,
    height: 132,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: webPreferences(),
  });
  quick.loadFile(path.join(__dirname, 'renderer', 'quick.html'));
  quick.on('blur', () => {
    if (!quick.webContents.isDevToolsOpened() && !quick.__pinned) quick.hide();
  });
  quick.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      quick.hide();
    }
  });
  secureWindow(quick);
  if (process.env.CENTRAL_SNAPSHOT_QUICK) {
    quick.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        showQuick({ mode: process.env.CENTRAL_QUICK_MODE || 'ask', text: 'Erro: Cannot read properties of undefined (reading \'files\')' });
        await new Promise((r) => setTimeout(r, 900));
        fs.writeFileSync(process.env.CENTRAL_SNAPSHOT_QUICK, (await quick.webContents.capturePage()).toPNG());
        quitting = true;
        app.quit();
      }, 1200),
    );
  }
}

function showQuick(payload = { mode: 'ask' }) {
  if (!quick) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width } = display.workArea;
  const [w] = quick.getSize();
  quick.setPosition(Math.round(x + (width - w) / 2), Math.round(y + 140));
  quick.show();
  quick.focus();
  quick.webContents.send('quick:open', payload);
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    win.show();
    win.focus();
    send('app:focus-input');
  }
}

function showView(view) {
  if (!win) return;
  win.show();
  win.focus();
  win.webContents.send('app:view', view);
}

// Avisa uma única vez que fechar a janela não encerra o app.
function notifyHiddenOnce() {
  const marker = path.join(dataDir, 'aviso-bandeja-mostrado');
  if (fs.existsSync(marker) || !tray) return;
  try { fs.writeFileSync(marker, new Date().toISOString()); } catch {}
  tray.displayBalloon({
    title: 'A Ohara continua aberta',
    content: 'Ela fica nos ícones ocultos da barra de tarefas. Para encerrar, clique com o botão direito no ícone e escolha Sair.',
    iconType: 'info',
  });
}

// Na primeira execução do app instalado, liga "Iniciar com o Windows" (escondida na bandeja).
// Depois disso, vale o que a pessoa escolher no menu da bandeja.
function enableAutoStartOnce() {
  if (!app.isPackaged) return;
  const marker = path.join(dataDir, 'inicio-automatico-configurado');
  if (fs.existsSync(marker)) return;
  app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
  try { fs.writeFileSync(marker, new Date().toISOString()); } catch {}
}

// Primeira execução de cada versão instalada: remove a antiga "Central IA" (se sobrou) e manda
// para a Lixeira os instaladores/portáteis de versões anteriores (Downloads, Área de Trabalho, pasta de saída).
async function cleanupOldVersionsOnce() {
  if (!app.isPackaged) return;
  const marker = path.join(dataDir, `limpeza-${app.getVersion()}`);
  if (fs.existsSync(marker)) return;
  try { fs.writeFileSync(marker, new Date().toISOString()); } catch {}
  const uninstalled = uninstallLegacyApp({ programsDir: path.join(process.env.LOCALAPPDATA || '', 'Programs'), currentExe: process.execPath });
  const removed = await trashOldInstallers({
    version: app.getVersion(),
    dirs: [app.getPath('downloads'), app.getPath('desktop'), config.outputDir],
    keep: [process.execPath, process.env.PORTABLE_EXECUTABLE_FILE],
    trash: (p) => shell.trashItem(p),
  });
  if (removed.length || uninstalled) {
    const parts = [];
    if (uninstalled) parts.push('a antiga Central IA foi desinstalada');
    if (removed.length) parts.push(`${removed.length} instalador${removed.length > 1 ? 'es antigos foram' : ' antigo foi'} para a Lixeira`);
    notify(`Ohara ${app.getVersion()}`, `Versões antigas removidas: ${parts.join(' e ')}.`);
  }
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
  tray.setToolTip('Ohara');
  const rebuild = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Abrir', click: () => toggleWindow() },
        { label: 'Janela rápida', click: () => showQuick({ mode: 'ask' }) },
        { label: 'Hoje', click: () => showView('today') },
        { label: 'Painel de demandas', click: () => showView('meetings') },
        { type: 'separator' },
        ...automations.snapshot().routines.slice(0, 6).map((r) => ({ label: `${r.icon} ${r.name}`, click: () => { showView('chat'); automations.runRoutine(r.id); } })),
        { type: 'separator' },
        {
          label: 'Iniciar com o Windows',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          // Só funciona no app empacotado (no "npm start" registraria o electron.exe puro).
          enabled: app.isPackaged,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
        },
        { label: 'Abrir pasta de dados', click: () => shell.openPath(dataDir) },
        { type: 'separator' },
        { label: 'Sair', click: () => { quitting = true; app.quit(); } },
      ]),
    );
  rebuild();
  tray.on('click', () => toggleWindow());
  return rebuild;
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  const h = config.hotkeys;
  const bind = (name, accel, fn) => {
    if (!accel) return;
    try {
      hotkeyStatus[name] = globalShortcut.register(accel, fn) ? 'ok' : 'em uso por outro programa';
    } catch (err) {
      hotkeyStatus[name] = `inválido: ${err.message}`;
    }
  };
  bind('toggle', h.toggle, toggleWindow);
  bind('quick', h.quick, () => (quick?.isVisible() ? quick.hide() : showQuick({ mode: 'ask' })));
  bind('clipboard', h.clipboard, () => showQuick({ mode: 'clipboard', text: clipboard.readText() }));
  bind('voice', h.voice, () => {
    if (quick?.isVisible()) quick.webContents.send('quick:voice-toggle');
    else showQuick({ mode: 'voice' });
  });
}

async function captureScreen() {
  const wasVisible = win?.isVisible();
  if (wasVisible) win.hide();
  await new Promise((r) => setTimeout(r, 350)); // espera a janela sumir
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { width, height } = display.size;
    const sf = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * sf), height: Math.round(height * sf) },
    });
    const source = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    if (!source) throw new Error('Nenhuma tela disponível para captura');
    fs.mkdirSync(capturesDir, { recursive: true });
    const file = path.join(capturesDir, `tela-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
    fs.writeFileSync(file, source.thumbnail.toPNG());
    return { path: file, preview: source.thumbnail.resize({ width: 320 }).toDataURL() };
  } finally {
    if (wasVisible) {
      win.show();
      win.focus();
    }
  }
}

// ---------- IPC ----------
const safe = (fn) => async (...args) => {
  try {
    return { ok: true, data: await fn(...args) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
};

function registerIpc() {
  const handle = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => fn(...a));
  const handleSafe = (ch, fn) => ipcMain.handle(ch, (_e, ...a) => safe(fn)(...a));

  // Configuração
  handle('config:get', () => publicConfig());
  handle('app:version', () => app.getVersion());
  handle('config:set', (partial) => {
    // Ignora o marcador "••••••" que a interface mostra no lugar do segredo.
    for (const p of SECRETS) if (getIn(partial, p) === '••••••') setIn(partial, p, undefined);
    const user = encryptSecrets(deepMerge(readUserConfig(), partial));
    fs.writeFileSync(configFile, JSON.stringify(user, null, 2));
    config = deepMerge(DEFAULT_CONFIG, decryptSecrets(structuredClone(user)));
    if (partial.hotkeys) registerHotkeys();
    if (partial.meetings) meetings.start();
    if (partial.integrations?.calendarIcsUrl !== undefined) calendar.refresh(true);
    if (partial.integrations?.slack) slack.users = null;
    return publicConfig();
  });
  handle('hotkeys:status', () => hotkeyStatus);

  // Conversas
  handle('chats:list', () => orchestrator.list());
  handle('chat:get', (id) => orchestrator.get(id));
  handle('chat:create', (cwd, title) => orchestrator.create(cwd, title));
  handle('chat:delete', (id) => orchestrator.remove(id));
  handle('chat:setCwd', (id, cwd) => orchestrator.setCwd(id, cwd));
  handle('chat:send', async (id, payload) => {
    try {
      return await orchestrator.send(id, payload);
    } catch (err) {
      return { error: err.message };
    }
  });
  handle('chat:cancel', (id, runId) => orchestrator.cancel(id, runId));
  handle('chat:running', (id) => orchestrator.isRunning(id));
  handle('route:preview', (text, opts) => orchestrator.preview(text, opts));

  // Aprendizado do roteador
  handle('learning:get', () => {
    const learned = orchestrator.learned();
    return {
      enabled: config.learning.enabled,
      overrides: (prefsStore.data.overrides || []).slice(-50).reverse(),
      learned: Object.entries(learned).map(([cat, choice]) => ({ category: cat, label: CATEGORIES[cat]?.label || cat, choice, choiceLabel: learnedLabel(choice) })),
    };
  });
  handle('learning:reset', () => orchestrator.forgetLearning());

  // Uso
  handle('usage:get', () => {
    usage.refreshCodexLimits();
    return usage.summary();
  });

  // Sistema
  handle('repos:list', () => system.listRepos(config.workspaceRoot));
  handle('dialog:folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('dialog:image', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });
  handle('screen:capture', () => captureScreen());
  handle('voice:dictate', () => system.startVoiceTyping());
  handle('tts:speak', (text) => system.speak(text, config.voice.ttsVoice));
  handle('tts:stop', () => system.stopSpeaking());
  handle('shell:openPath', (p) => shell.openPath(p));
  handle('shell:openExternal', (url) => (/^(https?|mailto):/.test(url) ? shell.openExternal(url) : null));
  handle('clipboard:write', (text) => clipboard.writeText(String(text || '')));
  handle('clipboard:read', () => clipboard.readText());
  handle('app:showView', (view) => showView(view));

  // Reuniões e demandas
  handle('meetings:get', () => meetings.snapshot());
  handle('meetings:scan', () => meetings.scan());
  handle('meetings:reprocess', (key) => meetings.reprocess(key));
  handle('task:update', (id, patch) => meetings.updateTask(id, patch));
  handle('task:add', (task) => meetings.addTask(task));
  handle('task:delete', (id) => meetings.deleteTask(id));
  handle('waiting:update', (id, patch) => meetings.updateWaiting(id, patch));
  handle('waiting:delete', (id) => meetings.deleteWaiting(id));
  handle('task:suggestRepo', (id) => insights.suggestRepo(id, system.listRepos(config.workspaceRoot)));

  // Insights
  handleSafe('insights:search', (q) => insights.search(q));
  handle('insights:people', () => insights.people());
  handle('insights:today', () => insights.todayBoard());
  handle('insights:briefings', () => insights.briefings());
  handleSafe('insights:briefing', (kind) => insights.briefing(kind));
  handleSafe('insights:nudge', (id) => insights.nudgeMessage(id));
  handle('insights:markdown', (key) => insights.markdown(key));
  handleSafe('insights:saveMarkdown', (key) => insights.saveMarkdown(key));
  handle('insights:mailto', (key) => shell.openExternal(insights.mailto(key)));

  // Automações
  handle('auto:get', () => automations.snapshot());
  handle('auto:saveRoutine', (r) => automations.saveRoutine(r));
  handle('auto:deleteRoutine', (id) => automations.deleteRoutine(id));
  handleSafe('auto:runRoutine', (id) => automations.runRoutine(id));
  handle('auto:saveSchedule', (s) => automations.saveSchedule(s));
  handle('auto:deleteSchedule', (id) => automations.deleteSchedule(id));
  handleSafe('auto:runSchedule', (id) => automations.runSchedule(id));

  // Integrações
  handleSafe('github:prs', (force) => github.prs(force));
  handle('calendar:status', async () => {
    await calendar.refresh();
    return { ...calendar.status(), today: calendar.eventsToday().map((e) => ({ summary: e.summary, start: e.start, meetCode: e.meetCode })) };
  });
  handle('slack:status', () => slack.status());
  handleSafe('slack:send', (person, text) => slack.sendDM(person, text));
  handleSafe('slack:import', () => automations.importSlack());
  handle('whatsapp:status', () => whatsapp.status());
  handleSafe('whatsapp:send', (text) => whatsapp.send(text));
  handle('whatsapp:webStatus', () => whatsappWeb.status());
  handle('whatsapp:webConnect', () => whatsappWeb.connect());
  handleSafe('whatsapp:confirm', (chatId, messageId, index) => orchestrator.confirmWhatsApp(chatId, messageId, index));
  handleSafe('whatsapp:cancel', (chatId, messageId, index) => orchestrator.cancelWhatsApp(chatId, messageId, index));
  handle('whisper:status', () => whisper.status());
  handleSafe('whisper:install', () => whisper.install((p) => send('whisper:progress', p)));
  handleSafe('whisper:transcribe', async (wavBytes) => {
    const file = path.join(os.tmpdir(), `ohara-voz-${Date.now()}.wav`);
    fs.writeFileSync(file, Buffer.from(wavBytes));
    try {
      return await whisper.transcribe(file);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  // Janela rápida
  handle('quick:hide', () => quick?.hide());
  handle('quick:ask', (text) => showQuick({ mode: 'ask', text, autoSend: true }));
  handle('app:loginItem', (on) => {
    if (on !== undefined && app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
    return { enabled: app.getLoginItemSettings().openAtLogin, available: app.isPackaged };
  });
  handle('quick:resize', (height) => {
    if (!quick) return;
    const [w] = quick.getSize();
    quick.setSize(w, Math.max(120, Math.min(640, Math.round(height))));
  });
  handle('quick:pin', (on) => { if (quick) quick.__pinned = !!on; });
  handle('quick:openInMain', (chatId) => {
    quick?.hide();
    showView('chat');
    win.webContents.send('chat:open', chatId);
  });
}

// ---------- Ciclo de vida ----------
app.on('second-instance', () => toggleWindow());

app.whenReady().then(() => {
  app.setAppUserModelId('com.gabsx.central-ia');
  // Microfone só para as janelas do próprio app (gravação de voz para o Whisper).
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' && wc.getURL().startsWith('file:')));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' && !!wc?.getURL().startsWith('file:'));

  enableAutoStartOnce();
  setTimeout(() => cleanupOldVersionsOnce().catch(() => {}), 5000);
  registerIpc();
  createWindow();
  createQuick();
  trayRebuild = createTray();
  registerHotkeys();

  meetings.start();
  automations.start();
  // Classifica "aguardando outros" antigos (uma chamada rápida, só quando houver itens sem marca).
  setTimeout(() => insights.classifyWaiting().catch(() => {}), 20_000);
  calendar.refresh().catch(() => {});
  // Pauta antes das calls e amostras de cota para o gráfico.
  setInterval(() => {
    calendar.refresh().catch(() => {});
    insights.checkPrep();
  }, 60_000);
  setInterval(() => usage.sampleLimits(), 5 * 60_000);
  usage.sampleLimits();
});

app.on('before-quit', () => {
  quitting = true;
  whatsappWeb.destroy();
  meetings.stop();
  automations.stop();
  for (const s of stores) s.flush();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());
