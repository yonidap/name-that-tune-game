const routeParts = location.pathname.split('/').filter(Boolean);
const isCaptainRoute = routeParts[0] === 'join' && routeParts[1];
const isHostRoute = routeParts[0] === 'control' && routeParts[1];
function captainSession() {
  if (!isCaptainRoute) return null;
  const roomCode = String(routeParts[1]).toUpperCase();
  const activeTeam = localStorage.getItem(`ntt-captain-active-${roomCode}`);
  const read = (team) => {
    try {
      const saved = JSON.parse(localStorage.getItem(`ntt-captain-${roomCode}-${team}`) || 'null');
      return saved?.captainToken ? { roomCode, team, token:saved.captainToken } : null;
    } catch { return null; }
  };
  if (['A','B'].includes(activeTeam)) return read(activeTeam);
  const sessions = ['A','B'].map(read).filter(Boolean);
  return sessions.length === 1 ? sessions[0] : null;
}

function hostSession() {
  if (!isHostRoute) return null;
  const roomCode = String(routeParts[1]).toUpperCase();
  try {
    const saved = JSON.parse(localStorage.getItem(`ntt-host-${roomCode}`) || 'null');
    if (saved?.hostToken) return { roomCode, token: saved.hostToken };
  } catch {}
  return null;
}

async function sendAction(session, action, extra = {}) {
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

async function sendCaptainAction(action, button) {
  const session = captainSession();
  if (!session || button?.disabled) return;
  if (button) button.disabled = true;
  const result = await sendAction(session, action);
  if (!result.ok && button?.isConnected) button.disabled = false;
  return result;
}

async function sendHostAction(action, button, extra = {}) {
  const session = hostSession();
  if (!session || button?.disabled) return { ok:false, error:'NO_SESSION' };
  if (button) button.disabled = true;
  const result = await sendAction(session, action, extra);
  if (!result.ok && button?.isConnected) button.disabled = false;
  return result;
}

function makeDontKnowButton(id, disabled) {
  const button = document.createElement('button');
  button.id = id;
  button.className = 'dont-know-btn';
  button.type = 'button';
  button.disabled = disabled;
  button.textContent = "? I DON'T KNOW";
  button.addEventListener('click', () => sendCaptainAction('captain:dontKnow', button));
  return button;
}

async function reconnectCaptain(button) {
  const session = captainSession();
  if (!session) {
    window.dispatchEvent(new CustomEvent('ntt:captain-reconnect-request'));
    return;
  }
  if (button) button.disabled = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch('/api/captain/join', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ roomCode:session.roomCode, team:session.team, captainToken:session.token, forceReconnect:true }),
      signal:controller.signal
    });
    const result = await response.json().catch(() => ({ ok:false, error:'BAD_RESPONSE' }));
    if (response.ok && result?.ok && result.captainToken) {
      localStorage.setItem(`ntt-captain-${session.roomCode}-${session.team}`, JSON.stringify({ roomCode:session.roomCode, team:session.team, captainToken:result.captainToken }));
      localStorage.setItem(`ntt-captain-active-${session.roomCode}`, session.team);
      window.dispatchEvent(new CustomEvent('ntt:captain-reconnected', { detail:{ roomCode:session.roomCode, team:session.team, captainToken:result.captainToken, state:result.state } }));
      return;
    }
    if (button?.isConnected) button.disabled = false;
    if (result?.error === 'TEAM_TAKEN') alert('That team is already connected from another phone.');
    else alert('Could not reconnect. Check the connection and try again.');
  } catch {
    if (button?.isConnected) button.disabled = false;
    alert('Could not reconnect. Check the connection and try again.');
  } finally {
    clearTimeout(timeout);
  }
}

function makeReconnectButton() {
  const button = document.createElement('button');
  button.id = 'captain-reconnect';
  button.className = 'secondary-control';
  button.type = 'button';
  button.textContent = '↻ RECONNECT';
  button.style.width = '100%';
  button.style.minHeight = '58px';
  button.style.borderColor = 'var(--cyan)';
  button.style.color = 'var(--cyan)';
  button.addEventListener('click', () => reconnectCaptain(button));
  return button;
}

function makeEndGameButton() {
  const button = document.createElement('button');
  button.id = 'end-game';
  button.className = 'secondary-control';
  button.type = 'button';
  button.textContent = '■ END GAME';
  button.style.width = '100%';
  button.style.minHeight = '58px';
  button.style.borderColor = 'var(--red)';
  button.style.color = 'var(--red)';
  button.style.background = 'rgba(255,54,95,.08)';
  button.addEventListener('click', async () => {
    if (!confirm('End the game now and show the final score?')) return;
    const result = await sendHostAction('host:endGame', button);
    if (!result?.ok && button.isConnected) {
      button.disabled = false;
      alert('Could not end the game.');
    }
  });
  return button;
}

function makeFinalHostTools() {
  const section = document.createElement('section');
  section.id = 'final-host-tools';
  section.className = 'controller-card final-host-tools';
  section.innerHTML = `<div class="micro-label">FINAL SCORE TOOLS</div><div class="controller-actions"><button class="secondary-control" id="final-undo">UNDO LAST</button></div><details class="score-tools" open><summary>SCORE CORRECTION</summary><div class="score-adjust"><button data-final-score="A" data-delta="-1">A −1</button><button data-final-score="A" data-delta="1">A +1</button><button data-final-score="B" data-delta="-1">B −1</button><button data-final-score="B" data-delta="1">B +1</button></div></details>`;
  section.querySelector('#final-undo')?.addEventListener('click', (event) => sendHostAction('host:undo', event.currentTarget));
  section.querySelectorAll('[data-final-score]').forEach((button) => button.addEventListener('click', () => sendHostAction('host:adjustScore', button, { team:button.dataset.finalScore, delta:Number(button.dataset.delta) })));
  return section;
}

function syncCaptainControls() {
  if (!isCaptainRoute) return;
  const phase = document.body.dataset.phase || '';
  const normalLock = document.querySelector('#lock-answer');
  if (normalLock && !document.querySelector('#dont-know')) {
    normalLock.insertAdjacentElement('afterend', makeDontKnowButton('dont-know', normalLock.disabled));
  } else if (normalLock) {
    document.querySelector('#dont-know').disabled = normalLock.disabled;
  }

  const stealLock = document.querySelector('#lock-steal');
  if (stealLock && !document.querySelector('#dont-know-steal')) {
    stealLock.insertAdjacentElement('afterend', makeDontKnowButton('dont-know-steal', phase !== 'STEAL'));
  } else if (stealLock) {
    document.querySelector('#dont-know-steal').disabled = phase !== 'STEAL';
  }

  if (phase === 'STEAL_LOCKED') {
    const countdown = document.querySelector('#steal-countdown');
    if (countdown) {
      countdown.textContent = 'LOCKED';
      countdown.classList.add('locked');
    }
  }

  const offline = document.body.dataset.connection === 'offline';
  const reconnect = document.querySelector('#captain-reconnect');
  const shell = document.querySelector('.captain-shell');
  if (offline && shell && !reconnect) shell.appendChild(makeReconnectButton());
  if (!offline && reconnect) reconnect.remove();
}


function syncHostControls() {
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

if (isCaptainRoute || isHostRoute) {
  const syncControls = () => {
    syncCaptainControls();
    syncHostControls();
  };
  const observer = new MutationObserver(syncControls);
  observer.observe(document.documentElement, { subtree:true, childList:true, attributes:true, attributeFilter:['data-phase','data-round','data-connection','disabled'] });
  syncControls();
  window.addEventListener('beforeunload', () => {
    observer.disconnect();
  });
}
