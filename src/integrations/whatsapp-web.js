// Envio para contatos pelo WhatsApp Web do próprio Gabriel, numa janela do Electron com sessão persistente.
// Conecta uma vez pelo QR Code. Não é API oficial: o WhatsApp pode mudar a página (e, em tese, restringir a conta).
// Só envia depois de confirmação explícita na interface (ver Orchestrator.confirmWhatsApp).
const { BrowserWindow, session } = require('electron');
const { pickContact } = require('./whatsapp');

const URL_WA = 'https://web.whatsapp.com/';
const PARTITION = 'persist:whatsapp';
// O WhatsApp Web recusa navegadores "desconhecidos"; usa o user agent do Chrome.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

class WhatsAppWeb {
  constructor({ icon } = {}) {
    this.icon = icon;
    this.win = null;
    this.queue = Promise.resolve(); // um envio por vez
  }

  #window() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const ses = session.fromPartition(PARTITION);
    ses.setUserAgent(UA);
    this.win = new BrowserWindow({
      width: 1000,
      height: 760,
      show: false,
      title: 'Ohara · WhatsApp',
      icon: this.icon,
      autoHideMenuBar: true,
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    this.win.webContents.setUserAgent(UA);
    // Links clicados dentro do WhatsApp não abrem janelas novas do app.
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.on('close', (e) => {
      if (!this.quitting) {
        e.preventDefault();
        this.win.hide();
      }
    });
    this.win.loadURL(URL_WA, { userAgent: UA });
    return this.win;
  }

  #js(code) {
    return this.#window().webContents.executeJavaScript(code, true);
  }

  async #waitFor(code, timeoutMs, label) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        if (await this.#js(code)) return true;
      } catch { /* página ainda carregando */ }
      await sleep(400);
    }
    throw new Error(label);
  }

  /** Abre a janela para escanear o QR Code (ou só para ver o WhatsApp). */
  connect() {
    const w = this.#window();
    w.show();
    w.focus();
  }

  async status() {
    if (!this.win || this.win.isDestroyed()) {
      // Abre escondida para descobrir se a sessão salva ainda vale.
      this.#window();
    }
    try {
      await this.#waitFor('!!document.querySelector("#pane-side") || !!document.querySelector("canvas")', 20000, 'timeout');
      const logged = await this.#js('!!document.querySelector("#pane-side")');
      return { connected: logged };
    } catch {
      return { connected: false, loading: true };
    }
  }

  #ready() {
    return this.#waitFor('!!document.querySelector("#pane-side")', 45000, 'WhatsApp Web não conectado: abra Ajustes → WhatsApp → Conectar e escaneie o QR Code.');
  }

  async #typeInto(selector, text) {
    const wc = this.#window().webContents;
    const found = await this.#js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); document.execCommand('selectAll'); document.execCommand('delete'); return true; })()`);
    if (!found) throw new Error('A página do WhatsApp mudou: campo não encontrado.');
    // Quebras de linha viram Shift+Enter para não enviar no meio.
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] });
      }
      if (lines[i]) await wc.insertText(lines[i]);
    }
  }

  #pressEnter() {
    const wc = this.#window().webContents;
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  }

  // Pesquisa na lista de conversas/contatos e devolve os nomes encontrados.
  async #search(query) {
    const box = '#side [contenteditable="true"]';
    await this.#typeInto(box, query);
    await sleep(1500);
    // Só o título de cada resultado (o nome da conversa), não a prévia da última mensagem.
    return this.#js(`[...document.querySelectorAll('#pane-side [role="listitem"], #pane-side [role="row"]')]
      .map((item) => item.querySelector('span[title]')?.getAttribute('title'))
      .filter(Boolean)
      .slice(0, 15)`);
  }

  async #openChatByName(query) {
    const titles = await this.#search(query);
    const pick = pickContact(query, titles);
    if (pick.error) throw new Error(pick.error);
    const clicked = await this.#js(`(() => {
      const span = [...document.querySelectorAll('#pane-side span[title]')].find((s) => s.getAttribute('title') === ${JSON.stringify(pick.name)});
      const item = span && (span.closest('[role="listitem"]') || span.closest('[role="row"]') || span.closest('[tabindex]'));
      if (!item) return false;
      for (const type of ['mousedown', 'mouseup', 'click']) item.dispatchEvent(new MouseEvent(type, { bubbles: true }));
      return true;
    })()`);
    if (!clicked) throw new Error(`Não consegui abrir a conversa com ${pick.name}.`);
    return pick.name;
  }

  async #openChatByNumber(phone) {
    const digits = String(phone).replace(/\D/g, '');
    await this.#window().webContents.loadURL(`${URL_WA}send?phone=${digits}`, { userAgent: UA });
    await this.#ready();
    return `+${digits}`;
  }

  async #currentChatName() {
    return this.#js(`(() => { const h = document.querySelector('#main header span[title], #main header span[dir="auto"]'); return h ? (h.getAttribute('title') || h.textContent) : ''; })()`);
  }

  /**
   * Envia `text` para um contato (nome como está no WhatsApp) ou número com DDI.
   * Retorna { to } com o nome da conversa em que a mensagem foi enviada.
   */
  send(to, text) {
    const job = this.queue.then(async () => {
      if (!String(text || '').trim()) throw new Error('Mensagem vazia.');
      this.#window();
      await this.#ready();
      const isNumber = /^\+?[\d\s()-]{10,}$/.test(String(to).trim());
      const name = isNumber ? await this.#openChatByNumber(to) : await this.#openChatByName(to);
      await this.#waitFor('!!document.querySelector(\'#main footer [contenteditable="true"]\')', 15000, `A conversa com ${name} não abriu.`);
      const opened = (await this.#currentChatName()) || name;
      if (!isNumber && norm(opened) !== norm(name)) throw new Error(`Abriu a conversa errada (${opened}); nada foi enviado.`);
      await this.#typeInto('#main footer [contenteditable="true"]', text);
      await sleep(300);
      this.#pressEnter();
      await sleep(1200);
      const pending = await this.#js(`(document.querySelector('#main footer [contenteditable="true"]')?.textContent || '').trim().length`);
      if (pending) throw new Error('A mensagem foi escrita mas não saiu; confira a janela do WhatsApp.');
      return { to: opened };
    });
    this.queue = job.catch(() => {});
    return job;
  }

  destroy() {
    this.quitting = true;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { WhatsAppWeb };
