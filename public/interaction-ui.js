const routeParts = location.pathname.split('/').filter(Boolean);
const isCaptainRoute = routeParts[0] === 'join' && routeParts[1];
const isHostRoute = routeParts[0] === 'control' && routeParts[1];

function captainSession() {
  if (!isCaptainRoute) return null;
  const roomCode = String(routeParts[1]).toUpperCase();
  for (const team of ['A', 'B']) {
    try {
      const saved = JSON.parse(localStorage.getItem(`ntt-captain-${roomCode}-${team}`) || 'null');
      if (saved?.captainToken) return { roomCode, team, token: saved.captainToken };
    } catch {}
  }
  return null;
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
  try {
    const response = await fetch('/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, roomCode: session.roomCode, token: session.token, ...(session.team ? { team:session.team } : {}), ...extra })
    });
    const result = await response.json().catch(() => ({ ok:false, error:'BAD_RESPONSE' }));
    return { ...result, ok:Boolean(response.ok && result?.ok) };
  } catch {
    return { ok:false, error:'NETWORK_ERROR' };
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

async function sendHostAction(action, button) {
  const session = hostSession();
  if (!session || button?.disabled) return { ok:false, error:'NO_SESSION' };
  if (button) button.disabled = true;
  const result = await sendAction(session, action);
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
  button.addEventListener('click', () => location.reload());
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
  const shell = document.querySelector('.controller-shell');
  if (activeGame && shell && !existing) shell.appendChild(makeEndGameButton());
  if (!activeGame && existing) existing.remove();
}

if (isHostRoute) {
  document.addEventListener('click', async (event) => {
    const startButton = event.target.closest?.('#host-start');
    if (!startButton) return;

    // START GAME should make song 1 playable immediately. The server still keeps
    // ROUND_INTRO for later difficulty transitions, but the first Easy intro is
    // advanced automatically here in the same host action.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (startButton.disabled) return;
    startButton.disabled = true;

    const started = await sendHostAction('host:start');
    if (!started.ok) {
      if (startButton.isConnected) startButton.disabled = false;
      alert('Could not start the game.');
      return;
    }

    const begun = await sendHostAction('host:beginRound');
    if (!begun.ok && begun.error !== 'NOT_ALLOWED') alert('The game started, but the first round could not be opened automatically.');
  }, true);
}

if (isCaptainRoute || isHostRoute) {
  const syncControls = () => {
    syncCaptainControls();
    syncHostControls();
  };
  const observer = new MutationObserver(syncControls);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-phase', 'data-connection', 'disabled'] });
  syncControls();
  window.addEventListener('beforeunload', () => observer.disconnect());
}
