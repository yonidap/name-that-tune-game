const app = document.querySelector('#app');
const audio = document.querySelector('#game-audio');

const pathParts = location.pathname.split('/').filter(Boolean);
const mode = pathParts[0] === 'host' ? 'host' : pathParts[0] === 'join' ? 'captain' : 'home';
const roomFromPath = pathParts[1]?.toUpperCase() || '';

let state = null;
let roomCode = '';
let hostToken = '';
let captainToken = '';
let team = null;
let audioUnlocked = false;
let progressTimer = null;
let demoUrl = null;
let currentAudioKey = '';
let countdownTimer = null;
let usingDemo = false;
let eventSource = null;

function esc(value = '') {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
}

function difficultyClass(value) {
  return ['easy','medium','hard'].includes(value) ? value : 'easy';
}

function pointsStars(points = 0) {
  return `<div class="points" aria-label="${points} points">${[1,2,3,4,5].map((n)=>`<span class="${n<=points?'on':''}">★</span>`).join('')}</div>`;
}

function scoreCards(s) {
  return `<div class="grid-2">
    <div class="card center"><div class="team-name">${esc(s.teamNames.A)}</div><div class="score">${s.scores.A}</div></div>
    <div class="card center"><div class="team-name">${esc(s.teamNames.B)}</div><div class="score">${s.scores.B}</div></div>
  </div>`;
}

function brand(subtitle = 'Two teams. One snippet. Name that song.') {
  return `<div class="brand"><div><div class="eyebrow">Music party game</div><h1>Name That Tune</h1><p class="subtitle">${esc(subtitle)}</p></div></div>`;
}

function api(path, payload = {}) {
  return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    .then(async (res) => { const data = await res.json().catch(() => ({ ok:false, error:'BAD_RESPONSE' })); return data; })
    .catch(() => ({ ok:false, error:'NETWORK_ERROR' }));
}

function emit(action, payload = {}) {
  return api('/api/action', { action, roomCode, token: mode === 'host' ? hostToken : captainToken, team, ...payload });
}

function connectEvents() {
  if (!roomCode || (mode === 'host' ? !hostToken : !captainToken)) return;
  if (eventSource) eventSource.close();
  const params = new URLSearchParams({ room: roomCode, role: mode === 'host' ? 'host' : 'captain', token: mode === 'host' ? hostToken : captainToken });
  if (mode === 'captain') params.set('team', team);
  eventSource = new EventSource(`/events?${params}`);
  eventSource.addEventListener('state', (event) => { state = JSON.parse(event.data); roomCode = state.roomCode; render(); });
  eventSource.addEventListener('audio-play', (event) => handleAudioPlay(JSON.parse(event.data)));
  eventSource.addEventListener('audio-pause', () => handleAudioPause());
}

function saveHost() {
  localStorage.setItem('nts-host', JSON.stringify({ roomCode, hostToken }));
}

function saveCaptain() {
  localStorage.setItem(`nts-captain-${roomCode}-${team}`, JSON.stringify({ roomCode, team, captainToken }));
}

function renderHome() {
  app.innerHTML = `<main class="shell">
    ${brand()}
    <section class="card stack center">
      <div class="big-number">♪</div>
      <h2>Ready to run the room?</h2>
      <p class="muted">Create the game on the computer connected to the speakers. Captains join from their phones.</p>
      <div class="row" style="justify-content:center">
        <a class="btn primary" href="/host" style="text-decoration:none;display:inline-flex;align-items:center">Create game</a>
      </div>
    </section>
  </main>`;
}

function renderHostSetup() {
  app.innerHTML = `<main class="shell">
    ${brand('Host screen — connect this device to the speakers.')}
    <section class="card stack">
      <div class="grid-2">
        <div class="field"><label>Team A name</label><input id="team-a" maxlength="24" value="Team A"></div>
        <div class="field"><label>Team B name</label><input id="team-b" maxlength="24" value="Team B"></div>
      </div>
      <div class="field"><label>Game length</label><select id="game-length"><option value="short">Short · 15 songs</option><option value="normal" selected>Normal · 21 songs</option><option value="full">Full · 40 songs</option></select></div>
      <button class="btn primary" id="create-game">Create game</button>
    </section>
  </main>`;
  document.querySelector('#create-game').addEventListener('click', async () => {
    const result = await api('/api/host/create', {
      gameLength: document.querySelector('#game-length').value,
      teamNames: { A: document.querySelector('#team-a').value.trim(), B: document.querySelector('#team-b').value.trim() }
    });
    if (!result?.ok) return alert('Could not create game.');
    roomCode = result.roomCode;
    hostToken = result.hostToken;
    state = result.state;
    saveHost();
    connectEvents();
    history.replaceState({}, '', `/host?room=${roomCode}`);
    render();
  });
}

function joinUrl() {
  return `${location.origin}/join/${roomCode}`;
}

function hostLobby(s) {
  return `<main class="shell">
    ${brand('Lobby — captains join from their phones.')}
    <section class="card center stack">
      <div class="eyebrow">Room code</div>
      <div class="room-code">${esc(roomCode)}</div>
      <div class="callout">${esc(joinUrl())}</div>
      <div class="grid-2">
        <div class="card"><div class="row between"><strong>${esc(s.teamNames.A)}</strong><span class="status-dot ${s.connected.A?'on':''}"></span></div><p class="muted">${s.connected.A?'Captain connected':'Waiting for captain'}</p></div>
        <div class="card"><div class="row between"><strong>${esc(s.teamNames.B)}</strong><span class="status-dot ${s.connected.B?'on':''}"></span></div><p class="muted">${s.connected.B?'Captain connected':'Waiting for captain'}</p></div>
      </div>
      <div class="row" style="justify-content:center">
        <button class="btn" id="enable-audio">${audioUnlocked?'✓ Audio enabled':'🔊 Enable audio'}</button>
        <button class="btn primary" id="start-game" ${!s.connected.A || !s.connected.B || !audioUnlocked ? 'disabled' : ''}>Start game</button>
      </div>
      <div class="tiny">Audio snippets are not stored in Git. Missing files automatically use a demo tone.</div>
    </section>
  </main>`;
}

function hostGame(s) {
  const isReveal = s.phase === 'REVEAL';
  const canJudge = ['ANSWER_LOCKED','STEAL','STEAL_LOCKED'].includes(s.phase);
  const song = s.song;
  const progress = s.duration ? Math.min(100, (s.listenedSeconds / s.duration) * 100) : 0;
  return `<main class="shell">
    ${brand(`Room ${roomCode}`)}
    ${scoreCards(s)}
    ${s.phase === 'ROUND_INTRO' ? `<section class="card center stack"><span class="pill ${difficultyClass(s.round)}">${esc(s.roundLabel)}</span><div class="big-number">${s.round==='easy'?'Ⅰ':s.round==='medium'?'Ⅱ':'Ⅲ'}</div><h2>${esc(s.roundLabel)} ROUND</h2><button class="btn primary" id="begin-round">Start round</button></section>` : ''}
    ${s.phase !== 'ROUND_INTRO' && s.phase !== 'FINISHED' ? `<section class="card stack">
      <div class="row between"><span class="pill ${difficultyClass(s.round)}">${esc(s.roundLabel)}</span><strong>Song ${s.songNumber} / ${s.totalSongs}</strong></div>
      <div class="grid-2">
        <div class="stack">
          <div><div class="eyebrow">Host-only answer</div><h2 class="song-title">${esc(song?.title || '—')}</h2><p class="artist">${esc(song?.artist || '')}</p></div>
          <div class="callout">Audio: ${usingDemo ? 'Demo tone fallback' : esc(song?.audioFile || '—')} · source reference ${esc(song?.sourceStart || '—')}</div>
        </div>
        <div class="card center stack">
          <div class="eyebrow">${esc(s.teamNames[s.activeTeam])}${s.phase.startsWith('STEAL')?' · STEAL':' · TURN'}</div>
          ${pointsStars(s.phase.startsWith('STEAL')?1:s.currentPoints)}
          <div><strong>${s.listenedSeconds.toFixed(2)}s</strong> heard</div>
          <div class="meter"><div style="width:${progress}%"></div></div>
          <div class="pill">${esc(s.phase.replaceAll('_',' '))}</div>
        </div>
      </div>
      <div class="host-controls">
        <button class="btn good" id="correct" ${canJudge?'':'disabled'}>✓ Correct</button>
        <button class="btn bad" id="wrong" ${canJudge?'':'disabled'}>✕ Wrong</button>
        <button class="btn warn" id="reveal" ${isReveal?'disabled':''}>Reveal</button>
        <button class="btn" id="next" ${isReveal?'':'disabled'}>Next song →</button>
        <button class="btn" id="undo">Undo</button>
      </div>
      <div class="row">
        <span class="muted">Adjust score:</span>
        <button class="btn" data-score="A" data-delta="-1">${esc(s.teamNames.A)} −1</button>
        <button class="btn" data-score="A" data-delta="1">${esc(s.teamNames.A)} +1</button>
        <button class="btn" data-score="B" data-delta="-1">${esc(s.teamNames.B)} −1</button>
        <button class="btn" data-score="B" data-delta="1">${esc(s.teamNames.B)} +1</button>
      </div>
    </section>` : ''}
    ${s.phase === 'FINISHED' ? finalScreen(s, true) : ''}
    ${isReveal ? `<section class="card answer-card center"><div class="eyebrow">Answer</div><h2 class="song-title">${esc(song?.title || '')}</h2><p class="artist">${esc(song?.artist || '')}</p></section>` : ''}
  </main>`;
}

function finalScreen(s, host = false) {
  const winner = s.scores.A === s.scores.B ? 'Tie game' : `${s.teamNames[s.scores.A > s.scores.B ? 'A':'B']} wins!`;
  return `<section class="card center stack"><div class="eyebrow">Final score</div><div class="big-number">🏆</div><h2 class="song-title">${esc(winner)}</h2>${scoreCards(s)}${host?'<p class="muted">Refresh to start a new room.</p>':''}</section>`;
}

function renderHost() {
  if (!roomCode || !hostToken || !state) return renderHostSetup();
  app.innerHTML = state.phase === 'LOBBY' ? hostLobby(state) : hostGame(state);
  bindHostControls();
  syncAudioForState();
}

function bindHostControls() {
  const q = (sel) => document.querySelector(sel);
  q('#enable-audio')?.addEventListener('click', async () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      await ctx.resume();
      const osc = ctx.createOscillator(); const gain = ctx.createGain(); gain.gain.value = 0.00001; osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.03);
      audioUnlocked = true;
      render();
    } catch { alert('Audio could not be enabled.'); }
  });
  q('#start-game')?.addEventListener('click', () => emit('host:start', { roomCode, hostToken }));
  q('#begin-round')?.addEventListener('click', () => emit('host:beginRound', { roomCode, hostToken }));
  q('#correct')?.addEventListener('click', () => emit('host:markCorrect', { roomCode, hostToken }));
  q('#wrong')?.addEventListener('click', () => emit('host:markWrong', { roomCode, hostToken }));
  q('#reveal')?.addEventListener('click', () => emit('host:reveal', { roomCode, hostToken }));
  q('#next')?.addEventListener('click', () => emit('host:next', { roomCode, hostToken }));
  q('#undo')?.addEventListener('click', () => emit('host:undo', { roomCode, hostToken }));
  document.querySelectorAll('[data-score]').forEach((button) => button.addEventListener('click', () => emit('host:adjustScore', { roomCode, hostToken, team: button.dataset.score, delta: Number(button.dataset.delta) })));
}

function renderCaptainJoin() {
  app.innerHTML = `<main class="shell">
    ${brand(`Join room ${roomFromPath || '—'}`)}
    <section class="card stack center"><h2>Choose your team</h2><button class="btn primary" id="join-a">Team A captain</button><button class="btn primary" id="join-b">Team B captain</button><p class="muted" id="join-error"></p></section>
  </main>`;
  for (const t of ['A','B']) document.querySelector(`#join-${t.toLowerCase()}`).addEventListener('click', () => joinCaptain(t));
}

async function joinCaptain(selectedTeam) {
  roomCode = roomFromPath;
  team = selectedTeam;
  const key = `nts-captain-${roomCode}-${team}`;
  const saved = JSON.parse(localStorage.getItem(key) || 'null');
  const result = await api('/api/captain/join', { roomCode, team, captainToken: saved?.captainToken || null });
  if (!result?.ok) {
    document.querySelector('#join-error').textContent = result?.error === 'TEAM_TAKEN' ? 'That captain slot is already connected.' : 'Could not join this room.';
    return;
  }
  captainToken = result.captainToken;
  state = result.state;
  saveCaptain();
  connectEvents();
  render();
}

function renderCaptain() {
  if (!state || !team) return renderCaptainJoin();
  const myTurn = state.activeTeam === team;
  const phase = state.phase;
  const progress = state.duration ? Math.min(100,(state.listenedSeconds/state.duration)*100) : 0;
  const canPlay = myTurn && ['READY','PAUSED'].includes(phase);
  const canPause = myTurn && phase === 'PLAYING';
  const canLock = myTurn && ['READY','PAUSED'].includes(phase);
  const isSteal = myTurn && ['STEAL','STEAL_LOCKED'].includes(phase);
  const waitingText = phase === 'LOBBY' ? 'Waiting for host to start' : phase === 'ROUND_INTRO' ? `${state.roundLabel} round is about to begin` : `Waiting for ${state.teamNames[state.activeTeam]}`;
  app.innerHTML = `<main class="shell">
    ${brand(`${state.teamNames[team]} captain`)}
    ${scoreCards(state)}
    ${phase === 'FINISHED' ? finalScreen(state) : `<section class="card stack center">
      <div class="row between"><span class="pill ${difficultyClass(state.round)}">${esc(state.roundLabel)}</span><strong>Song ${Math.max(0,state.songNumber)} / ${state.totalSongs}</strong></div>
      ${myTurn && !['LOBBY','ROUND_INTRO','REVEAL'].includes(phase) ? `
        <div class="eyebrow">${isSteal?'STEAL':'YOUR TURN'}</div>
        ${pointsStars(isSteal?1:state.currentPoints)}
        ${isSteal ? `<div class="countdown" id="steal-countdown">10.0</div><p class="muted">No more audio. Answer for 1 point.</p><button class="btn primary" id="lock-steal" ${phase==='STEAL_LOCKED'?'disabled':''}>${phase==='STEAL_LOCKED'?'Answer locked':'🔒 Lock steal answer'}</button>` : `
          <div class="meter"><div style="width:${progress}%"></div></div>
          <div><strong>${state.listenedSeconds.toFixed(2)} seconds</strong> heard</div>
          <button class="btn play" id="play-pause">${canPause?'⏸ STOP':'▶ '+(state.listenedSeconds>0?'HEAR MORE':'PLAY')}</button>
          <button class="btn primary" id="lock-answer" ${canLock?'':'disabled'}>🔒 Lock answer · ${state.currentPoints} pts</button>
        `}
      ` : `<div class="big-number">${phase==='REVEAL'?'✓':'♪'}</div><h2>${esc(waitingText)}</h2>`}
      ${phase === 'ANSWER_LOCKED' && myTurn ? '<div class="callout">Answer locked. Tell the host your answer.</div>' : ''}
      ${phase === 'REVEAL' ? '<div class="callout">Answer revealed on the host screen.</div>' : ''}
    </section>`}
  </main>`;
  document.querySelector('#play-pause')?.addEventListener('click', () => emit(canPause?'captain:pause':'captain:play', { roomCode, team, captainToken }));
  document.querySelector('#lock-answer')?.addEventListener('click', () => emit('captain:lockAnswer', { roomCode, team, captainToken }));
  document.querySelector('#lock-steal')?.addEventListener('click', () => emit('captain:lockSteal', { roomCode, team, captainToken }));
  manageCountdown();
}

function manageCountdown() {
  clearInterval(countdownTimer);
  if (!state?.stealDeadline || !['STEAL','STEAL_LOCKED'].includes(state.phase)) return;
  const node = document.querySelector('#steal-countdown');
  if (!node) return;
  const update = () => { node.textContent = `${Math.max(0,(state.stealDeadline-Date.now())/1000).toFixed(1)}`; };
  update(); countdownTimer = setInterval(update,100);
}

function render() {
  if (mode === 'home') return renderHome();
  if (mode === 'host') return renderHost();
  return renderCaptain();
}

function createDemoTone(duration) {
  const sampleRate = 44100;
  const frames = Math.max(1, Math.floor(duration * sampleRate));
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  write(0,'RIFF'); view.setUint32(4,36+frames*2,true); write(8,'WAVE'); write(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,sampleRate,true); view.setUint32(28,sampleRate*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true); write(36,'data'); view.setUint32(40,frames*2,true);
  for (let i=0;i<frames;i+=1) {
    const t=i/sampleRate; const pulse=(Math.floor(t*2)%2===0?1:.55); const sample=Math.sin(2*Math.PI*(220+30*Math.sin(t*1.7))*t)*0.22*pulse; view.setInt16(44+i*2,Math.max(-1,Math.min(1,sample))*32767,true);
  }
  if (demoUrl) URL.revokeObjectURL(demoUrl);
  demoUrl = URL.createObjectURL(new Blob([buffer],{type:'audio/wav'}));
  return demoUrl;
}

async function prepareAudio(song) {
  if (!song || mode !== 'host') return;
  const key = `${song.id}:${song.audioFile}`;
  if (currentAudioKey === key) return;
  currentAudioKey = key;
  usingDemo = false;
  audio.src = song.audioFile;
  audio.load();
  const ok = await new Promise((resolve) => {
    let settled=false;
    const done=(value)=>{if(settled)return;settled=true;cleanup();resolve(value);};
    const cleanup=()=>{audio.removeEventListener('canplaythrough',yes);audio.removeEventListener('error',no);clearTimeout(timer);};
    const yes=()=>done(true); const no=()=>done(false); const timer=setTimeout(()=>done(false),1300);
    audio.addEventListener('canplaythrough',yes,{once:true}); audio.addEventListener('error',no,{once:true});
  });
  if (!ok) {
    usingDemo = true;
    audio.src = createDemoTone(song.duration);
    audio.load();
  }
}

function syncAudioForState() {
  if (mode !== 'host' || !state?.song) return;
  prepareAudio(state.song).then(() => {
    if (state.phase !== 'PLAYING' && Math.abs(audio.currentTime - state.listenedSeconds) > .35) {
      try { audio.currentTime = state.listenedSeconds; } catch {}
    }
  });
}

async function handleAudioPlay({ startAt }) {
  if (mode !== 'host' || !state?.song) return;
  await prepareAudio(state.song);
  try {
    audio.currentTime = Math.min(Number(startAt)||0, state.song.duration || 999);
    await audio.play();
    clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      emit('host:audioProgress', { position: audio.currentTime, paused: audio.paused });
    }, 200);
  } catch (error) {
    console.error(error);
    alert('Audio playback was blocked. Click Enable audio on the host screen, then try again.');
  }
}

function handleAudioPause() {
  if (mode !== 'host') return;
  audio.pause();
  clearInterval(progressTimer);
  emit('host:audioProgress', { position: audio.currentTime, paused: true });
}

audio.addEventListener('ended', () => {
  clearInterval(progressTimer);
  if (mode === 'host') emit('host:audioProgress', { position: audio.currentTime, paused: true });
});

async function restoreSession() {
  if (mode === 'host') {
    const saved = JSON.parse(localStorage.getItem('nts-host') || 'null');
    if (saved?.roomCode && saved?.hostToken) {
      roomCode = saved.roomCode; hostToken = saved.hostToken; connectEvents(); render(); return;
    }
  }
  if (mode === 'captain' && roomFromPath) {
    for (const t of ['A','B']) {
      const saved = JSON.parse(localStorage.getItem(`nts-captain-${roomFromPath}-${t}`) || 'null');
      if (!saved?.captainToken) continue;
      const result = await api('/api/captain/join', saved);
      if (result?.ok) { roomCode=roomFromPath; team=t; captainToken=saved.captainToken; state=result.state; connectEvents(); render(); return; }
    }
  }
  render();
}

restoreSession();
