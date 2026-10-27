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
let countdownTimer = null;
let eventSource = null;
let selectedGameLength = 'normal';

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
  return `<div class="points" aria-label="${points} points">${[1,2,3,4,5].map((n) => `<span class="${n <= points ? 'on' : ''}">★</span>`).join('')}</div>`;
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
  return fetch(path, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload) })
    .then(async (res) => res.json().catch(() => ({ ok:false, error:'BAD_RESPONSE' })))
    .catch(() => ({ ok:false, error:'NETWORK_ERROR' }));
}
function emit(action, payload = {}) {
  const token = mode === 'display' ? displayToken : mode === 'host' ? hostToken : captainToken;
  return api('/api/action', { action, roomCode, token, team, ...payload });
}
function connectEvents() {
  const token = mode === 'display' ? displayToken : mode === 'host' ? hostToken : captainToken;
  if (!roomCode || !token || mode === 'home') return;
  eventSource?.close();
  const params = new URLSearchParams({ room:roomCode, role:mode, token });
  if (mode === 'captain') params.set('team', team);
  eventSource = new EventSource(`/events?${params}`);
  eventSource.addEventListener('state', (event) => {
    state = JSON.parse(event.data);
    roomCode = state.roomCode;
    render();
  });
  if (mode === 'display') {
    eventSource.addEventListener('audio-play', (event) => handleAudioPlay(JSON.parse(event.data)));
    eventSource.addEventListener('audio-pause', () => handleAudioPause());
  }
}
function saveDisplay() { localStorage.setItem('ntt-display', JSON.stringify({ roomCode, displayToken, hostPin })); }
function saveHost() { localStorage.setItem(`ntt-host-${roomCode}`, JSON.stringify({ roomCode, hostToken })); }
function saveCaptain() { localStorage.setItem(`ntt-captain-${roomCode}-${team}`, JSON.stringify({ roomCode, team, captainToken })); }

function renderHome() {
  app.innerHTML = `<main class="shell home-shell">
    ${brand('Two teams. One snippet. How fast can you name it?')}
    <section class="home-stage">
      <div class="home-eq" aria-hidden="true">${Array.from({length:28},(_,i)=>`<i style="--i:${i}"></i>`).join('')}</div>
      <div class="home-title">READY TO PLAY?</div>
      <div class="home-actions">
        <a class="home-action start-action" href="/host">
          <span class="action-icon">▶</span><span class="action-label">START A GAME</span><small>Create the room on the device connected to the speakers</small>
        </a>
        <form class="home-action join-action" id="join-room-form">
          <span class="action-icon">↗</span><span class="action-label">JOIN A ROOM</span>
          <div class="join-code-row"><input id="home-room-code" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="ROOM CODE" aria-label="Room code"><button type="submit">JOIN</button></div>
          <small>Captain or player? Enter the 4-character room code</small>
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
  { value:'full', icon:'♛', title:'FULL BATTLE', songs:'40', note:'No mercy' }
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
    renderDisplaySetup();
  }));
  document.querySelector('#create-game')?.addEventListener('click', async () => {
    const result = await api('/api/display/create', {
      gameLength:selectedGameLength,
      teamNames:{ A:document.querySelector('#team-a').value.trim(), B:document.querySelector('#team-b').value.trim() }
    });
    if (!result?.ok) return alert('Could not create game.');
    roomCode=result.roomCode; displayToken=result.displayToken; hostPin=result.hostPin; state=result.state;
    saveDisplay(); connectEvents(); history.replaceState({},'',`/host?room=${roomCode}`); render();
  });
}
function captainJoinUrl() { return `${location.origin}/join/${roomCode}`; }
function hostControlUrl() { return `${location.origin}/control/${roomCode}`; }
function displayLobby(s) {
  return `<main class="shell game-shell lobby-screen">
    ${brand('SCAN OR ENTER THE ROOM CODE', true)}
    <section class="lobby-code-block"><div class="micro-label">ROOM CODE</div><div class="room-code">${esc(roomCode)}</div><div class="lobby-hint">Captains can also enter this code from the home screen</div></section>
    <div class="lobby-grid">
      <section class="join-panel captain-join"><div class="join-icon">⚡</div><div class="micro-label">CAPTAINS</div><div class="join-url">${esc(captainJoinUrl())}</div><div class="status-row"><span class="status-dot ${s.connected.A?'on':''}"></span>${esc(s.teamNames.A)}</div><div class="status-row"><span class="status-dot ${s.connected.B?'on':''}"></span>${esc(s.teamNames.B)}</div></section>
      <section class="join-panel host-join"><div class="join-icon">🎛</div><div class="micro-label">HOST PHONE</div><div class="join-url">${esc(hostControlUrl())}</div><div class="pin-label">HOST PIN</div><div class="host-pin">${esc(hostPin || '••••')}</div><div class="status-row"><span class="status-dot ${s.connected.host?'on':''}"></span>${s.connected.host?'Host connected':'Waiting for host'}</div></section>
    </div>
    <section class="audio-gate ${audioUnlocked?'ready':''}"><button class="audio-btn" id="enable-audio">${audioUnlocked?'✓ SPEAKERS READY':'🔊 ENABLE SPEAKERS'}</button><div>The game cannot start until audio is enabled on this screen.</div></section>
  </main>`;
}
function displayGame(s) {
  const reveal = s.phase === 'REVEAL';
  const progress = s.duration ? Math.min(100,(s.listenedSeconds/s.duration)*100) : 0;
  const stageLabel = s.phase === 'ROUND_INTRO' ? `${s.roundLabel} ROUND` : s.phase === 'FINISHED' ? 'FINAL SCORE' : `${s.roundLabel} · SONG ${s.songNumber}/${s.totalSongs}`;
  return `<main class="shell game-shell audience-screen">
    <header class="game-top"><div class="round-badge ${difficultyClass(s.round)}">${esc(stageLabel)}</div><div class="room-mini">ROOM ${esc(roomCode)}</div></header>
    ${scoreCards(s)}
    ${s.phase === 'ROUND_INTRO' ? `<section class="round-splash ${difficultyClass(s.round)}"><div class="round-number">${s.round==='easy'?'01':s.round==='medium'?'02':'03'}</div><div class="round-word">${esc(s.roundLabel)}</div><p>HOST — START THE ROUND</p></section>` : ''}
    ${!['ROUND_INTRO','FINISHED'].includes(s.phase) ? `<section class="play-stage ${reveal?'revealing':''}">${reveal ? `<div class="answer-reveal"><div class="micro-label">THE TUNE WAS</div><h2>${esc(s.song?.title || '')}</h2><p>${esc(s.song?.artist || '')}</p></div>` : `
      <div class="turn-banner">${esc(s.teamNames[s.activeTeam])}<span>${s.phase.startsWith('STEAL')?'STEAL':'YOUR TURN'}</span></div>
      <div class="vinyl" aria-hidden="true"><div class="vinyl-core">♪</div></div>
      <div class="value-block"><div class="micro-label">CURRENT VALUE</div><div class="point-number">${s.phase.startsWith('STEAL')?1:s.currentPoints}</div><div class="point-label">POINT${(s.phase.startsWith('STEAL')?1:s.currentPoints)===1?'':'S'}</div>${pointsStars(s.phase.startsWith('STEAL')?1:s.currentPoints)}</div>
      <div class="wave-line" aria-hidden="true">${Array.from({length:28},(_,i)=>`<i style="--i:${i}"></i>`).join('')}</div>
      <div class="progress-wrap"><div class="meter"><div style="width:${progress}%"></div></div><div class="heard">${s.listenedSeconds.toFixed(1)}s heard</div></div>
      <div class="phase-call">${s.phase==='PLAYING'?'▶ PLAYING':s.phase==='ANSWER_LOCKED'?'🔒 ANSWER LOCKED':s.phase.startsWith('STEAL')?'⚡ STEAL':'READY'}</div>`}</section>` : ''}
    ${s.phase === 'FINISHED' ? finalScreen(s) : ''}
  </main>`;
}
function bindDisplayControls() {
  document.querySelector('#enable-audio')?.addEventListener('click', async () => {
    try {
      const Ctx=window.AudioContext||window.webkitAudioContext; const ctx=new Ctx(); await ctx.resume();
      const osc=ctx.createOscillator(); const gain=ctx.createGain(); gain.gain.value=.00001; osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime+.03);
      audioUnlocked=true; await emit('display:audioReady',{ready:true}); render();
    } catch { alert('Audio could not be enabled.'); }
  });
}
function renderDisplay() {
  if (!roomCode || !displayToken || !state) return renderDisplaySetup();
  app.innerHTML = state.phase === 'LOBBY' ? displayLobby(state) : displayGame(state);
  bindDisplayControls(); syncAudioForState();
}

function renderHostJoin() {
  const room = roomFromPath;
  app.innerHTML = `<main class="shell phone-shell">${brand(`HOST CONTROL · ROOM ${room || '—'}`, true)}<section class="controller-card center-stack"><div class="controller-icon">🎛</div><h2>HOST CONTROL</h2><p>Enter the PIN shown on the main screen.</p><input class="pin-input" id="host-pin-input" inputmode="numeric" maxlength="4" placeholder="0000"><button class="primary-control" id="host-join">CONNECT</button><div class="inline-error" id="host-error"></div></section></main>`;
  document.querySelector('#host-join')?.addEventListener('click', joinHostController);
}
async function joinHostController() {
  roomCode = roomFromPath;
  const pin = document.querySelector('#host-pin-input')?.value.trim();
  const saved = JSON.parse(localStorage.getItem(`ntt-host-${roomCode}`)||'null');
  const result = await api('/api/host/join',{ roomCode, hostPin:pin, hostToken:saved?.hostToken||null });
  if (!result?.ok) { document.querySelector('#host-error').textContent = result?.error === 'BAD_PIN' ? 'Wrong PIN.' : 'Could not connect.'; return; }
  hostToken=result.hostToken; state=result.state; saveHost(); connectEvents(); render();
}
function hostConnectionStrip(s) {
  return `<div class="connection-strip"><span class="${s.connected.display?'ok':''}">SCREEN</span><span class="${s.audioReady?'ok':''}">AUDIO</span><span class="${s.connected.A?'ok':''}">A</span><span class="${s.connected.B?'ok':''}">B</span></div>`;
}
function renderHostController() {
  if (!roomCode || !hostToken || !state) return renderHostJoin();
  const s=state;
  const canStart=s.phase==='LOBBY' && s.connected.display && s.audioReady && s.connected.A && s.connected.B;
  const canJudge=['ANSWER_LOCKED','STEAL','STEAL_LOCKED'].includes(s.phase);
  const reveal=s.phase==='REVEAL';
  app.innerHTML = `<main class="shell phone-shell controller-shell">
    <header class="phone-header"><div><div class="micro-label">HOST · ${esc(roomCode)}</div><h1>NAME THAT TUNE</h1></div><div class="mini-score">${s.scores.A}–${s.scores.B}</div></header>
    ${hostConnectionStrip(s)}
    ${s.phase==='LOBBY'?`<section class="controller-card center-stack"><div class="controller-icon">🎚</div><h2>ROOM READY?</h2><p>Both captains, the main screen and audio must be connected.</p><button class="primary-control" id="host-start" ${canStart?'':'disabled'}>START GAME</button></section>`:''}
    ${s.phase==='ROUND_INTRO'?`<section class="controller-card round-control ${difficultyClass(s.round)} center-stack"><div class="micro-label">NEXT ROUND</div><div class="controller-round">${esc(s.roundLabel)}</div><button class="primary-control" id="begin-round">START ROUND</button></section>`:''}
    ${!['LOBBY','ROUND_INTRO','FINISHED'].includes(s.phase)?`<section class="controller-card host-game-card">
      <div class="controller-meta"><span class="round-badge ${difficultyClass(s.round)}">${esc(s.roundLabel)}</span><strong>${s.songNumber}/${s.totalSongs}</strong></div>
      <div class="host-answer"><div class="micro-label">SECRET ANSWER</div><h2>${esc(s.song?.title||'—')}</h2><p>${esc(s.song?.artist||'')}</p></div>
      <div class="judge-status"><strong>${esc(s.teamNames[s.activeTeam])}</strong><span>${s.phase.startsWith('STEAL')?'STEAL':s.phase.replaceAll('_',' ')}</span></div>
      <div class="judge-value"><span>${s.phase.startsWith('STEAL')?1:s.currentPoints}</span> pts · ${s.listenedSeconds.toFixed(1)}s heard</div>
      ${canJudge?`<div class="judge-buttons"><button class="judge-btn correct" id="correct">✓<span>CORRECT</span></button><button class="judge-btn wrong" id="wrong">✕<span>WRONG</span></button></div>`:`<div class="waiting-judge">${s.phase==='PLAYING'?'Listening…':s.phase==='PAUSED'?'Captain is deciding…':reveal?'Answer revealed':'Waiting for captain…'}</div>`}
      <div class="controller-actions"><button class="secondary-control warn" id="reveal" ${reveal?'disabled':''}>REVEAL</button><button class="secondary-control next" id="next" ${reveal?'':'disabled'}>NEXT →</button><button class="secondary-control" id="undo">UNDO</button></div>
      <details class="score-tools"><summary>SCORE CORRECTION</summary><div class="score-adjust"><button data-score="A" data-delta="-1">A −1</button><button data-score="A" data-delta="1">A +1</button><button data-score="B" data-delta="-1">B −1</button><button data-score="B" data-delta="1">B +1</button></div></details>
    </section>`:''}
    ${s.phase==='FINISHED'?finalScreen(s):''}
  </main>`;
  document.querySelector('#host-start')?.addEventListener('click',()=>emit('host:start'));
  document.querySelector('#begin-round')?.addEventListener('click',()=>emit('host:beginRound'));
  document.querySelector('#correct')?.addEventListener('click',()=>emit('host:markCorrect'));
  document.querySelector('#wrong')?.addEventListener('click',()=>emit('host:markWrong'));
  document.querySelector('#reveal')?.addEventListener('click',()=>emit('host:reveal'));
  document.querySelector('#next')?.addEventListener('click',()=>emit('host:next'));
  document.querySelector('#undo')?.addEventListener('click',()=>emit('host:undo'));
  document.querySelectorAll('[data-score]').forEach((button)=>button.addEventListener('click',()=>emit('host:adjustScore',{team:button.dataset.score,delta:Number(button.dataset.delta)})));
}

function renderCaptainJoin() {
  app.innerHTML = `<main class="shell phone-shell">${brand(`JOIN ROOM ${roomFromPath||'—'}`, true)}<section class="controller-card center-stack"><div class="controller-icon">⚡</div><h2>CHOOSE YOUR TEAM</h2><button class="team-choice team-a-choice" id="join-a">TEAM A</button><button class="team-choice team-b-choice" id="join-b">TEAM B</button><div class="inline-error" id="join-error"></div><a class="back-home" href="/">← Different room</a></section></main>`;
  for (const t of ['A','B']) document.querySelector(`#join-${t.toLowerCase()}`)?.addEventListener('click',()=>joinCaptain(t));
}
async function joinCaptain(selectedTeam) {
  roomCode=roomFromPath; team=selectedTeam;
  const saved=JSON.parse(localStorage.getItem(`ntt-captain-${roomCode}-${team}`)||'null');
  const result=await api('/api/captain/join',{roomCode,team,captainToken:saved?.captainToken||null});
  if (!result?.ok) {
    document.querySelector('#join-error').textContent = result?.error==='TEAM_TAKEN' ? 'That captain slot is already taken.' : result?.error==='ROOM_NOT_FOUND' ? 'Room not found. Check the code.' : 'Could not join.';
    return;
  }
  captainToken=result.captainToken; state=result.state; saveCaptain(); connectEvents(); render();
}
function renderCaptain() {
  if (!state || !team) return renderCaptainJoin();
  const s=state; const myTurn=s.activeTeam===team; const phase=s.phase;
  const progress=s.duration?Math.min(100,(s.listenedSeconds/s.duration)*100):0;
  const canPause=myTurn&&phase==='PLAYING';
  const canLock=myTurn&&['READY','PAUSED'].includes(phase);
  const isSteal=myTurn&&['STEAL','STEAL_LOCKED'].includes(phase);
  app.innerHTML = `<main class="shell phone-shell captain-shell">
    <header class="phone-header captain-header"><div><div class="micro-label">YOU ARE</div><h1>${esc(s.teamNames[team])}</h1></div><div class="captain-score">${s.scores[team]}</div></header>
    <div class="opponent-line">${esc(s.teamNames[team==='A'?'B':'A'])} · ${s.scores[team==='A'?'B':'A']} pts</div>
    ${phase==='FINISHED'?finalScreen(s):`<section class="captain-stage ${myTurn?'your-turn':'waiting'}">
      <div class="round-badge ${difficultyClass(s.round)}">${esc(s.roundLabel)} · ${Math.max(0,s.songNumber)}/${s.totalSongs}</div>
      ${myTurn&&!['LOBBY','ROUND_INTRO','REVEAL'].includes(phase)?`${isSteal?`<div class="steal-flash">STEAL!</div><div class="point-number small">1</div><div class="point-label">POINT</div><div class="countdown" id="steal-countdown">10.0</div><p>No more audio. Decide now.</p><button class="lock-btn" id="lock-steal" ${phase==='STEAL_LOCKED'?'disabled':''}>${phase==='STEAL_LOCKED'?'LOCKED':'🔒 LOCK ANSWER'}</button>`:`
        <div class="your-turn-label">YOUR TURN</div>${pointsStars(s.currentPoints)}<div class="point-number small">${s.currentPoints}</div><div class="point-label">POINTS LEFT</div>
        <div class="meter"><div style="width:${progress}%"></div></div><div class="heard">${s.listenedSeconds.toFixed(1)}s heard</div>
        <button class="play-or-stop ${canPause?'stop':''}" id="play-pause">${canPause?'■ STOP':'▶ '+(s.listenedSeconds>0?'HEAR MORE':'PLAY')}</button>
        <button class="lock-btn" id="lock-answer" ${canLock?'':'disabled'}>🔒 LOCK ANSWER</button>`}`:`<div class="waiting-symbol">${phase==='REVEAL'?'✓':'♪'}</div><div class="waiting-title">${phase==='LOBBY'?'WAITING FOR GAME':phase==='ROUND_INTRO'?`${s.roundLabel} ROUND`:phase==='REVEAL'?'ANSWER REVEALED':`WAITING FOR ${esc(s.teamNames[s.activeTeam])}`}</div>`}
    </section>`}
  </main>`;
  document.querySelector('#play-pause')?.addEventListener('click',()=>emit(canPause?'captain:pause':'captain:play'));
  document.querySelector('#lock-answer')?.addEventListener('click',()=>emit('captain:lockAnswer'));
  document.querySelector('#lock-steal')?.addEventListener('click',()=>emit('captain:lockSteal'));
  manageCountdown();
}
function manageCountdown() {
  clearInterval(countdownTimer);
  if (!state?.stealDeadline || !['STEAL','STEAL_LOCKED'].includes(state.phase)) return;
  const node=document.querySelector('#steal-countdown'); if(!node)return;
  const update=()=>{node.textContent=`${Math.max(0,(state.stealDeadline-Date.now())/1000).toFixed(1)}`;}; update(); countdownTimer=setInterval(update,100);
}
function finalScreen(s) {
  const winner=s.scores.A===s.scores.B?'TIE GAME':`${s.teamNames[s.scores.A>s.scores.B?'A':'B']} WINS!`;
  return `<section class="final-stage"><div class="trophy">🏆</div><div class="micro-label">FINAL</div><h2>${esc(winner)}</h2>${scoreCards(s)}</section>`;
}
function render() {
  document.body.dataset.mode=mode;
  document.body.dataset.phase=state?.phase||'NONE';
  document.body.dataset.round=state?.round||'none';
  if (mode==='home') return renderHome();
  if (mode==='display') return renderDisplay();
  if (mode==='host') return renderHostController();
  return renderCaptain();
}

function createDemoTone(duration) {
  const sampleRate=44100; const frames=Math.max(1,Math.floor(duration*sampleRate)); const buffer=new ArrayBuffer(44+frames*2); const view=new DataView(buffer);
  const write=(offset,text)=>[...text].forEach((char,i)=>view.setUint8(offset+i,char.charCodeAt(0)));
  write(0,'RIFF'); view.setUint32(4,36+frames*2,true); write(8,'WAVE'); write(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,sampleRate,true); view.setUint32(28,sampleRate*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true); write(36,'data'); view.setUint32(40,frames*2,true);
  for(let i=0;i<frames;i+=1){const t=i/sampleRate;const pulse=(Math.floor(t*2)%2===0?1:.55);const sample=Math.sin(2*Math.PI*(220+30*Math.sin(t*1.7))*t)*.22*pulse;view.setInt16(44+i*2,Math.max(-1,Math.min(1,sample))*32767,true);}
  if(demoUrl)URL.revokeObjectURL(demoUrl);
  demoUrl=URL.createObjectURL(new Blob([buffer],{type:'audio/wav'}));
  return demoUrl;
}
async function prepareAudio(song) {
  if(!song||mode!=='display')return;
  const key=`${song.id}:${song.audioFile}`;
  if(currentAudioKey===key)return;
  currentAudioKey=key;
  audio.src=song.audioFile; audio.load();
  const ok=await new Promise((resolve)=>{let settled=false;const done=(v)=>{if(settled)return;settled=true;cleanup();resolve(v);};const yes=()=>done(true);const no=()=>done(false);const timer=setTimeout(()=>done(false),1300);const cleanup=()=>{audio.removeEventListener('canplaythrough',yes);audio.removeEventListener('error',no);clearTimeout(timer);};audio.addEventListener('canplaythrough',yes,{once:true});audio.addEventListener('error',no,{once:true});});
  if(!ok){audio.src=createDemoTone(song.duration);audio.load();}
}
function syncAudioForState(){if(mode!=='display'||!state?.song)return;prepareAudio(state.song).then(()=>{if(state.phase!=='PLAYING'&&Math.abs(audio.currentTime-state.listenedSeconds)>.35){try{audio.currentTime=state.listenedSeconds;}catch{}}});}
async function handleAudioPlay({startAt}){
  if(mode!=='display'||!state?.song)return;
  await prepareAudio(state.song);
  try{
    audio.currentTime=Math.min(Number(startAt)||0,state.song.duration||999);
    await audio.play();
    clearInterval(progressTimer);
    progressTimer=setInterval(()=>emit('display:audioProgress',{position:audio.currentTime,paused:audio.paused}),200);
  }catch(error){console.error(error);alert('Playback was blocked. Enable speakers on the game screen.');}
}
function handleAudioPause(){if(mode!=='display')return;audio.pause();clearInterval(progressTimer);emit('display:audioProgress',{position:audio.currentTime,paused:true});}
audio.addEventListener('ended',()=>{clearInterval(progressTimer);if(mode==='display')emit('display:audioProgress',{position:audio.currentTime,paused:true});});

async function restoreSession() {
  if(mode==='display'){
    const saved=JSON.parse(localStorage.getItem('ntt-display')||'null');
    if(saved?.roomCode&&saved?.displayToken){roomCode=saved.roomCode;displayToken=saved.displayToken;hostPin=saved.hostPin||'';connectEvents();render();return;}
  }
  if(mode==='host'&&roomFromPath){
    const saved=JSON.parse(localStorage.getItem(`ntt-host-${roomFromPath}`)||'null');
    if(saved?.hostToken){const result=await api('/api/host/join',saved);if(result?.ok){roomCode=roomFromPath;hostToken=saved.hostToken;state=result.state;connectEvents();render();return;}}
  }
  if(mode==='captain'&&roomFromPath){
    for(const t of ['A','B']){const saved=JSON.parse(localStorage.getItem(`ntt-captain-${roomFromPath}-${t}`)||'null');if(!saved?.captainToken)continue;const result=await api('/api/captain/join',saved);if(result?.ok){roomCode=roomFromPath;team=t;captainToken=saved.captainToken;state=result.state;connectEvents();render();return;}}
  }
  render();
}
restoreSession();