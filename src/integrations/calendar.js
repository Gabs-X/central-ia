// Google Agenda (ou qualquer agenda) pelo endereço secreto iCal: sem OAuth.
// Expande eventos recorrentes simples (RRULE DAILY/WEEKLY) dos próximos dias.

function unfold(text) {
  return text.replace(/\r?\n[ \t]/g, '');
}

function parseDate(value, params = '') {
  if (!value) return null;
  if (/VALUE=DATE(?!-)/.test(params) || /^\d{8}$/.test(value)) {
    return { date: new Date(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))), allDay: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  // TZID: tratamos como horário local (o usuário está no mesmo fuso da agenda).
  const date = z ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)) : new Date(+y, +mo - 1, +d, +h, +mi, +s);
  return { date, allDay: false };
}

function parseICS(text) {
  const lines = unfold(text).split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = { exdates: [], attendees: [] };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur?.start) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const [name, ...paramParts] = line.slice(0, idx).split(';');
    const params = paramParts.join(';');
    const value = line.slice(idx + 1);
    switch (name) {
      case 'UID': cur.uid = value; break;
      case 'SUMMARY': cur.summary = value.replace(/\\,/g, ',').replace(/\\n/g, ' ').replace(/\\;/g, ';'); break;
      case 'DESCRIPTION': cur.description = value.replace(/\\n/g, '\n').replace(/\\,/g, ','); break;
      case 'LOCATION': cur.location = value.replace(/\\,/g, ','); break;
      case 'DTSTART': { const d = parseDate(value, params); if (d) { cur.start = d.date; cur.allDay = d.allDay; } break; }
      case 'DTEND': { const d = parseDate(value, params); if (d) cur.end = d.date; break; }
      case 'RRULE': cur.rrule = Object.fromEntries(value.split(';').map((p) => p.split('='))); break;
      case 'EXDATE': for (const v of value.split(',')) { const d = parseDate(v, params); if (d) cur.exdates.push(d.date.getTime()); } break;
      case 'RECURRENCE-ID': { const d = parseDate(value, params); if (d) cur.recurrenceId = d.date.getTime(); break; }
      case 'STATUS': cur.status = value; break;
      case 'ATTENDEE': { const cn = params.match(/CN=("?)([^;"]+)\1/); if (cn) cur.attendees.push(cn[2]); break; }
      case 'X-GOOGLE-CONFERENCE': cur.conference = value; break;
      default: break;
    }
  }
  return events;
}

const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Gera as ocorrências entre from e to.
function expand(events, from, to) {
  const overrides = new Map(); // uid|recurrenceId -> evento substituto
  for (const e of events) if (e.recurrenceId) overrides.set(`${e.uid}|${e.recurrenceId}`, e);
  const out = [];
  for (const e of events) {
    if (e.recurrenceId || e.status === 'CANCELLED') {
      if (e.recurrenceId && e.status !== 'CANCELLED' && e.start >= from && e.start < to) out.push(e);
      continue;
    }
    const dur = (e.end || e.start) - e.start;
    if (!e.rrule) {
      if (e.start >= from && e.start < to) out.push(e);
      continue;
    }
    const r = e.rrule;
    const interval = Number(r.INTERVAL || 1);
    const until = r.UNTIL ? parseDate(r.UNTIL)?.date : null;
    const count = r.COUNT ? Number(r.COUNT) : Infinity;
    const byDay = r.BYDAY ? r.BYDAY.split(',').map((d) => DAYS[d.slice(-2)]) : null;
    let n = 0;
    const startDay = new Date(e.start);
    for (let i = 0; i < 400 && n < count; i++) {
      const day = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() + i, startDay.getHours(), startDay.getMinutes(), startDay.getSeconds());
      if (until && day > until) break;
      if (day > to) break;
      let match = false;
      if (r.FREQ === 'DAILY') match = i % interval === 0;
      else if (r.FREQ === 'WEEKLY') {
        const week = Math.floor(i / 7);
        match = week % interval === 0 && (byDay ? byDay.includes(day.getDay()) : day.getDay() === startDay.getDay());
      } else if (r.FREQ === 'MONTHLY') match = day.getDate() === startDay.getDate();
      if (!match) continue;
      n++;
      if (day < from || e.exdates.includes(day.getTime())) continue;
      const ov = overrides.get(`${e.uid}|${day.getTime()}`);
      if (ov) continue; // a ocorrência alterada já entra pelo evento substituto
      out.push({ ...e, start: day, end: new Date(day.getTime() + dur) });
    }
  }
  return out
    .map((e) => ({ ...e, meetCode: meetCode(e) }))
    .sort((a, b) => a.start - b.start);
}

// Link do Meet (abc-defg-hij) → código usado pelo bot de transcrição ("meet" + código).
function meetCode(e) {
  const hay = `${e.description || ''} ${e.location || ''} ${e.conference || ''}`;
  const m = hay.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  return m ? `meet${m[1].toLowerCase()}` : null;
}

class Calendar {
  constructor({ getConfig }) {
    this.getConfig = getConfig;
    this.events = [];
    this.fetchedAt = 0;
    this.error = null;
  }

  get url() {
    return this.getConfig().integrations.calendarIcsUrl;
  }

  async refresh(force = false) {
    if (!this.url) {
      this.events = [];
      return;
    }
    if (!force && Date.now() - this.fetchedAt < 15 * 60_000) return;
    try {
      const res = await fetch(this.url, { headers: { 'User-Agent': 'central-ia' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      const to = new Date(from.getTime() + 8 * 864e5);
      this.events = expand(parseICS(text), from, to).filter((e) => !e.allDay);
      this.fetchedAt = Date.now();
      this.error = null;
    } catch (err) {
      this.error = err.message;
    }
  }

  eventsToday() {
    const d = new Date();
    return this.events.filter((e) => e.start.toDateString() === d.toDateString());
  }

  status() {
    return { configured: !!this.url, count: this.events.length, fetchedAt: this.fetchedAt, error: this.error };
  }
}

module.exports = { Calendar, parseICS, expand, meetCode };
