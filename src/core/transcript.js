// Leitura e limpeza dos transcripts gerados pela extensão de reuniões (pasta Gutenberg).
// Formato:
//   # Reunião 05/11/2026 — meetuir-dvzn-koj
//   107 falas · quem falou: Pedro Libarino, Eu
//   15:22:14 → 15:34:39 · capturado pela extensão ...
//   ---
//   **15:22:14 — Pedro Libarino:** Boa tarde
const fs = require('fs');
const path = require('path');

const LINE_RE = /^\*\*(\d{1,2}:\d{2}:\d{2}) — (.+?):\*\*\s?(.*)$/;
const FILE_RE = /^meet-(\d{4}-\d{2}-\d{2})-(.+?)(?:-(\d+))?\.md$/i;

// Agrupa pelo código da reunião: "-2", "-3" são reconexões da mesma call.
function meetingKeyFromFile(file) {
  const m = path.basename(file).match(FILE_RE);
  if (!m) return null;
  return { key: `${m[1]}_${m[2]}`, date: m[1], code: m[2], part: Number(m[3] || 1) };
}

function toSec(hms) {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

function parseFile(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = text.split(/\r?\n/);
  const header = {};
  const utterances = [];
  let cur = null;

  for (const line of lines) {
    const m = line.match(LINE_RE);
    if (m) {
      cur = { time: m[1], sec: toSec(m[1]), speaker: m[2].trim(), text: m[3].trim() };
      utterances.push(cur);
      continue;
    }
    if (!utterances.length) {
      let h;
      if ((h = line.match(/^#\s*Reuni[aã]o\s+(\S+)\s+—\s+(.+)$/))) {
        header.date = h[1];
        header.code = h[2].trim();
      } else if ((h = line.match(/quem falou:\s*(.+)$/))) {
        header.participants = h[1].split(',').map((s) => s.trim()).filter(Boolean);
      } else if ((h = line.match(/^(\d{1,2}:\d{2}:\d{2})\s*→\s*(\d{1,2}:\d{2}:\d{2})/))) {
        header.start = h[1];
        header.end = h[2];
      }
      continue;
    }
    // Linha de continuação de uma fala.
    if (cur && line.trim() && line.trim() !== '---') cur.text += ` ${line.trim()}`;
  }
  return { header, utterances };
}

const norm = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// O reconhecimento de fala reenvia a mesma frase várias vezes, crescendo.
// Mantém só a versão mais completa de cada trecho.
function dedupe(utterances) {
  const kept = [];
  for (const u of utterances) {
    const nu = norm(u.text);
    if (!nu) continue;
    let merged = false;
    // Compara com as últimas falas da mesma pessoa em até 90 s.
    for (let i = kept.length - 1, seen = 0; i >= 0 && seen < 4; i--) {
      const k = kept[i];
      if (u.sec - k.sec > 90) break;
      if (k.speaker !== u.speaker) continue;
      seen++;
      const nk = k._n;
      if (nk === nu || nk.includes(nu)) {
        merged = true; // a nova é pedaço de uma já guardada
        break;
      }
      if (nu.includes(nk) || (nk.length > 20 && nu.startsWith(nk.slice(0, Math.floor(nk.length * 0.8))))) {
        kept[i] = { ...u, time: k.time, sec: k.sec, _n: nu }; // a nova é a versão completa
        merged = true;
        break;
      }
    }
    if (!merged) kept.push({ ...u, _n: nu });
  }
  return kept.map(({ _n, ...u }) => u);
}

/**
 * Junta as partes de uma reunião e devolve o texto compacto para a IA.
 * @param {string[]} files caminhos das partes
 */
function loadMeeting(files, { selfName = 'Gabriel' } = {}) {
  const parts = files
    .map((f) => ({ f, info: meetingKeyFromFile(f) }))
    .sort((a, b) => (a.info?.part || 1) - (b.info?.part || 1))
    .map(({ f }) => parseFile(f));

  const participants = new Set();
  let all = [];
  let start = null;
  let end = null;
  let date = null;
  for (const p of parts) {
    (p.header.participants || []).forEach((x) => participants.add(x));
    all = all.concat(p.utterances);
    start = start || p.header.start;
    end = p.header.end || end;
    date = date || p.header.date;
  }
  all.sort((a, b) => a.sec - b.sec);
  const clean = dedupe(all);
  clean.forEach((u) => participants.add(u.speaker));

  const label = (s) => (s === 'Eu' ? `${selfName} (eu)` : s);
  const text = clean.map((u) => `${u.time.slice(0, 5)} ${label(u.speaker)}: ${u.text}`).join('\n');
  const durationMin = start && end ? Math.max(0, Math.round((toSec(end) - toSec(start)) / 60)) : null;

  return {
    date,
    start,
    end,
    durationMin,
    participants: [...participants].map(label),
    rawCount: all.length,
    count: clean.length,
    speakers: new Set(clean.map((u) => u.speaker)).size,
    text,
  };
}

module.exports = { loadMeeting, parseFile, dedupe, meetingKeyFromFile };
