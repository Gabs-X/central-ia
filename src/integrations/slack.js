// Slack com token de usuário (xoxp-...). Escopos: search:read, users:read, im:write, chat:write.
const API = 'https://slack.com/api/';

class Slack {
  constructor({ getConfig }) {
    this.getConfig = getConfig;
    this.me = null;
    this.users = null;
  }

  get token() {
    return this.getConfig().integrations.slack.token;
  }

  async call(method, params = {}, post = false) {
    if (!this.token) throw new Error('Slack não configurado: falta o token em Configurações.');
    const headers = { Authorization: `Bearer ${this.token}` };
    let res;
    if (post) {
      res = await fetch(API + method, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(params) });
    } else {
      const qs = new URLSearchParams(params).toString();
      res = await fetch(`${API}${method}?${qs}`, { headers });
    }
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack ${method}: ${data.error}`);
    return data;
  }

  async status() {
    if (!this.token) return { configured: false };
    try {
      const r = await this.call('auth.test');
      this.me = { id: r.user_id, name: r.user, team: r.team };
      return { configured: true, ok: true, ...this.me };
    } catch (err) {
      return { configured: true, ok: false, error: err.message };
    }
  }

  async #loadUsers() {
    if (this.users) return this.users;
    const list = [];
    let cursor = '';
    do {
      const r = await this.call('users.list', { limit: 200, ...(cursor ? { cursor } : {}) });
      list.push(...r.members.filter((u) => !u.deleted && !u.is_bot));
      cursor = r.response_metadata?.next_cursor || '';
    } while (cursor);
    this.users = list;
    return list;
  }

  async findUser(name) {
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
    const n = norm(name);
    const first = n.split(' ')[0];
    const users = await this.#loadUsers();
    const score = (u) => {
      const names = [u.real_name, u.profile?.real_name, u.profile?.display_name, u.name].map(norm);
      if (names.includes(n)) return 3;
      if (names.some((x) => x && (x.startsWith(n) || n.startsWith(x)))) return 2;
      if (names.some((x) => x.split(' ')[0] === first)) return 1;
      return 0;
    };
    const ranked = users.map((u) => ({ u, s: score(u) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    if (!ranked.length) return null;
    if (ranked.length > 1 && ranked[0].s === 1 && ranked[1].s === 1) return null; // ambíguo só pelo primeiro nome
    const u = ranked[0].u;
    return { id: u.id, name: u.real_name || u.name };
  }

  async sendDM(personName, text) {
    const user = await this.findUser(personName);
    if (!user) throw new Error(`Não achei "${personName}" no Slack (ou o nome é ambíguo).`);
    const im = await this.call('conversations.open', { users: user.id }, true);
    await this.call('chat.postMessage', { channel: im.channel.id, text }, true);
    return user;
  }

  // Mensagens que te mencionam desde uma data (para virar demandas).
  async mentionsSince(isoDate) {
    if (!this.me) await this.status();
    if (!this.me) throw new Error('Token do Slack inválido.');
    const r = await this.call('search.messages', { query: `<@${this.me.id}> after:${isoDate}`, count: 50, sort: 'timestamp' });
    return (r.messages?.matches || []).map((m) => ({
      ts: m.ts,
      user: m.username || m.user,
      channel: m.channel?.name || m.channel?.id,
      text: m.text,
      permalink: m.permalink,
    }));
  }
}

module.exports = { Slack };
