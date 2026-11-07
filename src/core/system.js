// Integrações diretas com o Windows que não precisam de IA.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let ttsProc = null;

function powershell(script) {
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  }).on('error', () => {}).stdin.end(script);
}

// Lê um texto em voz alta com a voz pt-BR do Windows (offline).
function speak(text, voice) {
  stopSpeaking();
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, ' bloco de código. ')
    .replace(/[`*_#>|]/g, '')
    .slice(0, 4000);
  const b64 = Buffer.from(clean, 'utf8').toString('base64');
  const script = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $s.SelectVoice('${String(voice).replace(/'/g, "''")}') } catch {}
$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))
$s.Speak($t)`;
  ttsProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  ttsProc.on('error', () => {});
  ttsProc.stdin.end(script);
}

function stopSpeaking() {
  if (ttsProc && ttsProc.exitCode === null) {
    spawn('taskkill', ['/pid', String(ttsProc.pid), '/T', '/F'], { windowsHide: true });
  }
  ttsProc = null;
}

// Abre a digitação por voz do Windows (Win+H), que entende pt-BR.
// O campo de texto da janela precisa estar focado antes.
function startVoiceTyping() {
  powershell(`
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class K { [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e); }
'@
[K]::keybd_event(0x5B,0,0,[UIntPtr]::Zero)
[K]::keybd_event(0x48,0,0,[UIntPtr]::Zero)
[K]::keybd_event(0x48,0,2,[UIntPtr]::Zero)
[K]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)`);
}

// Lista as pastas de projeto (com .git) até dois níveis abaixo da raiz.
function listRepos(root) {
  const out = [];
  const visit = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (depth > 0 && entries.some((e) => e.name === '.git')) {
      out.push(dir);
      return;
    }
    if (depth >= 2) return;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') visit(path.join(dir, e.name), depth + 1);
    }
  };
  visit(root, 0);
  return out.sort((a, b) => a.localeCompare(b));
}

module.exports = { speak, stopSpeaking, startVoiceTyping, listRepos };
