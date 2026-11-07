const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('central', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),

  listChats: () => ipcRenderer.invoke('chats:list'),
  getChat: (id) => ipcRenderer.invoke('chat:get', id),
  createChat: (cwd) => ipcRenderer.invoke('chat:create', cwd),
  deleteChat: (id) => ipcRenderer.invoke('chat:delete', id),
  setCwd: (id, cwd) => ipcRenderer.invoke('chat:setCwd', id, cwd),
  send: (id, payload) => ipcRenderer.invoke('chat:send', id, payload),
  cancel: (id) => ipcRenderer.invoke('chat:cancel', id),
  previewRoute: (text, opts) => ipcRenderer.invoke('route:preview', text, opts),

  getUsage: () => ipcRenderer.invoke('usage:get'),
  listRepos: () => ipcRenderer.invoke('repos:list'),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  pickImages: () => ipcRenderer.invoke('dialog:image'),
  captureScreen: () => ipcRenderer.invoke('screen:capture'),
  dictate: () => ipcRenderer.invoke('voice:dictate'),
  speak: (text) => ipcRenderer.invoke('tts:speak', text),
  stopSpeaking: () => ipcRenderer.invoke('tts:stop'),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),

  onRoute: on('chat:route'),
  onEvent: on('chat:event'),
  onDone: on('chat:done'),
  onUsage: on('usage:update'),
  onFocusInput: on('app:focus-input'),
  onView: on('app:view'),

  getMeetings: () => ipcRenderer.invoke('meetings:get'),
  scanMeetings: () => ipcRenderer.invoke('meetings:scan'),
  reprocessMeeting: (key) => ipcRenderer.invoke('meetings:reprocess', key),
  updateTask: (id, patch) => ipcRenderer.invoke('task:update', id, patch),
  addTask: (task) => ipcRenderer.invoke('task:add', task),
  deleteTask: (id) => ipcRenderer.invoke('task:delete', id),
  onMeetings: on('meetings:update'),
});
