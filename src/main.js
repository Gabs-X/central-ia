const { app, BrowserWindow, Tray, Menu, Notification, globalShortcut, ipcMain, dialog, desktopCapturer, screen, shell, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { DEFAULT_CONFIG } = require('./core/config');
const { JsonStore, deepMerge } = require('./core/store');
const { UsageTracker } = require('./core/usage');
const { Orchestrator } = require('./core/orchestrator');
const system = require('./core/system');
const { MeetingsService } = require('./core/meetings');

// Desenvolvimento: CENTRAL_DATA_DIR usa outra pasta de dados (e permite rodar ao lado do app instalado).
if (process.env.CENTRAL_DATA_DIR) app.setPath('userData', process.env.CENTRAL_DATA_DIR);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const dataDir = app.getPath('userData');
const configFile = path.join(dataDir, 'config.json');
const capturesDir = path.join(dataDir, 'capturas');

let win = null;
let tray = null;
let quitting = false;

function loadConfig() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({}, null, 2));
  }
  return deepMerge(DEFAULT_CONFIG, user);
}

let config = loadConfig();
const chatsStore = new JsonStore(path.join(dataDir, 'chats.json'), { chats: [] });
const usageStore = new JsonStore(path.join(dataDir, 'usage.json'), { days: {}, limits: { claude: null, codex: null } });
const usage = new UsageTracker(usageStore);

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

const orchestrator = new Orchestrator({ chatsStore, usage, getConfig: () => config, emit: send });

const meetingsStore = new JsonStore(path.join(dataDir, 'meetings.json'), { meetings: {}, tasks: [] });
const meetings = new MeetingsService({
  store: meetingsStore,
  usage,
  getConfig: () => config,
  emit: send,
  notify: (title, body) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.png') });
    n.on('click', () => showView('meetings'));
    n.show();
  },
});

function showView(view) {
  if (!win) return;
  win.show();
  win.focus();
  send('app:view', view);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#0f1117',
    title: 'Central IA',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Ao iniciar com o Windows (--hidden), fica só na bandeja.
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  // Uso em desenvolvimento: CENTRAL_SNAPSHOT=arquivo.png salva um print da janela e fecha.
  if (process.env.CENTRAL_SNAPSHOT) {
    win.webContents.once('did-finish-load', () =>
      setTimeout(async () => {
        if (process.env.CENTRAL_VIEW) {
          send('app:view', process.env.CENTRAL_VIEW);
          await new Promise((r) => setTimeout(r, 800));
        }
        fs.writeFileSync(process.env.CENTRAL_SNAPSHOT, (await win.webContents.capturePage()).toPNG());
        quitting = true;
        app.quit();
      }, 1500),
    );
  }
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  // Links nas respostas abrem no navegador padrão.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
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

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
  tray.setToolTip('Central IA');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir', click: () => toggleWindow() },
      { label: 'Painel de demandas', click: () => showView('meetings') },
      { label: 'Abrir pasta de dados', click: () => shell.openPath(dataDir) },
      { type: 'separator' },
      {
        label: 'Iniciar com o Windows',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        // Só funciona no app empacotado (no "npm start" registraria o electron.exe puro).
        enabled: app.isPackaged,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
      },
      { type: 'separator' },
      { label: 'Sair', click: () => { quitting = true; app.quit(); } },
    ]),
  );
  tray.on('click', () => toggleWindow());
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(config.hotkey, toggleWindow);
  if (!ok) console.warn(`Atalho ${config.hotkey} já está em uso por outro programa.`);
  return ok;
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

function registerIpc() {
  ipcMain.handle('config:get', () => config);
  ipcMain.handle('config:set', (_e, partial) => {
    let user = {};
    try {
      user = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch { /* novo */ }
    user = deepMerge(user, partial);
    fs.writeFileSync(configFile, JSON.stringify(user, null, 2));
    config = deepMerge(DEFAULT_CONFIG, user);
    if (partial.hotkey) registerHotkey();
    return config;
  });

  ipcMain.handle('chats:list', () => orchestrator.list());
  ipcMain.handle('chat:get', (_e, id) => orchestrator.get(id));
  ipcMain.handle('chat:create', (_e, cwd) => orchestrator.create(cwd));
  ipcMain.handle('chat:delete', (_e, id) => orchestrator.remove(id));
  ipcMain.handle('chat:setCwd', (_e, id, cwd) => orchestrator.setCwd(id, cwd));
  ipcMain.handle('chat:send', async (_e, id, payload) => {
    try {
      return await orchestrator.send(id, payload);
    } catch (err) {
      return { error: err.message };
    }
  });
  ipcMain.handle('chat:cancel', (_e, id) => orchestrator.cancel(id));
  ipcMain.handle('route:preview', (_e, text, opts) => orchestrator.preview(text, opts));

  ipcMain.handle('usage:get', () => {
    usage.refreshCodexLimits();
    return usage.summary();
  });

  ipcMain.handle('repos:list', () => system.listRepos(config.workspaceRoot));
  ipcMain.handle('dialog:folder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:image', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('screen:capture', () => captureScreen());
  ipcMain.handle('voice:dictate', () => system.startVoiceTyping());
  ipcMain.handle('tts:speak', (_e, text) => system.speak(text, config.voice.ttsVoice));
  ipcMain.handle('tts:stop', () => system.stopSpeaking());
  ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));

  ipcMain.handle('meetings:get', () => meetings.snapshot());
  ipcMain.handle('meetings:scan', () => meetings.scan());
  ipcMain.handle('meetings:reprocess', (_e, key) => meetings.reprocess(key));
  ipcMain.handle('task:update', (_e, id, patch) => meetings.updateTask(id, patch));
  ipcMain.handle('task:add', (_e, task) => meetings.addTask(task));
  ipcMain.handle('task:delete', (_e, id) => meetings.deleteTask(id));
}

app.on('second-instance', () => toggleWindow());

app.whenReady().then(() => {
  app.setAppUserModelId('com.gabsx.central-ia');
  registerIpc();
  createWindow();
  createTray();
  registerHotkey();
  meetings.start();
});

app.on('before-quit', () => {
  quitting = true;
  meetings.stop();
  chatsStore.flush();
  usageStore.flush();
  meetingsStore.flush();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());
