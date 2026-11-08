// Voz neural (as mesmas vozes do "Ler em voz alta" do Edge), muito mais natural que as vozes SAPI do Windows.
// Precisa de internet: o texto é enviado ao serviço de fala da Microsoft. Sem conexão, o app volta para a voz do Windows.
const fs = require('fs');
const path = require('path');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const NEURAL_VOICES = [
  { id: 'pt-BR-FranciscaNeural', label: 'Francisca (feminina, natural)' },
  { id: 'pt-BR-AntonioNeural', label: 'Antonio (masculina, natural)' },
];
const isNeural = (voice) => /Neural$/i.test(String(voice || ''));

const MAX_CHUNK = 450; // trechos curtos: o primeiro começa a tocar rápido

// Pronúncia japonesa de "Ohara" (o-HA-ra, com o "h" aspirado) escrita para a voz em português:
// o "rr" brasileiro faz o som do "h" japonês e o "r" final é leve. Só muda a fala; a tela continua "Ohara".
const PRONUNCIATION = [[/\bOhara\b/gi, 'Orrara']];

// Deixa o texto bom de ouvir: sem código, markdown, links crus nem emojis.
function cleanForSpeech(text) {
  let s = String(text || '');
  for (const [re, said] of PRONUNCIATION) s = s.replace(re, said);
  return s
    .replace(/\[\[[\s\S]*?\]\]/g, ' ') // marcações internas ([[melhoria: ...]], [[whatsapp ...]])
    .replace(/\[\[[^\]]*$/, ' ') // marcação ainda chegando (leitura em fluxo)
    .replace(/^[^[]*\]\]/, ' ') // fim de uma marcação que começou no trecho anterior
    .replace(/```[\s\S]*?```/g, ' (tem um trecho de código na tela) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\((?:https?:)?[^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'o link')
    .replace(/^\s*\|.*\|\s*$/gm, '') // tabelas
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/[>#|]/g, ' ')
    .replace(/\p{Extended_Pictographic}️?/gu, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/(\.\s*){2,}/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Divide em frases, juntando até MAX_CHUNK caracteres por trecho.
function splitForSpeech(text, max = MAX_CHUNK) {
  const sentences = text.match(/[^.!?…]+[.!?…]*\s*/g) || [];
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (s.length > max) {
      if (cur.trim()) chunks.push(cur.trim());
      cur = '';
      for (let i = 0; i < s.length; i += max) chunks.push(s.slice(i, i + max).trim());
      continue;
    }
    if ((cur + s).length > max && cur.trim()) {
      chunks.push(cur.trim());
      cur = '';
    }
    cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}

/**
 * Leitura em fluxo: separa do início do texto que está chegando um trecho já pronto para falar
 * (termina em fim de frase e tem pelo menos `minLen` caracteres). O resto espera mais texto.
 * @returns {{ piece: string, rest: string } | null}
 */
function takeSpeakable(buf, minLen = 60) {
  const re = /[.!?…:](?=\s|$)|\n\n/g;
  let cut = -1;
  let m;
  while ((m = re.exec(buf))) {
    const end = m.index + m[0].length;
    if (end >= minLen) {
      cut = end;
      break;
    }
  }
  if (cut < 0 || cut === buf.length) return null; // sem fim de frase, ou pode ainda estar chegando ("3." de "3.5")
  return { piece: buf.slice(0, cut), rest: buf.slice(cut) };
}

const escapeXml = (s) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

class NeuralTTS {
  constructor({ dir }) {
    this.dir = dir; // pasta temporária dos áudios
    this.n = 0;
  }

  /** Sintetiza um trecho e devolve o caminho do MP3. */
  // rate: velocidade da fala, ex. '+15%' (mais rápida) ou '-10%'.
  async synth(text, voice, rate) {
    const out = path.join(this.dir, `fala-${Date.now()}-${this.n++}`);
    fs.mkdirSync(out, { recursive: true });
    const tts = new MsEdgeTTS();
    try {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
      const { audioFilePath } = await tts.toFile(out, escapeXml(text), rate ? { rate } : undefined);
      if (!fs.existsSync(audioFilePath) || fs.statSync(audioFilePath).size < 1000) throw new Error('áudio vazio');
      return audioFilePath;
    } finally {
      tts.close();
    }
  }

  // Apaga áudios de falas antigas (mais de 10 min).
  cleanup() {
    try {
      for (const name of fs.readdirSync(this.dir)) {
        const p = path.join(this.dir, name);
        if (Date.now() - fs.statSync(p).mtimeMs > 10 * 60_000) fs.rmSync(p, { recursive: true, force: true });
      }
    } catch { /* pasta ainda não existe */ }
  }
}

module.exports = { NeuralTTS, NEURAL_VOICES, isNeural, cleanForSpeech, splitForSpeech, takeSpeakable };
