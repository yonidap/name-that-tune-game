const routeParts = location.pathname.split('/').filter(Boolean);
const isCaptainRoute = routeParts[0] === 'join' && routeParts[1];

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

async function sendCaptainAction(action, button) {
  const session = captainSession();
  if (!session || button?.disabled) return;
  if (button) button.disabled = true;
  try {
    const response = await fetch('/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, roomCode: session.roomCode, team: session.team, token: session.token })
    });
    if (!response.ok && button?.isConnected) button.disabled = false;
  } catch {
    if (button?.isConnected) button.disabled = false;
  }
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
}

if (isCaptainRoute) {
  const observer = new MutationObserver(syncCaptainControls);
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-phase', 'disabled'] });
  syncCaptainControls();
  window.addEventListener('beforeunload', () => observer.disconnect());
}
