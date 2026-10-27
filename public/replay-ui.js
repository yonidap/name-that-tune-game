(() => {
  const audio = document.querySelector('#game-audio');
  const parts = location.pathname.split('/').filter(Boolean);
  const mode = parts[0] === 'host' ? 'display' : parts[0] === 'control' ? 'host' : parts[0] === 'join' ? 'captain' : 'home';
  const roomFromPath = parts[1]?.toUpperCase() || '';

  let source = null;
  let latest = null;
  let sessionKey = '';

  function getSession() {
    if (mode === 'display') {
      const saved = JSON.parse(localStorage.getItem('ntt-display') || 'null');
      if (!saved?.roomCode || !saved?.displayToken) return null;
      return { roomCode: saved.roomCode, role: 'display', token: saved.displayToken, team: null };
    }
    if (mode === 'host' && roomFromPath) {
      const saved = JSON.parse(localStorage.getItem(`ntt-host-${roomFromPath}`) || 'null');
      if (!saved?.hostToken) return null;
      return { roomCode: roomFromPath, role: 'host', token: saved.hostToken, team: null };
    }
    if (mode === 'captain' && roomFromPath) {
      for (const team of ['A', 'B']) {
        const saved = JSON.parse(localStorage.getItem(`ntt-captain-${roomFromPath}-${team}`) || 'null');
        if (saved?.captainToken) return { roomCode: roomFromPath, role: 'captain', token: saved.captainToken, team };
      }
    }
    return null;
  }

  function action(action, payload = {}) {
    const session = getSession();
    if (!session) return Promise.resolve();
    return fetch('/api/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, roomCode: session.roomCode, token: session.token, team: session.team, ...payload })
    }).catch(() => {});
  }

  function ensureConnection() {
    const session = getSession();
    if (!session || mode === 'home') return;
    const key = `${session.role}:${session.roomCode}:${session.team || ''}:${session.token}`;
    if (source && key === sessionKey) return;
    source?.close();
    sessionKey = key;
    const params = new URLSearchParams({ room: session.roomCode, role: session.role, token: session.token });
    if (session.team) params.set('team', session.team);
    source = new EventSource(`/events?${params}`);
    source.addEventListener('state', (event) => {
      latest = JSON.parse(event.data);
      requestAnimationFrame(applyUi);
    });
  }

  function applyUi() {
    if (!latest) return;
    const points = latest.phase?.startsWith('STEAL') ? 1 : Number(latest.currentPoints || 0);

    document.querySelectorAll('.points').forEach((node) => {
      node.setAttribute('aria-label', `${points} points`);
      node.innerHTML = Array.from({ length: 10 }, (_, i) => `<span class="${i < points ? 'on' : ''}">★</span>`).join('');
    });

    const maxExposure = Number(latest.duration || 0) * 2;
    const exposure = Number(latest.totalHeardSeconds || 0);
    const progress = maxExposure > 0 ? Math.min(100, (exposure / maxExposure) * 100) : 0;
    document.querySelectorAll('.meter > div').forEach((bar) => { bar.style.width = `${progress}%`; });

    const used = Math.min(2, Number(latest.playbacksCompleted || 0));
    document.querySelectorAll('.heard').forEach((node) => {
      node.textContent = `${exposure.toFixed(1)}s total · ${used}/2 full plays used`;
    });

    if (mode === 'captain') {
      const button = document.querySelector('#play-pause');
      if (button) {
        const session = getSession();
        const myTurn = session?.team && latest.activeTeam === session.team;
        if (latest.phase === 'PLAYING' && myTurn) {
          button.disabled = false;
          button.textContent = '■ STOP';
        } else if (myTurn && ['READY', 'PAUSED'].includes(latest.phase)) {
          if (!latest.canPlay || used >= 2) {
            button.disabled = true;
            button.textContent = 'AUDIO USED · LOCK ANSWER';
          } else if (used === 1 && Number(latest.listenedSeconds || 0) >= Number(latest.duration || 0) - 0.05) {
            button.disabled = false;
            button.textContent = '↻ REPLAY · LAST PLAY';
          } else {
            button.disabled = false;
            button.textContent = Number(latest.listenedSeconds || 0) > 0 ? '▶ HEAR MORE' : '▶ PLAY';
          }
        }
      }
    }

    if (mode === 'display') {
      const phaseCall = document.querySelector('.phase-call');
      if (phaseCall && latest.phase === 'PAUSED') {
        if (used >= 2) phaseCall.textContent = 'AUDIO USED · LOCK ANSWER';
        else if (used === 1 && Number(latest.listenedSeconds || 0) >= Number(latest.duration || 0) - 0.05) phaseCall.textContent = '↻ ONE REPLAY LEFT';
      }
    }

    const judgeValue = document.querySelector('.judge-value');
    if (judgeValue && mode === 'host' && !latest.phase?.startsWith('STEAL')) {
      judgeValue.innerHTML = `<span>${latest.currentPoints}</span> pts · ${exposure.toFixed(1)}s total · ${used}/2 plays`;
    }
  }

  if (audio && mode === 'display') {
    audio.addEventListener('ended', () => action('display:audioEnded', { position: audio.currentTime }));
  }

  const observer = new MutationObserver(() => {
    ensureConnection();
    requestAnimationFrame(applyUi);
  });
  observer.observe(document.querySelector('#app'), { childList: true, subtree: true });
  setInterval(ensureConnection, 750);
  ensureConnection();
})();
