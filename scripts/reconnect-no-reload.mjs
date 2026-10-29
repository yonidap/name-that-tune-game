import fs from 'node:fs';

function replaceOnce(text, oldText, newText, label) {
  if (!text.includes(oldText)) throw new Error(`${label}: source block not found`);
  return text.replace(oldText, newText);
}

{
  const file = 'public/interaction-ui.js';
  let s = fs.readFileSync(file, 'utf8');
  s = replaceOnce(
    s,
    "  if (!session) {\n    location.reload();\n    return;\n  }",
    "  if (!session) {\n    window.dispatchEvent(new CustomEvent('ntt:captain-reconnect-request'));\n    return;\n  }",
    'remove reconnect reload fallback'
  );
  fs.writeFileSync(file, s);
}

{
  const file = 'public/game.js';
  let s = fs.readFileSync(file, 'utf8');
  const marker = "window.addEventListener('ntt:captain-reconnected', (event) => {\n";
  const handler = "window.addEventListener('ntt:captain-reconnect-request', async () => {\n  if (mode !== 'captain' || !roomCode || !['A','B'].includes(team) || !captainToken) return;\n  const result = await api('/api/captain/join', { roomCode, team, captainToken, forceReconnect:true });\n  if (!result?.ok || !result.captainToken || !result.state) return;\n  captainToken = result.captainToken; state = result.state;\n  finishRestore(); saveCaptain(); connectEvents(); render();\n});\n\n";
  if (!s.includes(marker)) throw new Error('reconnect event marker not found');
  s = s.replace(marker, handler + marker);
  fs.writeFileSync(file, s);
}

{
  const file = 'test/captain-live-sync.test.js';
  let s = fs.readFileSync(file, 'utf8');
  s = replaceOnce(
    s,
    "  assert.doesNotMatch(interaction, /result\\.captainToken[\\s\\S]{0,500}location\\.reload\\(\\)/);",
    "  assert.doesNotMatch(interaction, /location\\.reload\\(\\)/, 'captain reconnect must never reload the page');\n  assert.match(client, /ntt:captain-reconnect-request/);",
    'no reload regression assertion'
  );
  fs.writeFileSync(file, s);
}

console.log('No-reload reconnect hardening applied.');
