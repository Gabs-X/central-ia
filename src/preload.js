const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
const inv = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('central', {
  // Configuração
  getConfig: inv('config:get'),
  setConfig: inv('config:set'),
  hotkeyStatus: inv('hotkeys:status'),
  appVersion: inv('app:version'),

  // Conversas
  listChats: inv('chats:list'),
  getChat: inv('chat:get'),
  createChat: inv('chat:create'),
  deleteChat: inv('chat:delete'),
  setCwd: inv('chat:setCwd'),
  send: inv('chat:send'),
  cancel: inv('chat:cancel'),
  isRunning: inv('chat:running'),
  previewRoute: inv('route:preview'),
  getLearning: inv('learning:get'),
  resetLearning: inv('learning:reset'),

  // Sistema
  getUsage: inv('usage:get'),
  listRepos: inv('repos:list'),
  pickFolder: inv('dialog:folder'),
  pickImages: inv('dialog:image'),
  captureScreen: inv('screen:capture'),
  dictate: inv('voice:dictate'),
  speak: inv('tts:speak'),
  stopSpeaking: inv('tts:stop'),
  openPath: inv('shell:openPath'),
  openExternal: inv('shell:openExternal'),
  copy: inv('clipboard:write'),
  readClipboard: inv('clipboard:read'),
  showView: inv('app:showView'),

  // Reuniões e demandas
  getMeetings: inv('meetings:get'),
  scanMeetings: inv('meetings:scan'),
  reprocessMeeting: inv('meetings:reprocess'),
  updateTask: inv('task:update'),
  addTask: inv('task:add'),
  deleteTask: inv('task:delete'),
  updateWaiting: inv('waiting:update'),
  deleteWaiting: inv('waiting:delete'),
  suggestRepo: inv('task:suggestRepo'),

  // Insights
  search: inv('insights:search'),
  people: inv('insights:people'),
  today: inv('insights:today'),
  briefings: inv('insights:briefings'),
  makeBriefing: inv('insights:briefing'),
  nudge: inv('insights:nudge'),
  meetingMarkdown: inv('insights:markdown'),
  saveMeetingMarkdown: inv('insights:saveMarkdown'),
  mailMeeting: inv('insights:mailto'),

  // Automações
  getAutomations: inv('auto:get'),
  saveRoutine: inv('auto:saveRoutine'),
  deleteRoutine: inv('auto:deleteRoutine'),
  runRoutine: inv('auto:runRoutine'),
  saveSchedule: inv('auto:saveSchedule'),
  deleteSchedule: inv('auto:deleteSchedule'),
  runSchedule: inv('auto:runSchedule'),

  // Integrações
  githubPrs: inv('github:prs'),
  calendarStatus: inv('calendar:status'),
  slackStatus: inv('slack:status'),
  slackSend: inv('slack:send'),
  slackImport: inv('slack:import'),
  whatsappStatus: inv('whatsapp:status'),
  whatsappSend: inv('whatsapp:send'),
  whatsappWebStatus: inv('whatsapp:webStatus'),
  whatsappWebConnect: inv('whatsapp:webConnect'),
  whatsappConfirm: inv('whatsapp:confirm'),
  whatsappCancel: inv('whatsapp:cancel'),
  whisperStatus: inv('whisper:status'),
  whisperInstall: inv('whisper:install'),
  transcribe: inv('whisper:transcribe'),

  // Janela rápida
  quickHide: inv('quick:hide'),
  quickAsk: inv('quick:ask'),
  loginItem: inv('app:loginItem'),
  quickResize: inv('quick:resize'),
  quickPin: inv('quick:pin'),
  quickOpenInMain: inv('quick:openInMain'),

  // Eventos
  onRoute: on('chat:route'),
  onEvent: on('chat:event'),
  onDone: on('chat:done'),
  onMessage: on('chat:message'),
  onChatOpen: on('chat:open'),
  onChatsChanged: on('chats:changed'),
  onUsage: on('usage:update'),
  onFocusInput: on('app:focus-input'),
  onView: on('app:view'),
  onMeetings: on('meetings:update'),
  onAutomations: on('automations:update'),
  onBriefing: on('briefing:new'),
  onWhisperProgress: on('whisper:progress'),
  onQuickOpen: on('quick:open'),
  onQuickVoiceToggle: on('quick:voice-toggle'),
});
