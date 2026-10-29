const app = document.querySelector('#app');
const audio = document.querySelector('#game-audio');

const pathParts = location.pathname.split('/').filter(Boolean);
const mode = pathParts[0] === 'host' ? 'display' : pathParts[0] === 'control' ? 'host' : pathParts[0] === 'join' ? 'captain' : 'home';
const roomFromPath = pathParts[1]?.toUpperCase() || '';

let state = null;
let roomCode = '';
let displayToken = '';
let hostToken = '';
let hostPin = '';
let captainToken = '';
let team = null;
let audioUnlocked = false;
let progressTimer = null;
let demoUrl = null;
let currentAudioKey = '';
let currentAudioPromise = null;
let countdownTimer = null;
let eventSource = null;
let selectedGameLength = 'normal';
let activePlaybackSeq = 0;
let usingDemoAudio = false;
let restoreRetryTimer = null;
let restoreInFlight = false;
let restoreAttempt = 0;
let audioLoadGeneration = 0;
let playbackCommandGeneration = 0;

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
}
function cleanRoomCode(value = '') {
  return String(value).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}
function difficultyClass(value) {
  return ['easy','medium','hard'].includes(value) ? value : 'easy';
}
function pointsStars(points = 0) {
  const p = Math.max(0, Math.min(10, Number(points) || 0));
  return `<div class="points" aria-label="${p} points">${Array.from({ length: 10 }, (_, i) => `<span class="${i < p ? 'on' : ''}">★</span>`).join('')}</div>`;
}
function brand(subtitle = 'Two teams. One snippet. Name that tune.', compact = false) {
  return `<header class="brand ${compact ? 'compact' : ''}">
    <div class="brand-copy">
      <div class="brand-kicker">LIVE MUSIC GAME</div>
      <h1>NAME THAT TUNE</h1>
      ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
    </div>
    <div class="live-chip">● LIVE</div>
  </header>`;
}
function scoreCards(s) {
  const active = s?.activeTeam || '';
  return `<div class="scoreboard">
    <div class="team-panel team-a ${active === 'A' ? 'active' : ''}">
      <div class="team-tag">TEAM A</div><div class="team-name">${esc(s.teamNames.A)}</div><div class="score">${s.scores.A}</div>
    </div>
    <div class="versus">VS</div>
    <div class="team-panel team-b ${active === 'B' ? 'active' : ''}">
      <div class="team-tag">TEAM B</div><div class="team-name">${esc(s.teamNames.B)}</div><div class="score">${s.scores.B}</div>
    </div>
  </div>`;
}
function api(path, payload = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  return fetch(path, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(payload), signal:controller.signal })
    .then(async (res) => res.json().catch(() => ({ ok:false, error:'BAD_RESPONSE' })))
    .catch(() => ({ ok:false, error:'NETWORK_ERROR' }))
    .finally(() => clearTimeout(timeout));
}
function emit(action, payload = {}) {
  const token = mode === 'display' ? displayToken : mode === 'host' ? hostToken : captainToken;
  return api('/api/action', { action, roomCode, token, team, ...payload });
}
function sameConnections(a, b) {
  return JSON.stringify(a?.connected || {}) === JSON.stringify(b?.connected || {});
}
function canPatchLive(previous, next) {
  if (!previous || !next) return false;
  return previous.phase === 'PLAYING' && next.phase === 'PLAYING' && previous.currentIndex === next.currentIndex &&
    previous.activeTeam === next.activeTeam && previous.audioReady === next.audioReady && sameConnections(previous, next) &&
    previous.scores.A === next.scores.A && previous.scores.B === next.scores.B && previous.audioFallback === next.audioFallback;
}
function connectEvents() {
  const token = mode === 'display' ? displayToken : mode === 'host' ? hostToken : captainToken;
  if (!roomCode || !token || mode === 'home') return;
  eventSource?.close();
  const params = new URLSearchParams({ room:roomCode, role:mode, token });
  if (mode === 'captain') params.set('team', team);
  eventSource = new EventSource(`/events?${params}`);
  eventSource.onopen = () => {
    document.body.dataset.connection = 'online';
    if (mode === 'display' && audioUnlocked) emit('display:audioReady', { ready:true });
  };
  eventSource.onerror = () => { document.body.dataset.connection = 'offline'; };
  eventSource.addEventListener('state', (event) => {
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
  if (mode === 'display') {
    eventSource.addEventListener('audio-play', (event) => handleAudioPlay(JSON.parse(event.data)));
    eventSource.addEventListener('audio-pause', (event) => handleAudioPause(JSON.parse(event.data || '{}')));
  }
}
function saveDisplay() { localStorage.setItem('ntt-display', JSON.stringify({ roomCode, displayToken, hostPin })); }
function saveHost() { localStorage.setItem(`ntt-host-${roomCode}`, JSON.stringify({ roomCode, hostToken })); }
function saveCaptain() { localStorage.setItem(`ntt-captain-${roomCode}-${team}`, JSON.stringify({ roomCode, team, captainToken })); localStorage.setItem(`ntt-captain-active-${roomCode}`, team); }
function clearDisplaySession() {
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

function renderHome() {
  app.innerHTML = `<main class="shell home-shell">
    ${brand('Two teams. One snippet. How fast can you name it?')}
    <section class="home-stage">
      <div class="home-eq" aria-hidden="true">${Array.from({ length:28 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>
      <div class="home-title">READY TO PLAY?</div>
      <div class="home-actions">
        <a class="home-action start-action" href="/host">
          <span class="action-icon">▶</span><span class="action-label">START A GAME</span><small>Create the room on the device connected to the speakers</small>
        </a>
        <form class="home-action join-action" id="join-room-form">
          <span class="action-icon">↗</span><span class="action-label">JOIN A ROOM</span>
          <div class="join-code-row"><input id="home-room-code" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="ROOM CODE" aria-label="Room code"><button type="submit">JOIN</button></div>
          <small>Captain? Enter the 4-character room code</small>
          <div class="inline-error" id="home-join-error"></div>
        </form>
      </div>
    </section>
  </main>`;
  const input = document.querySelector('#home-room-code');
  input?.addEventListener('input', () => { input.value = cleanRoomCode(input.value); });
  document.querySelector('#join-room-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = cleanRoomCode(input?.value);
    if (code.length !== 4) {
      document.querySelector('#home-join-error').textContent = 'Enter the 4-character room code.';
      input?.focus();
      return;
    }
    location.href = `/join/${code}`;
  });
}

const GAME_MODES = [
  { value:'short', icon:'⚡', title:'QUICK HIT', songs:'15', note:'Fast & loud' },
  { value:'normal', icon:'♪', title:'MAIN EVENT', songs:'21', note:'Party pick', featured:true },
  { value:'full', icon:'♛', title:'FULL BATTLE', songs:'44', note:'No mercy' }
];
function gameModeCards() {
  return `<div class="mode-picker" role="radiogroup" aria-label="Game length">${GAME_MODES.map((item) => `<button type="button" class="mode-card ${item.featured ? 'featured' : ''} ${selectedGameLength === item.value ? 'selected' : ''}" data-mode-value="${item.value}" role="radio" aria-checked="${selectedGameLength === item.value}">
    ${item.featured ? '<span class="mode-pick">PARTY PICK</span>' : ''}<span class="mode-icon">${item.icon}</span><b>${item.title}</b><strong>${item.songs}</strong><em>SONGS</em><small>${item.note}</small>
  </button>`).join('')}</div>`;
}
function renderDisplaySetup() {
  app.innerHTML = `<main class="shell setup-shell">
    ${brand('MAIN SCREEN · CONNECT TO SPEAKERS')}
    <section class="setup-panel">
      <div class="setup-ribbon">⚡ PICK YOUR BATTLE ★</div>
      <div class="team-inputs">
        <label class="team-input team-a-input"><span>TEAM A</span><input id="team-a" maxlength="24" value="Team A"><i>⚡</i></label>
        <div class="setup-vs">VS</div>
        <label class="team-input team-b-input"><span>TEAM B</span><input id="team-b" maxlength="24" value="Team B"><i>★</i></label>
      </div>
      <div class="mode-heading"><span>02</span><b>GAME LENGTH</b></div>
      ${gameModeCards()}
      <button class="create-room-btn" id="create-game">▶ CREATE ROOM</button>
    </section>
  </main>`;
  document.querySelectorAll('[data-mode-value]').forEach((button) => button.addEventListener('click', () => {
    selectedGameLength = button.dataset.modeValue;
    document.querySelectorAll('[data-mode-value]').forEach((card) => {
      const selected = card.dataset.modeValue === selectedGameLength;
      card.classList.toggle('selected', selected);
      card.setAttribute('aria-checked', String(selected));
    });
  }));
  document.querySelector('#create-game')?.addEventListener('click', async () => {
    const createButton = document.querySelector('#create-game');
    createButton.disabled = true;
    const result = await api('/api/display/create', {
      gameLength:selectedGameLength,
      teamNames:{ A:document.querySelector('#team-a').value.trim(), B:document.querySelector('#team-b').value.trim() }
    });
    createButton.disabled = false;
    if (!result?.ok) return alert('Could not create game.');
    roomCode = result.roomCode; displayToken = result.displayToken; hostPin = result.hostPin; state = result.state;
    saveDisplay(); connectEvents(); history.replaceState({}, '', `/host?room=${roomCode}`); render();
  });
}
function captainJoinUrl() { return `${location.origin}/join/${roomCode}`; }
function hostControlUrl() { return `${location.origin}/control/${roomCode}`; }
function makeQrDataUrl(text) {
  if (typeof window.qrcode !== 'function') return null;
  const qr = window.qrcode(0, 'M');
  qr.addData(text); qr.make();
  return qr.createDataURL(6, 4);
}
function enhanceQr(panelSelector, type, url) {
  const node = document.querySelector(panelSelector);
  if (!node) return;
  const dataUrl = makeQrDataUrl(url);
  if (!dataUrl) return;
  node.innerHTML = `<div class="qr-stack qr-${type}"><div class="qr-frame"><img src="${dataUrl}" alt="${type === 'host' ? 'QR code for host controller' : 'QR code to join as captain'}"></div><div class="qr-label">${type === 'host' ? 'SCAN FOR HOST CONTROL' : 'SCAN TO JOIN'}</div><div class="qr-fallback">${type === 'host' ? 'PIN required after scanning' : 'or enter the room code above'}</div></div>`;
}
function enhanceLobbyQr() {
  enhanceQr('.captain-join .join-url', 'captain', captainJoinUrl());
  enhanceQr('.host-join .join-url', 'host', hostControlUrl());
}
function displayLobby(s) {
  return `<main class="shell game-shell lobby-screen">
    ${brand('SCAN OR ENTER THE ROOM CODE', true)}
    <section class="lobby-code-block"><div class="micro-label">ROOM CODE</div><div class="room-code">${esc(roomCode)}</div><div class="lobby-hint">Captains can also enter this code from the home screen</div></section>
    <div class="lobby-grid">
      <section class="join-panel captain-join"><div class="join-icon">⚡</div><div class="micro-label">CAPTAINS</div><div class="join-url">${esc(captainJoinUrl())}</div><div class="status-row"><span class="status-dot ${s.connected.A ? 'on' : ''}"></span>${esc(s.teamNames.A)}</div><div class="status-row"><span class="status-dot ${s.connected.B ? 'on' : ''}"></span>${esc(s.teamNames.B)}</div></section>
      <section class="join-panel host-join"><div class="join-icon">🎛</div><div class="micro-label">HOST PHONE</div><div class="join-url">${esc(hostControlUrl())}</div><div class="pin-label">HOST PIN</div><div class="host-pin">${esc(hostPin || '••••')}</div><div class="status-row"><span class="status-dot ${s.connected.host ? 'on' : ''}"></span>${s.connected.host ? 'Host connected' : 'Waiting for host'}</div></section>
    </div>
    <section class="audio-gate ${audioUnlocked ? 'ready' : ''}"><button class="audio-btn" id="enable-audio">${audioUnlocked ? '✓ SPEAKERS READY' : '🔊 ENABLE SPEAKERS'}</button><div>The game cannot start until audio is enabled on this screen.</div></section>
  </main>`;
}
function playbackStatusText(s) {
  if (s.phase === 'PLAYING') return '▶ PLAYING';
  if (s.phase === 'ANSWER_LOCKED') return '🔒 ANSWER LOCKED';
  if (s.phase.startsWith('STEAL')) return '⚡ STEAL';
  if (s.phase === 'PAUSED' && s.playbacksCompleted >= 2) return 'AUDIO USED · LOCK ANSWER';
  if (s.phase === 'PAUSED' && s.awaitingReplay) return '↻ ONE REPLAY LEFT';
  if (s.phase === 'PAUSED') return 'PAUSED';
  return 'READY';
}
function exposureProgress(s) {
  const maxExposure = Number(s.duration || 0) * 2;
  return maxExposure ? Math.min(100, (Number(s.totalHeardSeconds || 0) / maxExposure) * 100) : 0;
}
function heardText(s) {
  return `${Number(s.totalHeardSeconds || 0).toFixed(1)}s total · ${Math.min(2, Number(s.playbacksCompleted || 0))}/2 full plays used`;
}
function displayGame(s) {
  const reveal = s.phase === 'REVEAL';
  const stageLabel = s.phase === 'ROUND_INTRO' ? `${s.roundLabel} ROUND` : s.phase === 'FINISHED' ? 'FINAL SCORE' : `${s.roundLabel} · SONG ${s.songNumber}/${s.totalSongs}`;
  return `<main class="shell game-shell audience-screen">
    <header class="game-top"><div class="round-badge ${difficultyClass(s.round)}">${esc(stageLabel)}</div><div class="room-mini">ROOM ${esc(roomCode)}</div></header>
    ${scoreCards(s)}
    ${s.audioFallback ? '<div class="audio-warning">⚠ DEMO AUDIO — CURRENT SNIPPET FILE IS MISSING</div>' : ''}
    ${s.phase === 'ROUND_INTRO' ? `<section class="round-splash ${difficultyClass(s.round)}"><div class="round-number">${s.round === 'easy' ? '01' : s.round === 'medium' ? '02' : '03'}</div><div class="round-word">${esc(s.roundLabel)}</div><p>HOST — START THE ROUND</p></section>` : ''}
    ${!['ROUND_INTRO','FINISHED'].includes(s.phase) ? `<section class="play-stage ${reveal ? 'revealing' : ''}">${reveal ? `<div class="answer-reveal"><div class="micro-label">THE TUNE WAS</div><h2>${esc(s.song?.title || '')}</h2><p>${esc(s.song?.artist || '')}</p></div>` : `
      <div class="turn-banner">${esc(s.teamNames[s.activeTeam])}<span>${s.phase.startsWith('STEAL') ? 'STEAL' : 'YOUR TURN'}</span></div>
      <div class="vinyl" aria-hidden="true"><div class="vinyl-core">♪</div></div>
      <div class="value-block"><div class="micro-label">CURRENT VALUE</div><div class="point-number live-points-number">${s.phase.startsWith('STEAL') ? 1 : s.currentPoints}</div><div class="point-label">POINT${(s.phase.startsWith('STEAL') ? 1 : s.currentPoints) === 1 ? '' : 'S'}</div>${pointsStars(s.phase.startsWith('STEAL') ? 1 : s.currentPoints)}</div>
      <div class="wave-line" aria-hidden="true">${Array.from({ length:28 }, (_, i) => `<i style="--i:${i}"></i>`).join('')}</div>
      <div class="progress-wrap"><div class="meter"><div style="width:${exposureProgress(s)}%"></div></div><div class="heard">${heardText(s)}</div></div>
      <div class="phase-call">${playbackStatusText(s)}</div>`}</section>` : ''}
    ${s.phase === 'FINISHED' ? `${finalScreen(s)}<button class="primary-control new-room-control" id="new-room">NEW ROOM</button>` : ''}
    ${s.phase !== 'FINISHED' && (!audioUnlocked || !s.audioReady) ? `<section class="display-audio-recovery"><button class="audio-btn" id="enable-audio">🔊 RE-ENABLE SPEAKERS</button><span>Audio permission is required after a screen refresh.</span></section>` : ''}
  </main>`;
}
function bindDisplayControls() {
  document.querySelector('#enable-audio')?.addEventListener('click', async () => {
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
  document.querySelector('#new-room')?.addEventListener('click', clearDisplaySession);
}
function renderDisplay() {
  if (!roomCode || !displayToken || !state) return renderDisplaySetup();
  app.innerHTML = state.phase === 'LOBBY' ? displayLobby(state) : displayGame(state);
  if (state.phase === 'LOBBY') enhanceLobbyQr();
  bindDisplayControls();
  syncAudioForState();
}

function renderHostJoin() {
  const room = roomFromPath;
  app.innerHTML = `<main class="shell phone-shell">${brand(`HOST CONTROL · ROOM ${room || '—'}`, true)}<section class="controller-card center-stack"><div class="controller-icon">🎛</div><h2>HOST CONTROL</h2><p>Enter the PIN shown on the main screen.</p><input class="pin-input" id="host-pin-input" inputmode="numeric" maxlength="4" placeholder="0000"><button class="primary-control" id="host-join">CONNECT</button><div class="inline-error" id="host-error"></div></section></main>`;
  document.querySelector('#host-join')?.addEventListener('click', joinHostController);
}
async function joinHostController() {
  roomCode = roomFromPath;
  const pin = document.querySelector('#host-pin-input')?.value.trim();
  const saved = readStoredJson(`ntt-host-${roomCode}`);
  const result = await api('/api/host/join', { roomCode, hostPin:pin, hostToken:saved?.hostToken || null });
  if (!result?.ok) {
    document.querySelector('#host-error').textContent = result?.error === 'BAD_PIN' ? 'Wrong PIN.' : result?.error === 'ROOM_NOT_FOUND' ? 'Room not found.' : 'Could not connect.';
    return;
  }
  hostToken = result.hostToken; state = result.state; saveHost(); connectEvents(); render();
}
function hostConnectionStrip(s) {
  return `<div class="connection-strip"><span class="${s.connected.display ? 'ok' : ''}">SCREEN</span><span class="${s.audioReady ? 'ok' : ''}">AUDIO</span><span class="${s.connected.A ? 'ok' : ''}">A</span><span class="${s.connected.B ? 'ok' : ''}">B</span></div>`;
}
function renderHostController() {
  if (!roomCode || !hostToken || !state) return renderHostJoin();
  const s = state;
  const canJudge = ['ANSWER_LOCKED','STEAL_LOCKED'].includes(s.phase);
  const revealState = s.phase === 'REVEAL';
  app.innerHTML = `<main class="shell phone-shell controller-shell">
    <header class="phone-header"><div><div class="micro-label">HOST · ${esc(roomCode)}</div><h1>NAME THAT TUNE</h1></div><div class="mini-score">${s.scores.A}–${s.scores.B}</div></header>
    ${hostConnectionStrip(s)}
    ${s.audioFallback ? '<div class="audio-warning">⚠ CURRENT SONG IS USING DEMO AUDIO — SKIP OR FIX THE FILE</div>' : ''}
    ${s.phase === 'LOBBY' ? `<section class="controller-card center-stack"><div class="controller-icon">🎚</div><h2>ROOM READY?</h2><p>Both captains, the main screen and audio must be connected.</p><button class="primary-control" id="host-start" ${s.readyToStart ? '' : 'disabled'}>START GAME</button><details class="score-tools captain-tools"><summary>CAPTAIN SLOTS</summary><div class="score-adjust"><button data-release="A" ${s.captainClaimed?.A ? '' : 'disabled'}>RESET A</button><button data-release="B" ${s.captainClaimed?.B ? '' : 'disabled'}>RESET B</button></div></details></section>` : ''}
    ${s.phase === 'ROUND_INTRO' ? `<section class="controller-card round-control ${difficultyClass(s.round)} center-stack"><div class="micro-label">NEXT ROUND</div><div class="controller-round">${esc(s.roundLabel)}</div><button class="primary-control" id="begin-round">START ROUND</button></section>` : ''}
    ${!['LOBBY','ROUND_INTRO','FINISHED'].includes(s.phase) ? `<section class="controller-card host-game-card">
      <div class="controller-meta"><span class="round-badge ${difficultyClass(s.round)}">${esc(s.roundLabel)}</span><strong>${s.songNumber}/${s.totalSongs}</strong></div>
      <div class="host-answer"><div class="micro-label">SECRET ANSWER</div><h2>${esc(s.song?.title || '—')}</h2><p>${esc(s.song?.artist || '')}</p></div>
      <div class="judge-status"><strong>${esc(s.teamNames[s.activeTeam])}</strong><span>${s.phase.startsWith('STEAL') ? 'STEAL' : s.phase.replaceAll('_',' ')}</span></div>
      <div class="judge-value"><span>${s.phase.startsWith('STEAL') ? 1 : s.currentPoints}</span> pts · ${heardText(s)}</div>
      ${canJudge ? `<div class="judge-buttons"><button class="judge-btn correct" id="correct">✓<span>CORRECT</span></button><button class="judge-btn wrong" id="wrong">✕<span>WRONG</span></button></div>` : `<div class="waiting-judge">${s.phase === 'PLAYING' ? 'Listening…' : s.phase === 'PAUSED' ? 'Captain is deciding…' : s.phase === 'STEAL' ? 'Steal team has 10 seconds to lock an answer…' : revealState ? 'Answer revealed' : 'Waiting for captain…'}</div>`}
      <div class="controller-actions"><button class="secondary-control warn" id="reveal" ${revealState ? 'disabled' : ''}>REVEAL</button><button class="secondary-control next" id="next" ${revealState ? '' : 'disabled'}>NEXT →</button><button class="secondary-control" id="undo" ${s.undoAvailable ? '' : 'disabled'}>UNDO</button></div>
      <details class="score-tools"><summary>SCORE CORRECTION</summary><div class="score-adjust"><button data-score="A" data-delta="-1">A −1</button><button data-score="A" data-delta="1">A +1</button><button data-score="B" data-delta="-1">B −1</button><button data-score="B" data-delta="1">B +1</button></div></details>
      <details class="score-tools captain-tools"><summary>CAPTAIN RECONNECT</summary><div class="score-adjust"><button data-release="A">RESET A</button><button data-release="B">RESET B</button></div></details>
    </section>` : ''}
    ${s.phase === 'FINISHED' ? `${finalScreen(s)}<button class="primary-control" id="play-again">↻ PLAY AGAIN</button>` : ''}
  </main>`;
  document.querySelector('#host-start')?.addEventListener('click', () => emit('host:start'));
  document.querySelector('#begin-round')?.addEventListener('click', () => emit('host:beginRound'));
  document.querySelector('#correct')?.addEventListener('click', () => emit('host:markCorrect'));
  document.querySelector('#wrong')?.addEventListener('click', () => emit('host:markWrong'));
  document.querySelector('#reveal')?.addEventListener('click', () => emit('host:reveal'));
  document.querySelector('#next')?.addEventListener('click', () => emit('host:next'));
  document.querySelector('#undo')?.addEventListener('click', () => emit('host:undo'));
  document.querySelector('#play-again')?.addEventListener('click', () => emit('host:restart'));
  document.querySelectorAll('[data-score]').forEach((button) => button.addEventListener('click', () => emit('host:adjustScore', { team:button.dataset.score, delta:Number(button.dataset.delta) })));
  document.querySelectorAll('[data-release]').forEach((button) => button.addEventListener('click', () => emit('host:releaseCaptain', { team:button.dataset.release })));
}

function renderCaptainJoin() {
  app.innerHTML = `<main class="shell phone-shell">${brand(`JOIN ROOM ${roomFromPath || '—'}`, true)}<section class="controller-card center-stack"><div class="controller-icon">⚡</div><h2>CHOOSE YOUR TEAM</h2><button class="team-choice team-a-choice" id="join-a">TEAM A</button><button class="team-choice team-b-choice" id="join-b">TEAM B</button><div class="inline-error" id="join-error"></div><a class="back-home" href="/">← Different room</a></section></main>`;
  for (const t of ['A','B']) document.querySelector(`#join-${t.toLowerCase()}`)?.addEventListener('click', () => joinCaptain(t));
}
async function joinCaptain(selectedTeam) {
  roomCode = roomFromPath; team = selectedTeam;
  const saved = readStoredJson(`ntt-captain-${roomCode}-${team}`);
  const result = await api('/api/captain/join', { roomCode, team, captainToken:saved?.captainToken || null });
  if (!result?.ok) {
    document.querySelector('#join-error').textContent = result?.error === 'TEAM_TAKEN' ? 'That captain slot is already taken. Ask the host to reset it.' : result?.error === 'ROOM_NOT_FOUND' ? 'Room not found. Check the code.' : 'Could not join.';
    return;
  }
  captainToken = result.captainToken; state = result.state; saveCaptain(); connectEvents(); render();
}
function captainPlayLabel(s, canPause) {
  if (canPause) return '■ STOP';
  if (!s.canPlay || s.playbacksCompleted >= 2) return 'AUDIO USED · LOCK ANSWER';
  if (s.awaitingReplay) return '↻ REPLAY · LAST PLAY';
  return Number(s.listenedSeconds || 0) > 0 ? '▶ HEAR MORE' : '▶ PLAY';
}
function renderCaptain() {
  if (!state || !team) return renderCaptainJoin();
  const s = state;
  const myTurn = s.activeTeam === team;
  const phase = s.phase;
  const canPause = myTurn && phase === 'PLAYING';
  const canLock = myTurn && ['READY','PAUSED'].includes(phase) && Number(s.totalHeardSeconds || 0) >= 0.05;
  const isSteal = myTurn && ['STEAL','STEAL_LOCKED'].includes(phase);
  const playDisabled = !canPause && (!myTurn || !['READY','PAUSED'].includes(phase) || !s.canPlay || !s.audioReady || !s.connected.display);
  app.innerHTML = `<main class="shell phone-shell captain-shell">
    <header class="phone-header captain-header"><div><div class="micro-label">YOU ARE</div><h1>${esc(s.teamNames[team])}</h1></div><div class="captain-score">${s.scores[team]}</div></header>
    <div class="opponent-line">${esc(s.teamNames[team === 'A' ? 'B' : 'A'])} · ${s.scores[team === 'A' ? 'B' : 'A']} pts</div>
    ${phase === 'FINISHED' ? finalScreen(s) : `<section class="captain-stage ${myTurn ? 'your-turn' : 'waiting'}">
      <div class="round-badge ${difficultyClass(s.round)}">${esc(s.roundLabel)} · ${Math.max(0, s.songNumber)}/${s.totalSongs}</div>
      ${myTurn && !['LOBBY','ROUND_INTRO','REVEAL'].includes(phase) ? `${isSteal ? `<div class="steal-flash">STEAL!</div><div class="point-number small">1</div><div class="point-label">POINT</div><div class="countdown" id="steal-countdown">10.0</div><p>No more audio. Decide now.</p><button class="lock-btn" id="lock-steal" ${phase === 'STEAL_LOCKED' ? 'disabled' : ''}>${phase === 'STEAL_LOCKED' ? 'LOCKED' : '🔒 LOCK ANSWER'}</button>` : `
        <div class="your-turn-label">YOUR TURN</div>${pointsStars(s.currentPoints)}<div class="point-number small live-points-number">${s.currentPoints}</div><div class="point-label">POINTS LEFT</div>
        <div class="meter"><div style="width:${exposureProgress(s)}%"></div></div><div class="heard">${heardText(s)}</div>
        <button class="play-or-stop ${canPause ? 'stop' : ''}" id="play-pause" ${playDisabled ? 'disabled' : ''}>${captainPlayLabel(s, canPause)}</button>
        <button class="lock-btn" id="lock-answer" ${canLock ? '' : 'disabled'}>🔒 LOCK ANSWER</button>`}` : `<div class="waiting-symbol">${phase === 'REVEAL' ? '✓' : '♪'}</div><div class="waiting-title">${phase === 'LOBBY' ? 'WAITING FOR GAME' : phase === 'ROUND_INTRO' ? `${s.roundLabel} ROUND` : phase === 'REVEAL' ? 'ANSWER REVEALED' : `WAITING FOR ${esc(s.teamNames[s.activeTeam])}`}</div>`}
    </section>`}
  </main>`;
  document.querySelector('#play-pause')?.addEventListener('click', () => emit(canPause ? 'captain:pause' : 'captain:play'));
  document.querySelector('#lock-answer')?.addEventListener('click', () => emit('captain:lockAnswer'));
  document.querySelector('#lock-steal')?.addEventListener('click', () => emit('captain:lockSteal'));
  manageCountdown();
}
function manageCountdown() {
  clearInterval(countdownTimer);
  if (!state?.stealDeadline || !['STEAL','STEAL_LOCKED'].includes(state.phase)) return;
  const node = document.querySelector('#steal-countdown'); if (!node) return;
  const update = () => { node.textContent = `${Math.max(0, (state.stealDeadline - Date.now()) / 1000).toFixed(1)}`; };
  update(); countdownTimer = setInterval(update, 100);
}
function finalScreen(s) {
  const winner = s.scores.A === s.scores.B ? 'TIE GAME' : `${s.teamNames[s.scores.A > s.scores.B ? 'A' : 'B']} WINS!`;
  return `<section class="final-stage"><div class="trophy">🏆</div><div class="micro-label">FINAL</div><h2>${esc(winner)}</h2>${scoreCards(s)}</section>`;
}

function updateLiveUi() {
  if (!state) return;
  const value = state.phase.startsWith('STEAL') ? 1 : state.currentPoints;
  document.querySelectorAll('.live-points-number').forEach((node) => { node.textContent = String(value); });
  document.querySelectorAll('.points').forEach((node) => { node.outerHTML = pointsStars(value); });
  document.querySelectorAll('.meter > div').forEach((bar) => { bar.style.width = `${exposureProgress(state)}%`; });
  document.querySelectorAll('.heard').forEach((node) => { node.textContent = heardText(state); });
  const judgeValue = document.querySelector('.judge-value');
  if (judgeValue && mode === 'host' && !state.phase.startsWith('STEAL')) judgeValue.innerHTML = `<span>${state.currentPoints}</span> pts · ${heardText(state)}`;
}

function render() {
  document.body.dataset.mode = mode;
  document.body.dataset.phase = state?.phase || 'NONE';
  document.body.dataset.round = state?.round || 'none';
  if (mode === 'home') return renderHome();
  if (mode === 'display') return renderDisplay();
  if (mode === 'host') return renderHostController();
  return renderCaptain();
}

function createDemoTone(duration) {
  const sampleRate = 44100;
  const frames = Math.max(1, Math.floor(duration * sampleRate));
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  write(0,'RIFF'); view.setUint32(4,36 + frames * 2,true); write(8,'WAVE'); write(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,sampleRate,true); view.setUint32(28,sampleRate * 2,true); view.setUint16(32,2,true); view.setUint16(34,16,true); write(36,'data'); view.setUint32(40,frames * 2,true);
  for (let i = 0; i < frames; i += 1) {
    const t = i / sampleRate;
    const pulse = Math.floor(t * 2) % 2 === 0 ? 1 : .55;
    const sample = Math.sin(2 * Math.PI * (220 + 30 * Math.sin(t * 1.7)) * t) * .22 * pulse;
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 32767, true);
  }
  if (demoUrl) URL.revokeObjectURL(demoUrl);
  demoUrl = URL.createObjectURL(new Blob([buffer], { type:'audio/wav' }));
  return demoUrl;
}
async function waitForAudioReady(timeoutMs = 6000) {
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
  const key = `${song.id}:${song.audioFile}`;
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
});

function readStoredJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { localStorage.removeItem(key); return null; }
}
function isTransientRestoreError(result) {
  return ['NETWORK_ERROR','BAD_RESPONSE','INTERNAL_ERROR'].includes(result?.error);
}
function renderRestoringSession() {
  app.innerHTML = `<main class="shell phone-shell restore-shell">${brand('RESTORING SESSION', true)}<section class="controller-card center-stack restore-card"><div class="controller-icon">↻</div><h2>RECONNECTING…</h2><p>Restoring this device to the current game.</p></section></main>`;
}
function scheduleRestoreRetry() {
  restoreAttempt += 1;
  const delay = Math.min(5000, 500 * (2 ** Math.min(restoreAttempt - 1, 3)));
  renderRestoringSession();
  clearTimeout(restoreRetryTimer);
  restoreRetryTimer = setTimeout(() => restoreSession(), delay);
}
function finishRestore() {
  restoreAttempt = 0;
  clearTimeout(restoreRetryTimer);
  restoreRetryTimer = null;
}

async function restoreSession() {
  if (restoreInFlight) return;
  restoreInFlight = true;
  if (mode !== 'home') renderRestoringSession();
  try {
    if (mode === 'display') {
      const saved = readStoredJson('ntt-display');
      if (saved?.roomCode && saved?.displayToken) {
        const result = await api('/api/display/resume', saved);
        if (result?.ok) {
          roomCode = result.roomCode; displayToken = result.displayToken; hostPin = result.hostPin; state = result.state;
          finishRestore(); saveDisplay(); connectEvents(); render(); return;
        }
        if (isTransientRestoreError(result)) { scheduleRestoreRetry(); return; }
        localStorage.removeItem('ntt-display');
      }
    }
    if (mode === 'host' && roomFromPath) {
      const key = `ntt-host-${roomFromPath}`;
      const saved = readStoredJson(key);
      if (saved?.hostToken) {
        const result = await api('/api/host/join', saved);
        if (result?.ok) {
          roomCode = roomFromPath; hostToken = result.hostToken || saved.hostToken; state = result.state;
          finishRestore(); saveHost(); connectEvents(); render(); return;
        }
        if (isTransientRestoreError(result)) { scheduleRestoreRetry(); return; }
        localStorage.removeItem(key);
      }
    }
    if (mode === 'captain' && roomFromPath) {
      const activeKey = `ntt-captain-active-${roomFromPath}`;
      const activeTeam = localStorage.getItem(activeKey);
      const savedTeams = ['A','B']
        .map((t) => ({ team:t, saved:readStoredJson(`ntt-captain-${roomFromPath}-${t}`) }))
        .filter((entry) => entry.saved?.captainToken);
      const restoreOrder = ['A','B'].includes(activeTeam) ? [activeTeam] : savedTeams.map((entry) => entry.team);
      let candidate = null;
      if (['A','B'].includes(activeTeam)) {
        candidate = savedTeams.find((entry) => entry.team === activeTeam) || null;
      } else if (savedTeams.length === 1) {
        candidate = savedTeams[0];
      } else if (savedTeams.length > 1) {
        finishRestore(); render(); return;
      }
      if (candidate) {
        const saved = candidate.saved;
        const result = await api('/api/captain/join', saved);
        if (result?.ok) {
          roomCode = roomFromPath; team = candidate.team; captainToken = result.captainToken || saved.captainToken; state = result.state;
          finishRestore(); saveCaptain(); connectEvents(); render(); return;
        }
        if (isTransientRestoreError(result)) { scheduleRestoreRetry(); return; }
        localStorage.removeItem(`ntt-captain-${roomFromPath}-${candidate.team}`);
        if (activeTeam === candidate.team) localStorage.removeItem(activeKey);
      } else if (['A','B'].includes(activeTeam)) {
        localStorage.removeItem(activeKey);
      }
    }
    finishRestore();
    render();
  } finally {
    restoreInFlight = false;
  }
}

restoreSession();
