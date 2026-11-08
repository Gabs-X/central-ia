/* global central, esc, toast, callSafe, applyListening */
// Tela "Ajustes": integrações (agenda, GitHub, Slack), voz, atalhos, reuniões e geral.

async function renderSettings() {
  const [cfg, hk, cal, sl, ws, login, wa] = await Promise.all([
    central.getConfig(),
    central.hotkeyStatus(),
    central.calendarStatus(),
    central.slackStatus(),
    central.whisperStatus(),
    central.loginItem(),
    central.whatsappStatus(),
  ]);
  const body = document.getElementById('settings-body');
  const ok = (good, text) => `<span class="status ${good ? 'good' : 'bad'}">${good ? '●' : '○'} ${esc(text)}</span>`;
  const I = cfg.integrations;

  body.innerHTML = `
  <div class="settings">
    <section class="section">
      <h2>📅 Agenda</h2>
      <p class="muted small">Google Agenda → ⚙️ Configurações → clique na sua agenda → <b>Endereço secreto no formato iCal</b>. Com ela, a aba Hoje mostra suas reuniões e a pauta chega ${cfg.meetings.prepMinutes} min antes. O endereço fica criptografado neste PC.</p>
      <div class="row"><input id="cal-url" type="password" placeholder="https://calendar.google.com/calendar/ical/.../basic.ics" value="${I.calendarIcsUrlSet ? '••••••' : ''}"><button class="btn small-btn" id="cal-save">Salvar</button>${I.calendarIcsUrlSet ? '<button class="btn small-btn" id="cal-clear">Remover</button>' : ''}</div>
      <p>${cal.configured ? (cal.error ? ok(false, `erro: ${cal.error}`) : ok(true, `${cal.count} evento(s) nos próximos 8 dias · ${cal.today.length} hoje`)) : ok(false, 'não conectada')}</p>
    </section>

    <section class="section">
      <h2>🔀 GitHub</h2>
      <p class="muted small">Usa o <code>gh</code> já logado neste PC. Mostra na aba Hoje as PRs esperando seu review e as suas abertas.</p>
      <label class="check"><input type="checkbox" id="gh-on" ${I.github.enabled ? 'checked' : ''}> Ligado</label>
      <label>Contas do gh (separe por vírgula)<div class="row"><input id="gh-accounts" value="${esc(I.github.accounts.join(', '))}"><button class="btn small-btn" id="gh-save">Salvar</button><button class="btn small-btn" id="gh-test">Testar</button></div></label>
      <p id="gh-result" class="small"></p>
    </section>

    <section class="section">
      <h2>💬 Slack</h2>
      <p class="muted small">Precisa de um <b>token de usuário</b> (xoxp-…) de um app Slack seu com os escopos <code>search:read</code>, <code>users:read</code>, <code>im:write</code> e <code>chat:write</code>. Com ele a Ohara envia cobranças por DM e importa menções como demandas. O token fica criptografado neste PC.</p>
      <div class="row"><input id="sl-token" type="password" placeholder="xoxp-..." value="${I.slack.tokenSet ? '••••••' : ''}"><button class="btn small-btn" id="sl-save">Salvar</button>${I.slack.tokenSet ? '<button class="btn small-btn" id="sl-clear">Remover</button>' : ''}</div>
      <p>${!sl.configured ? ok(false, 'não conectado') : sl.ok ? ok(true, `conectado como ${sl.name} (${sl.team})`) : ok(false, sl.error)}</p>
      ${sl.ok ? '<button class="btn small-btn" id="sl-import">Importar menções agora</button> <span class="muted small">Para importar sozinho, ligue o agendamento “Importar menções do Slack” em Automações.</span>' : ''}
    </section>

    <section class="section">
      <h2>📱 WhatsApp</h2>
      <h3>Mensagens para você</h3>
      <p class="muted small">Quando você pedir (“me manda no WhatsApp o resumo da reunião”) e quando uma reunião gerar demandas novas para você. Usa o <b>CallMeBot</b>: siga o passo a passo do <a href="https://www.callmebot.com/blog/free-api-whatsapp-messages/" target="_blank">site do CallMeBot</a> (você manda uma mensagem de autorização para o número deles) e cole aqui a chave (apikey) recebida. A chave fica criptografada neste PC.</p>
      <div class="row"><input id="wa-phone" placeholder="Seu número com DDI, ex.: +5511999999999" value="${esc(I.whatsapp?.phone || '')}"><input id="wa-key" type="password" placeholder="apikey" value="${I.whatsapp?.apikeySet ? '••••••' : ''}"><button class="btn small-btn" id="wa-save">Salvar</button>${wa.configured ? '<button class="btn small-btn" id="wa-test">Enviar teste</button><button class="btn small-btn" id="wa-clear">Remover</button>' : ''}</div>
      <p>${wa.configured ? ok(true, `configurado para ${wa.phone}`) : ok(false, 'não configurado')}</p>
      <label class="check"><input type="checkbox" id="wa-meetings" ${I.whatsapp?.notifyMeetingTasks !== false ? 'checked' : ''}> Avisar no WhatsApp quando uma reunião gerar demandas novas para mim</label>

      <h3>Mensagens para os seus contatos</h3>
      <p class="muted small">Peça “manda pro João no zap que vou atrasar”: a Ohara escreve a mensagem e mostra um cartão para você <b>confirmar antes de enviar</b>. Usa o seu WhatsApp Web numa janela da Ohara: conecte uma vez escaneando o QR Code (WhatsApp no celular → Aparelhos conectados). Não é a API oficial do WhatsApp; em tese, a conta pode sofrer restrição.</p>
      <div class="row"><button class="btn small-btn" id="waw-connect">Conectar / abrir WhatsApp Web</button><button class="btn small-btn" id="waw-check">Verificar conexão</button><span id="waw-state" class="small"></span></div>
    </section>

    <section class="section">
      <h2>🎙️ Voz</h2>
      <p class="muted small">Transcrição local com o whisper.cpp (offline, entende pt-BR). Na primeira vez baixa o programa oficial (GitHub ggml-org/whisper.cpp) e o modelo escolhido (Hugging Face).</p>
      <p>${ws.installed ? ok(true, `instalado · modelo ${ws.modelName}`) : ok(false, ws.installing ? 'instalando…' : `não instalado${ws.exe ? ' (falta o modelo)' : ''}`)}</p>
      <div class="row">
        <select id="w-model">${[['tiny', 'tiny · 75 MB, mais rápido'], ['base', 'base · 148 MB, equilibrado'], ['small', 'small · 488 MB, mais preciso']].map(([v, l]) => `<option value="${v}" ${cfg.voice.whisperModel === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="btn small-btn" id="w-install">${ws.installed ? 'Reinstalar/trocar modelo' : 'Instalar'}</button>
      </div>
      <p id="w-progress" class="small muted"></p>
      <label class="check"><input type="checkbox" id="w-wake" ${cfg.voice.wakeWord ? 'checked' : ''} ${ws.installed ? '' : 'disabled'}> Escuta contínua: diga <b>“Ohara”</b>, ela responde e a conversa fica aberta (fale os pedidos sem repetir o nome; “valeu” encerra) <span class="muted small">(<span id="listen-state">—</span>; passe o mouse para ver as últimas falas ouvidas)</span></label>
      <label class="check"><input type="checkbox" id="w-autosend" ${cfg.voice.autoSendVoice ? 'checked' : ''}> Na janela rápida, enviar assim que terminar de transcrever</label>
      <label class="check"><input type="checkbox" id="w-speak" ${cfg.voice.speakReplies ? 'checked' : ''}> Ler respostas em voz alta</label>
      <label>Voz da Ohara<div class="row">
        <select id="w-tts">${[
          ['pt-BR-FranciscaNeural', 'Francisca · feminina, natural'],
          ['pt-BR-AntonioNeural', 'Antonio · masculina, natural'],
          ['Microsoft Maria Desktop', 'Maria · voz do Windows (robótica, funciona sem internet)'],
        ].map(([v, l]) => `<option value="${v}" ${cfg.voice.ttsVoice === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="btn small-btn" id="w-tts-test">▶ Ouvir</button>
      </div></label>
      <p class="muted small">As vozes naturais são as mesmas do “Ler em voz alta” do Edge: o texto vai para o serviço de fala da Microsoft. Sem internet, ela usa a voz do Windows.</p>
    </section>

    <section class="section">
      <h2>⌨️ Atalhos globais</h2>
      <p class="muted small">Formato do Electron: <code>CommandOrControl+Alt+V</code>, <code>Alt+Space</code>…</p>
      <table class="table compact"><tbody>${[
        ['toggle', 'Mostrar/esconder a Ohara'],
        ['quick', 'Janela rápida'],
        ['clipboard', 'Janela rápida com o que você copiou'],
        ['voice', 'Falar (gravar e transcrever)'],
      ].map(([k, l]) => `<tr><td>${l}</td><td><input data-hk="${k}" value="${esc(cfg.hotkeys[k] || '')}"></td><td>${hk[k] ? ok(hk[k] === 'ok', hk[k]) : ''}</td></tr>`).join('')}</tbody></table>
      <button class="btn small-btn" id="hk-save">Salvar atalhos</button>
    </section>

    <section class="section">
      <h2>📋 Reuniões</h2>
      <label>Pasta dos transcripts<div class="row"><input id="m-folder" value="${esc(cfg.meetings.folder)}"><button class="btn small-btn" id="m-pick">Escolher…</button></div></label>
      <div class="row wrap">
        <label>Mínimo de falas<input id="m-min" type="number" min="1" value="${cfg.meetings.minUtterances}"></label>
        <label>Aviso de pauta (min antes)<input id="m-prep" type="number" min="0" max="60" value="${cfg.meetings.prepMinutes}"></label>
        <label>Ignorar reuniões antes de<input id="m-ignore" type="date" value="${esc(cfg.meetings.ignoreBefore || '')}"></label>
      </div>
      <label class="check"><input type="checkbox" id="m-on" ${cfg.meetings.enabled ? 'checked' : ''}> Monitorar a pasta</label>
      <button class="btn small-btn" id="m-save">Salvar</button>
    </section>

    <section class="section">
      <h2>🖥️ Geral</h2>
      <label class="check"><input type="checkbox" id="g-login" ${login.enabled ? 'checked' : ''} ${login.available ? '' : 'disabled'}> Iniciar com o Windows (escondida na bandeja)${login.available ? '' : ' <span class="muted small">— só no app instalado</span>'}</label>
      <label>Pasta para arquivos gerados<input id="g-out" value="${esc(cfg.outputDir)}"></label>
      <label>Raiz dos repositórios<input id="g-root" value="${esc(cfg.workspaceRoot)}"></label>
      <label>Pasta de login do Claude <span class="muted small">— vazio = ~/.claude-pessoal (sua conta pessoal); ~/.claude = conta da empresa</span><input id="g-claude-dir" value="${esc(cfg.claude?.configDir || '')}" placeholder="~/.claude-pessoal"></label>
      <button class="btn small-btn" id="g-save">Salvar</button>
    </section>
  </div>`;

  const $s = (sel) => body.querySelector(sel);
  const save = async (partial, msg = 'Salvo.') => {
    await central.setConfig(partial);
    toast(msg);
  };

  // Agenda
  $s('#cal-save').addEventListener('click', async () => {
    const v = $s('#cal-url').value.trim();
    if (v === '••••••') return;
    if (v && !/^https:\/\//.test(v)) return toast('O endereço precisa começar com https://', 'error');
    await save({ integrations: { calendarIcsUrl: v } }, 'Agenda salva. Carregando eventos…');
    setTimeout(renderSettings, 2500);
  });
  $s('#cal-clear')?.addEventListener('click', async () => { await save({ integrations: { calendarIcsUrl: '' } }, 'Agenda removida.'); renderSettings(); });

  // GitHub
  const ghAccounts = () => $s('#gh-accounts').value.split(',').map((x) => x.trim()).filter(Boolean);
  $s('#gh-save').addEventListener('click', () => save({ integrations: { github: { enabled: $s('#gh-on').checked, accounts: ghAccounts() } } }));
  $s('#gh-on').addEventListener('change', () => save({ integrations: { github: { enabled: $s('#gh-on').checked } } }));
  $s('#gh-test').addEventListener('click', async () => {
    await central.setConfig({ integrations: { github: { accounts: ghAccounts() } } });
    $s('#gh-result').textContent = 'Consultando…';
    const r = await central.githubPrs(true);
    $s('#gh-result').textContent = r.ok ? `${r.data.review.length} PR(s) para revisar, ${r.data.mine.length} sua(s) abertas${r.data.errors.length ? ` · erros: ${r.data.errors.join('; ')}` : ''}` : r.error;
  });

  // Slack
  $s('#sl-save').addEventListener('click', async () => {
    const v = $s('#sl-token').value.trim();
    if (v === '••••••') return;
    if (v && !/^xox[pb]-/.test(v)) return toast('O token deve começar com xoxp-', 'error');
    await save({ integrations: { slack: { token: v } } }, 'Token salvo.');
    renderSettings();
  });
  $s('#sl-clear')?.addEventListener('click', async () => { await save({ integrations: { slack: { token: '' } } }, 'Slack desconectado.'); renderSettings(); });
  // WhatsApp
  $s('#wa-save').addEventListener('click', async () => {
    const phone = $s('#wa-phone').value.trim().replace(/[\s()-]/g, '');
    const key = $s('#wa-key').value.trim();
    if (!/^\+\d{10,15}$/.test(phone)) return toast('Informe o número com DDI, ex.: +5511999999999', 'error');
    const partial = { integrations: { whatsapp: { phone } } };
    if (key && key !== '••••••') partial.integrations.whatsapp.apikey = key;
    await save(partial, 'WhatsApp salvo.');
    renderSettings();
  });
  $s('#wa-test')?.addEventListener('click', async () => {
    const r = await callSafe(central.whatsappSend('✅ Teste da Ohara: o WhatsApp está funcionando.'), 'WhatsApp: ');
    if (r != null) toast('Mensagem de teste enviada. Confira o seu WhatsApp.');
  });
  $s('#wa-clear')?.addEventListener('click', async () => { await save({ integrations: { whatsapp: { phone: '', apikey: '' } } }, 'WhatsApp removido.'); renderSettings(); });
  $s('#wa-meetings').addEventListener('change', (e) => save({ integrations: { whatsapp: { notifyMeetingTasks: e.target.checked } } }));
  $s('#waw-connect').addEventListener('click', () => central.whatsappWebConnect());
  $s('#waw-check').addEventListener('click', async () => {
    const st = $s('#waw-state');
    st.textContent = 'Verificando…';
    const r = await central.whatsappWebStatus();
    st.innerHTML = r.connected ? ok(true, 'conectado') : ok(false, r.loading ? 'não respondeu; abra o WhatsApp Web e confira' : 'não conectado: clique em Conectar e escaneie o QR Code');
  });

  $s('#sl-import')?.addEventListener('click', async () => {
    const n = await callSafe(central.slackImport(), 'Slack: ');
    if (n != null) toast(`${n} demanda(s) importada(s).`);
  });

  // Voz
  $s('#w-install').addEventListener('click', async () => {
    await central.setConfig({ voice: { whisperModel: $s('#w-model').value } });
    $s('#w-install').disabled = true;
    $s('#w-progress').textContent = 'Baixando…';
    const r = await central.whisperInstall();
    if (!r.ok) toast(`Whisper: ${r.error}`, 'error');
    else toast('Whisper instalado.');
    renderSettings();
  });
  $s('#w-wake').addEventListener('change', async (e) => {
    const c = await central.setConfig({ voice: { wakeWord: e.target.checked } });
    applyListening(c);
  });
  $s('#w-autosend').addEventListener('change', (e) => save({ voice: { autoSendVoice: e.target.checked } }));
  $s('#w-tts').addEventListener('change', (e) => save({ voice: { ttsVoice: e.target.value } }, 'Voz salva.'));
  $s('#w-tts-test').addEventListener('click', () =>
    central.speak('Oi, Gabriel! Eu sou a Ohara. Abri o Spotify pra você e já deixei o resumo da reunião no painel de demandas.', $s('#w-tts').value),
  );
  $s('#w-speak').addEventListener('change', (e) => {
    save({ voice: { speakReplies: e.target.checked } });
    const chk = document.getElementById('speak-replies');
    if (chk) chk.checked = e.target.checked;
  });

  // Atalhos
  $s('#hk-save').addEventListener('click', async () => {
    const hotkeys = {};
    body.querySelectorAll('[data-hk]').forEach((i) => (hotkeys[i.dataset.hk] = i.value.trim()));
    await save({ hotkeys }, 'Atalhos salvos.');
    renderSettings();
  });

  // Reuniões
  $s('#m-pick').addEventListener('click', async () => {
    const p = await central.pickFolder();
    if (p) $s('#m-folder').value = p;
  });
  $s('#m-save').addEventListener('click', () =>
    save({
      meetings: {
        folder: $s('#m-folder').value.trim(),
        minUtterances: Number($s('#m-min').value) || 15,
        prepMinutes: Number($s('#m-prep').value) || 0,
        ignoreBefore: $s('#m-ignore').value || null,
        enabled: $s('#m-on').checked,
      },
    }),
  );

  // Geral
  $s('#g-login').addEventListener('change', (e) => central.loginItem(e.target.checked));
  $s('#g-save').addEventListener('click', () => save({ outputDir: $s('#g-out').value.trim(), workspaceRoot: $s('#g-root').value.trim(), claude: { configDir: $s('#g-claude-dir').value.trim() } }));
}

central.onWhisperProgress((p) => {
  const el = document.getElementById('w-progress');
  if (el) el.textContent = `Baixando ${p.step}… ${Math.round((p.pct || 0) * 100)}%`;
});
