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

  // Escuta contínua: o microfone fica aberto o tempo todo e cada fala (detectada pelo volume) vira um WAV
  // enviado ao processo principal, que transcreve e decide (chamada, pedido da conversa ou nada).
  // Não fica surda enquanto o Whisper trabalha: as falas entram numa fila.
  // Ignora o que for captado enquanto a própria Ohara está falando (isSpeaking).
  function listen({ onHeard, onState, isSpeaking = () => false, onLog = () => {} }) {
    let active = true;
    let stream = null;
    let ctx = null;
    let proc = null;
    let src = null;
    let keepAlive = null;
    const queue = [];
    let busy = false;

    const PRE_ROLL_MS = 600; // guarda um pouco antes do início da fala (para não cortar o "O" de "Ohara")
    const END_SILENCE_MS = 900;
    const MIN_SPEECH_MS = 280;
    const MAX_SEGMENT_MS = 15000;

    async function drain() {
      if (busy) return;
      busy = true;
      while (active && queue.length) {
        const bytes = queue.shift();
        onState?.('transcrevendo…');
        try {
          const r = await onHeard(bytes);
          if (r?.state) onState?.(r.state);
        } catch (err) {
          onState?.(`erro: ${err.message}`);
        }
      }
      busy = false;
      if (active && !queue.length) onState?.('ouvindo');
    }

    async function start() {
      onLog('pedindo acesso ao microfone');
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      onLog('acesso ao microfone liberado');
      ctx = new AudioContext();
      src = ctx.createMediaStreamSource(stream);
      proc = ctx.createScriptProcessor(2048, 1, 1);
      const rate = ctx.sampleRate;
      const chunkMs = (2048 / rate) * 1000;
      const preRoll = [];
      let seg = null; // { chunks, startedAt, lastVoice, speechMs }
      let noise = 0.004; // nível de ruído ambiente, aprendido aos poucos
      let speakingUntil = 0;
      // Resumo de 1 em 1 minuto no registro: mostra se o microfone está mesmo captando som.
      const stats = { peak: 0, segments: 0, short: 0, muted: 0, since: performance.now() };
      const track = stream.getAudioTracks()[0];
      onLog(`microfone aberto: "${track?.label || 'desconhecido'}" · ${rate} Hz · áudio ${ctx.state}`);

      proc.onaudioprocess = (e) => {
        const data = new Float32Array(e.inputBuffer.getChannelData(0));
        let sum = 0;
        for (let i = 0; i < data.length; i += 2) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / (data.length / 2));
        const now = performance.now();
        stats.peak = Math.max(stats.peak, rms);
        if (now - stats.since > 60000) {
          onLog(`escutando · pico de volume ${stats.peak.toFixed(3)} · limiar ${Math.max(0.01, noise * 3.2).toFixed(3)} · falas enviadas ${stats.segments} · curtas demais ${stats.short} · ignorado enquanto ela falava ${(stats.muted * chunkMs / 1000).toFixed(0)}s · áudio ${ctx.state}`);
          Object.assign(stats, { peak: 0, segments: 0, short: 0, muted: 0, since: now });
        }

        // Enquanto a Ohara fala (e logo depois), não grava: senão ela ouve a própria voz.
        if (isSpeaking()) speakingUntil = now + 700;
        if (now < speakingUntil) {
          stats.muted++;
          seg = null;
          preRoll.length = 0;
          return;
        }

        const threshold = Math.max(0.01, noise * 3.2);
        const voiced = rms > threshold;
        if (!seg && !voiced) noise = noise * 0.97 + rms * 0.03;

        if (!seg) {
          preRoll.push(data);
          while (preRoll.length * chunkMs > PRE_ROLL_MS) preRoll.shift();
          if (voiced) {
            seg = { chunks: [...preRoll], startedAt: now, lastVoice: now, speechMs: 0 };
            preRoll.length = 0;
          }
          return;
        }

        seg.chunks.push(data);
        if (voiced) {
          seg.lastVoice = now;
          seg.speechMs += chunkMs;
        }
        if (now - seg.lastVoice > END_SILENCE_MS || now - seg.startedAt > MAX_SEGMENT_MS) {
          const done = seg;
          seg = null;
          if (done.speechMs >= MIN_SPEECH_MS) {
            stats.segments++;
            queue.push(wav(downsample(done.chunks, rate)));
            drain();
          } else stats.short++;
        }
      };
      src.connect(proc);
      proc.connect(ctx.destination);
      onState?.('ouvindo');

      // O Windows às vezes suspende o áudio da janela escondida ou troca o microfone: religa sozinho.
      keepAlive = setInterval(async () => {
        if (!active) return;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const track = stream.getAudioTracks()[0];
        if (!track || track.readyState === 'ended') {
          onLog('microfone desconectado: reabrindo');
          stopAudio();
          start().catch((err) => {
            onLog(`erro ao reabrir o microfone: ${err.message}`);
            onState?.(`erro: ${err.message}`);
          });
        }
      }, 3000);
    }

    function stopAudio() {
      clearInterval(keepAlive);
      try { proc?.disconnect(); src?.disconnect(); } catch { /* já desligado */ }
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
      stream = ctx = proc = src = null;
    }

    // Tenta abrir o microfone; se falhar (ex.: ainda não liberado ao iniciar com o Windows), tenta de novo a cada 10 s.
    const open = () =>
      start().catch((err) => {
        onLog(`erro ao abrir o microfone: ${err.message}`);
        onState?.(`erro no microfone: ${err.message}`);
        if (active) setTimeout(open, 10000);
      });
    open();

    return () => {
      active = false;
      queue.length = 0;
      stopAudio();
      onState?.('desligada');
    };
  }

  return { record, transcribe, listen };
})();
