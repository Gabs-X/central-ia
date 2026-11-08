// Palavra de ativação "Ohara" na transcrição do Whisper, tolerante aos jeitos como ele escreve o nome
// ("O Hara", "O Herra", "Oara", "Orara"...). Também reconhece um "ei/oi" antes ("Ei, Ohara, ...").

const WAKE = 'ohara';
const FILLERS = new Set(['ei', 'ey', 'hey', 'oi', 'ola', 'e', 'ô', 'o', 'ah', 'eh', 'opa', 'alo']);

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

// Parece "ohara"? Igual ou a 1 letra; a 2 letras só se começar com "o" (evita "agora", "para"...).
function soundsLikeOhara(word) {
  if (word.length < 3 || word.length > 8) return false;
  const dist = distance(word, WAKE);
  return dist <= 1 || (dist === 2 && word[0] === 'o' && word.length >= 4);
}

/**
 * @returns {null | { command: string, wakeOnly: boolean }}
 *   null quando a fala não começa chamando a Ohara.
 */
function matchWake(text) {
  const original = String(text || '').trim();
  // Palavras com a posição de cada uma no texto original (para recortar o comando sem perder acentos).
  const words = [];
  const re = /[\p{L}\p{N}'-]+/gu;
  let m;
  while ((m = re.exec(original)) && words.length < 6) words.push({ w: norm(m[0]).replace(/['-]/g, ''), end: m.index + m[0].length });
  if (!words.length) return null;

  // Até um "ei/oi" antes do nome; o nome pode vir em 1 ou 2 palavras ("O Hara", "Oh Hara").
  for (let start = 0; start <= 1 && start < words.length; start++) {
    if (start === 1 && !FILLERS.has(words[0].w)) break;
    for (const len of [1, 2]) {
      const part = words.slice(start, start + len);
      if (part.length < len) continue;
      if (soundsLikeOhara(part.map((p) => p.w).join(''))) {
        const command = original.slice(part[part.length - 1].end).replace(/^[\s,.:;!?…-]+/, '').trim();
        return { command, wakeOnly: !command.replace(/[\s.!?…]/g, '') };
      }
    }
  }
  return null;
}

const plainWords = (text) => norm(text).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

// "valeu", "tchau", "Ohara, chega. Tchau.", "pode parar": encerra a conversa por voz.
// Só em falas curtas, para não encerrar por causa de um "tchau" no meio de uma conversa longa.
const END_RE = /\b(valeu|obrigad[oa]|brigad[oa]|tchau|ate mais|ate logo|pode parar|chega|encerra\w*|fim da conversa|so isso|era so isso|deixa pra la|nada nao)\b/;
function isEndPhrase(text) {
  const ws = plainWords(text);
  return ws.length > 0 && ws.length <= 8 && END_RE.test(ws.join(' '));
}

// "desativa o microfone", "para de me ouvir", "desliga a escuta": desliga a escuta contínua.
const MIC_OFF_RE = /\b(desativ\w*|deslig\w*|para de|parar de|pare de|nao quero que)\b.*\b(microfone|escuta\w*|ouvir|me ouvir|escutar|me escutar|ouvindo|escutando)\b/;
function isMicOff(text) {
  const ws = plainWords(text);
  return ws.length > 0 && ws.length <= 12 && MIC_OFF_RE.test(ws.join(' '));
}

module.exports = { matchWake, soundsLikeOhara, isEndPhrase, isMicOff };
