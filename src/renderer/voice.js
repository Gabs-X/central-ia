/* Gravação de voz para o Whisper: microfone → PCM → WAV 16 kHz mono. */
/* global central */

const Voice = (() => {
  const TARGET_RATE = 16000;

  function downsample(chunks, inRate) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const input = new Float32Array(total);
    let o = 0;
    for (const c of chunks) {
      input.set(c, o);
      o += c.length;
    }
    if (inRate === TARGET_RATE) return input;
    const ratio = inRate / TARGET_RATE;
    const out = new Float32Array(Math.floor(input.length / ratio));
    for (let i = 0; i < out.length; i++) {
      // média simples do bloco (filtro passa-baixa barato)
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      out[i] = sum / Math.max(1, end - start);
    }
    return out;
  }

  function wav(samples) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (off, s) => [...s].forEach((ch, i) => v.setUint8(off + i, ch.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + samples.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, TARGET_RATE, true);
    v.setUint32(28, TARGET_RATE * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(buf);
  }

  /**
   * Começa a gravar. Para sozinho após `silenceMs` de silêncio depois de ouvir fala,
   * ou em `maxMs`. Devolve { stop(): Promise<Uint8Array|null>, done: Promise<Uint8Array|null> }.
   */
  async function record({ onLevel, silenceMs = 1600, maxMs = 60000, threshold = 0.015 } = {}) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    let heard = false;
    let lastVoice = performance.now();
    const started = performance.now();
    let finish;
    const done = new Promise((r) => (finish = r));
    let stopped = false;

    const stop = async (keep = true) => {
      if (stopped) return done;
      stopped = true;
      proc.disconnect();
      src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
      finish(keep && heard && chunks.length ? wav(downsample(chunks, ctx.sampleRate)) : null);
      return done;
    };

    proc.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(data));
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / (data.length / 4));
      onLevel?.(Math.min(1, rms * 12));
      const now = performance.now();
      if (rms > threshold) {
        heard = true;
        lastVoice = now;
      }
      if ((heard && now - lastVoice > silenceMs) || now - started > maxMs) stop(true);
      // Sem fala nenhuma em 8 s: desiste.
      if (!heard && now - started > 8000) stop(false);
    };
    src.connect(proc);
    proc.connect(ctx.destination);
    return { stop: () => stop(true), cancel: () => stop(false), done };
  }

  async function transcribe(bytes) {
    const r = await central.transcribe(bytes);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  // Escuta contínua: grava cada fala, transcreve e chama onCommand quando começa com a palavra de ativação.
  // O Whisper só roda quando há fala; o resto do tempo é só leitura do volume do microfone.
  // wakeWords aceita variações, porque o Whisper nem sempre escreve o nome do mesmo jeito.
  function listen({ wakeWords = ['ohara'], onCommand, onState }) {
    let active = true;
    let current = null;
    const wake = `(?:${wakeWords
      .map((w) => w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')})`;
    (async () => {
      while (active) {
        try {
          onState?.('ouvindo');
          current = await record({ silenceMs: 1200, maxMs: 20000 });
          const bytes = await current.done;
          if (!active) break;
          if (!bytes) continue;
          onState?.('transcrevendo');
          const text = await transcribe(bytes);
          const norm = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
          const m = norm.match(new RegExp(`^\\W*${wake}\\b[\\s,.:!-]*`));
          if (m) {
            const cmd = text.slice(m[0].length).trim();
            if (cmd) onCommand(cmd);
          }
        } catch (err) {
          onState?.(`erro: ${err.message}`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
      onState?.('desligada');
    })();
    return () => {
      active = false;
      current?.cancel();
    };
  }

  return { record, transcribe, listen };
})();
