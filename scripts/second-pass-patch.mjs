import fs from 'node:fs';

function replaceOnce(text, oldText, newText, label) {
  if (!text.includes(oldText)) throw new Error(`${label}: source block not found`);
  return text.replace(oldText, newText);
}

// public/game.js — cancel stale audio loads/play commands and bound API hangs.
{
  const path = 'public/game.js';
  let s = fs.readFileSync(path, 'utf8');

  s = replaceOnce(
    s,
    "let restoreAttempt = 0;\n",
    "let restoreAttempt = 0;\nlet audioLoadGeneration = 0;\nlet playbackCommandGeneration = 0;\n",
    'audio generation state'
  );

  s = replaceOnce(
    s,
`function api(path, payload = {}) {
  return fetch(path, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(payload) })
    .then(async (res) => res.json().catch(() => ({ ok:false, error:'BAD_RESPONSE' })))
    .catch(() => ({ ok:false, error:'NETWORK_ERROR' }));
}
`,
`function api(path, payload = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  return fetch(path, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(payload), signal:controller.signal })
    .then(async (res) => res.json().catch(() => ({ ok:false, error:'BAD_RESPONSE' })))
    .catch(() => ({ ok:false, error:'NETWORK_ERROR' }))
    .finally(() => clearTimeout(timeout));
}
`,
    'bounded API requests'
  );

  s = replaceOnce(
    s,
`  eventSource.addEventListener('state', (event) => {
    const next = JSON.parse(event.data);
    const patch = canPatchLive(state, next);
    state = next;
    roomCode = state.roomCode;
    if (patch) updateLiveUi(); else render();
  });
`,
`  eventSource.addEventListener('state', (event) => {
    const previous = state;
    const next = JSON.parse(event.data);
    if (mode === 'display' && previous) {
      const leftPlayback = next.phase !== 'PLAYING' && (previous.phase === 'PLAYING' || activePlaybackSeq);
      const changedSong = previous.currentIndex !== next.currentIndex;
      if (leftPlayback || changedSong) {
        playbackCommandGeneration += 1;
        audio.pause();
        clearInterval(progressTimer); progressTimer = null;
        activePlaybackSeq = 0;
      }
    }
    const patch = canPatchLive(previous, next);
    state = next;
    roomCode = state.roomCode;
    if (patch) updateLiveUi(); else render();
  });
`,
    'state playback invalidation'
  );

  s = replaceOnce(
    s,
`function clearDisplaySession() {
  localStorage.removeItem('ntt-display');
  eventSource?.close();
  eventSource = null;
  audio.pause();
  clearInterval(progressTimer);
  progressTimer = null;
  state = null; roomCode = ''; displayToken = ''; hostPin = ''; audioUnlocked = false; currentAudioKey = ''; currentAudioPromise = null; activePlaybackSeq = 0;
  history.replaceState({}, '', '/host');
  render();
}
`,
`function clearDisplaySession() {
  localStorage.removeItem('ntt-display');
  eventSource?.close();
  eventSource = null;
  audioLoadGeneration += 1;
  playbackCommandGeneration += 1;
  audio.pause();
  clearInterval(progressTimer);
  progressTimer = null;
  if (demoUrl) { URL.revokeObjectURL(demoUrl); demoUrl = null; }
  state = null; roomCode = ''; displayToken = ''; hostPin = ''; audioUnlocked = false; currentAudioKey = ''; currentAudioPromise = null; activePlaybackSeq = 0;
  history.replaceState({}, '', '/host');
  render();
}
`,
    'display teardown'
  );

  s = replaceOnce(
    s,
`  document.querySelector('#enable-audio')?.addEventListener('click', async () => {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx(); await ctx.resume();
      const osc = ctx.createOscillator(); const gain = ctx.createGain(); gain.gain.value = .00001; osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + .03);
      const previousVolume = audio.volume;
      audio.volume = 0; audio.src = createDemoTone(.08); audio.load(); await audio.play(); audio.pause(); audio.currentTime = 0; audio.volume = previousVolume; currentAudioKey = ''; currentAudioPromise = null;
      audioUnlocked = true;
      await emit('display:audioReady', { ready:true });
      render();
    } catch { alert('Audio could not be enabled.'); }
  });
`,
`  document.querySelector('#enable-audio')?.addEventListener('click', async () => {
    try {
      audioLoadGeneration += 1;
      playbackCommandGeneration += 1;
      clearInterval(progressTimer); progressTimer = null; activePlaybackSeq = 0;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx(); await ctx.resume();
      const osc = ctx.createOscillator(); const gain = ctx.createGain(); gain.gain.value = .00001; osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + .03);
      const previousVolume = audio.volume;
      audio.volume = 0; audio.src = createDemoTone(.08); audio.load(); await audio.play(); audio.pause(); audio.currentTime = 0; audio.volume = previousVolume;
      try { await ctx.close(); } catch {}
      audioLoadGeneration += 1;
      playbackCommandGeneration += 1;
      currentAudioKey = ''; currentAudioPromise = null;
      audioUnlocked = true;
      await emit('display:audioReady', { ready:true });
      render();
    } catch { alert('Audio could not be enabled.'); }
  });
`,
    'speaker unlock hardening'
  );

  const start = s.indexOf('async function waitForAudioReady(timeoutMs = 6000) {');
  const endStart = s.indexOf("audio.addEventListener('ended', () => {", start);
  const end = endStart === -1 ? -1 : s.indexOf('\n});', endStart) + 4;
  if (start === -1 || endStart === -1 || end < 4) throw new Error('audio lifecycle block not found');

  const audioBlock = `async function waitForAudioReady(timeoutMs = 6000) {
  if (audio.readyState >= 3) return true;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (settled) return; settled = true; cleanup(); resolve(value); };
    const yes = () => done(true);
    const no = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    const cleanup = () => { audio.removeEventListener('canplay', yes); audio.removeEventListener('error', no); clearTimeout(timer); };
    audio.addEventListener('canplay', yes, { once:true });
    audio.addEventListener('error', no, { once:true });
  });
}
async function prepareAudio(song) {
  if (!song || mode !== 'display') return false;
  const key = \`${'${song.id}:${song.audioFile}'}\`;
  if (currentAudioKey === key && currentAudioPromise) return currentAudioPromise;
  const generation = ++audioLoadGeneration;
  currentAudioKey = key;
  const promise = (async () => {
    let fallback = false;
    audio.src = song.audioFile; audio.load();
    let ok = await waitForAudioReady(6000);
    if (generation !== audioLoadGeneration || currentAudioKey !== key) return false;
    if (!ok) {
      fallback = true;
      audio.src = createDemoTone(song.duration);
      audio.load();
      ok = await waitForAudioReady(1200);
      if (generation !== audioLoadGeneration || currentAudioKey !== key) return false;
    }
    usingDemoAudio = fallback;
    document.body.dataset.demoAudio = fallback ? 'true' : 'false';
    await emit('display:audioStatus', { songId:song.id, fallback });
    return ok;
  })();
  currentAudioPromise = promise;
  return promise;
}
function syncAudioForState() {
  if (mode !== 'display' || !state?.song) return;
  const songId = state.song.id;
  prepareAudio(state.song).then((ready) => {
    if (!ready || state?.song?.id !== songId) return;
    if (state.phase !== 'PLAYING' && Math.abs(audio.currentTime - Number(state.listenedSeconds || 0)) > .35) {
      try { audio.currentTime = Math.min(Number(state.listenedSeconds || 0), state.song.duration || 999); } catch {}
    }
  });
}
async function handleAudioPlay({ startAt, seq }) {
  if (mode !== 'display' || !state?.song) return;
  const song = state.song;
  const songId = song.id;
  const commandGeneration = ++playbackCommandGeneration;
  activePlaybackSeq = Number(seq) || 0;
  const ready = await prepareAudio(song);
  if (!ready || commandGeneration !== playbackCommandGeneration || state?.song?.id !== songId) {
    if (activePlaybackSeq === Number(seq)) activePlaybackSeq = 0;
    return;
  }
  try {
    audio.currentTime = Math.min(Number(startAt) || 0, song.duration || 999);
    await audio.play();
    if (commandGeneration !== playbackCommandGeneration || state?.song?.id !== songId) {
      audio.pause();
      if (activePlaybackSeq === Number(seq)) activePlaybackSeq = 0;
      return;
    }
    clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      const configuredEnd = Number(state?.song?.duration || 0);
      if (configuredEnd > 0 && audio.currentTime >= configuredEnd - .03) {
        audio.pause();
        clearInterval(progressTimer); progressTimer = null;
        const endedSeq = activePlaybackSeq;
        activePlaybackSeq = 0;
        if (endedSeq) emit('display:audioEnded', { position:configuredEnd, seq:endedSeq });
        return;
      }
      if (commandGeneration !== playbackCommandGeneration || state?.song?.id !== songId) {
        audio.pause(); clearInterval(progressTimer); progressTimer = null; return;
      }
      emit('display:audioProgress', { position:audio.currentTime, paused:audio.paused, seq:activePlaybackSeq });
    }, 250);
  } catch (error) {
    if (commandGeneration !== playbackCommandGeneration) return;
    console.error(error);
    activePlaybackSeq = 0;
    await emit('display:playbackFailed', { seq:Number(seq) || 0 });
    alert('Playback was blocked. Enable speakers again on the game screen.');
  }
}
function handleAudioPause({ seq } = {}) {
  if (mode !== 'display') return;
  playbackCommandGeneration += 1;
  audio.pause();
  clearInterval(progressTimer); progressTimer = null;
  const currentSeq = Number(seq) || activePlaybackSeq;
  activePlaybackSeq = 0;
  if (currentSeq) emit('display:audioProgress', { position:audio.currentTime, paused:true, seq:currentSeq });
}
audio.addEventListener('ended', () => {
  clearInterval(progressTimer); progressTimer = null;
  const endedSeq = activePlaybackSeq;
  activePlaybackSeq = 0;
  if (mode === 'display' && endedSeq) emit('display:audioEnded', { position:audio.currentTime, seq:endedSeq });
});`;

  s = s.slice(0, start) + audioBlock + s.slice(end);
  fs.writeFileSync(path, s);
}

// public/interaction-ui.js — bound supplemental actions and expose final score recovery tools.
{
  const path = 'public/interaction-ui.js';
  let s = fs.readFileSync(path, 'utf8');

  s = replaceOnce(
    s,
`async function sendAction(session, action, extra = {}) {
  if (!session) return { ok:false, error:'NO_SESSION' };
  try {
    const response = await fetch('/api/action', {
      method: 'POST',
      headers: { 'content-type':'application/json' },
      body: JSON.stringify({ action, roomCode:session.roomCode, token:session.token, ...(session.team ? { team:session.team } : {}), ...extra })
    });
    const result = await response.json().catch(() => ({ ok:false, error:'BAD_RESPONSE' }));
    return { ...result, ok:Boolean(response.ok && result?.ok) };
  } catch {
    return { ok:false, error:'NETWORK_ERROR' };
  }
}
`,
`async function sendAction(session, action, extra = {}) {
  if (!session) return { ok:false, error:'NO_SESSION' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch('/api/action', {
      method: 'POST',
      headers: { 'content-type':'application/json' },
      body: JSON.stringify({ action, roomCode:session.roomCode, token:session.token, ...(session.team ? { team:session.team } : {}), ...extra }),
      signal: controller.signal
    });
    const result = await response.json().catch(() => ({ ok:false, error:'BAD_RESPONSE' }));
    return { ...result, ok:Boolean(response.ok && result?.ok) };
  } catch {
    return { ok:false, error:'NETWORK_ERROR' };
  } finally {
    clearTimeout(timeout);
  }
}
`,
    'supplemental action timeout'
  );

  s = replaceOnce(
    s,
`async function sendHostAction(action, button) {
  const session = hostSession();
  if (!session || button?.disabled) return { ok:false, error:'NO_SESSION' };
  if (button) button.disabled = true;
  const result = await sendAction(session, action);
  if (!result.ok && button?.isConnected) button.disabled = false;
  return result;
}
`,
`async function sendHostAction(action, button, extra = {}) {
  const session = hostSession();
  if (!session || button?.disabled) return { ok:false, error:'NO_SESSION' };
  if (button) button.disabled = true;
  const result = await sendAction(session, action, extra);
  if (!result.ok && button?.isConnected) button.disabled = false;
  return result;
}
`,
    'host action payloads'
  );

  const marker = 'function syncCaptainControls() {\n';
  if (!s.includes(marker)) throw new Error('final tools insertion marker not found');
  const finalTools = `function makeFinalHostTools() {
  const section = document.createElement('section');
  section.id = 'final-host-tools';
  section.className = 'controller-card final-host-tools';
  section.innerHTML = \`<div class="micro-label">FINAL SCORE TOOLS</div><div class="controller-actions"><button class="secondary-control" id="final-undo">UNDO LAST</button></div><details class="score-tools" open><summary>SCORE CORRECTION</summary><div class="score-adjust"><button data-final-score="A" data-delta="-1">A −1</button><button data-final-score="A" data-delta="1">A +1</button><button data-final-score="B" data-delta="-1">B −1</button><button data-final-score="B" data-delta="1">B +1</button></div></details>\`;
  section.querySelector('#final-undo')?.addEventListener('click', (event) => sendHostAction('host:undo', event.currentTarget));
  section.querySelectorAll('[data-final-score]').forEach((button) => button.addEventListener('click', () => sendHostAction('host:adjustScore', button, { team:button.dataset.finalScore, delta:Number(button.dataset.delta) })));
  return section;
}

`;
  s = s.replace(marker, finalTools + marker);

  s = replaceOnce(
    s,
`function syncHostControls() {
  if (!isHostRoute) return;
  const phase = document.body.dataset.phase || '';
  const activeGame = phase && !['NONE','LOBBY','FINISHED'].includes(phase);
  const existing = document.querySelector('#end-game');
  const shell = document.querySelector('.controller-shell');
  if (activeGame && shell && !existing) shell.appendChild(makeEndGameButton());
  if (!activeGame && existing) existing.remove();
}
`,
`function syncHostControls() {
  if (!isHostRoute) return;
  const phase = document.body.dataset.phase || '';
  const activeGame = phase && !['NONE','LOBBY','FINISHED'].includes(phase);
  const existing = document.querySelector('#end-game');
  const finalTools = document.querySelector('#final-host-tools');
  const shell = document.querySelector('.controller-shell');
  if (activeGame && shell && !existing) shell.appendChild(makeEndGameButton());
  if (!activeGame && existing) existing.remove();
  if (phase === 'FINISHED' && shell && !finalTools) shell.appendChild(makeFinalHostTools());
  if (phase !== 'FINISHED' && finalTools) finalTools.remove();
}
`,
    'final host controls'
  );

  fs.writeFileSync(path, s);
}

// README — align docs with the current 44-song implementation and browser architecture.
{
  const path = 'README.md';
  let s = fs.readFileSync(path, 'utf8');
  s = s.replace('Game lengths: Quick Hit (15 songs), Main Event (21), Full Battle (40).', 'Game lengths: Quick Hit (15 songs), Main Event (21), Full Battle (44).');
  s = s.replace('The host can reset a stuck captain slot while the game is still in the lobby.', 'The host can reset a stuck captain slot during the lobby or an active game; an active playback is paused before that slot is released.');
  s = s.replace('- the 40-song bank and 12/14/14 difficulty split.', '- the 44-song bank and 14/18/12 difficulty split.');
  s = s.replace('LOBBY\n  → ROUND_INTRO\n  → READY ↔ PLAYING ↔ PAUSED', 'LOBBY\n  → READY ↔ PLAYING ↔ PAUSED');
  s = s.replace('Copyrighted music is **not committed to this repository**. Put pre-cut snippets in `public/audio/` using the filenames defined in `data/songs.js`.', 'The game expects pre-cut snippets in `public/audio/` using the filenames defined in `data/songs.js`; reveal clips live in `public/audio/reveal/` with matching filenames.');
  s = s.replace('- `public/game.js` — the single main browser controller for audience, host, and captain modes.\n', '- `public/game.js` — the main browser controller for audience, host, and captain modes.\n- `public/reveal-audio.js` — reveal-clip playback and auto-advance.\n- `public/interaction-ui.js` — supplemental captain/host recovery controls.\n');
  s = s.replace('There is no separate replay patch layer or second game server.', 'There is one authoritative game server; the supplemental browser scripts do not own game state.');
  fs.writeFileSync(path, s);
}

// Static regression audit for second-pass client hardening.
fs.writeFileSync('test/second-pass-audit.test.js', `import assert from 'node:assert/strict';
import fs from 'node:fs';

const game = fs.readFileSync('public/game.js', 'utf8');
const interaction = fs.readFileSync('public/interaction-ui.js', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');

assert.match(game, /let audioLoadGeneration = 0;/, 'audio loads need a generation guard');
assert.match(game, /let playbackCommandGeneration = 0;/, 'play commands need a cancellation generation');
assert.match(game, /generation !== audioLoadGeneration \\|\\| currentAudioKey !== key/, 'stale song loads must not replace the current source');
assert.match(game, /commandGeneration !== playbackCommandGeneration \\|\\| state\\?\\.song\\?\\.id !== songId/, 'STOP/REVEAL must cancel a pending PLAY');
assert.match(game, /playbackCommandGeneration \\+= 1;\\n  audio\\.pause\\(\\);/, 'audio pause must invalidate pending play commands');
assert.match(game, /new AbortController\\(\\)/, 'main API requests need a finite timeout');
assert.match(interaction, /id = 'final-host-tools'/, 'host needs recovery controls after the final reveal');
assert.match(interaction, /host:adjustScore/, 'final score must remain correctable');
assert.match(interaction, /host:undo/, 'final state must expose undo');
assert.match(readme, /Full Battle \\(44\\)/, 'docs must match the 44-song full game');
assert.doesNotMatch(readme, /Full Battle \\(40/, 'stale 40-song documentation must not return');

console.log('Second-pass client audit passed');
`);

// Include the new regression audit in CI.
{
  const path = 'package.json';
  const pkg = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!pkg.scripts.check.includes('second-pass-audit.test.js')) pkg.scripts.check += ' && node --check test/second-pass-audit.test.js';
  if (!pkg.scripts.test.includes('second-pass-audit.test.js')) pkg.scripts.test += ' && node test/second-pass-audit.test.js';
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
}

console.log('Second-pass patch applied');
