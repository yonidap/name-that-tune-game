const isDisplayRoute = location.pathname.replace(/\/+$/, '') === '/host';

if (isDisplayRoute) {
  const gameAudio = document.querySelector('#game-audio');
  const revealAudio = document.createElement('audio');
  revealAudio.id = 'reveal-audio';
  revealAudio.preload = 'auto';
  revealAudio.playsInline = true;
  revealAudio.hidden = true;
  document.body.appendChild(revealAudio);

  const REVEAL_FADE_IN_SECONDS = 0.5;
  const REVEAL_FADE_OUT_SECONDS = 3;
  let lastRevealFilename = '';
  let revealRetryTimer = null;
  let revealAdvancePending = false;
  let revealFadeFrame = null;
  let silentUnlockUrl = '';

  function createSilentUnlockUrl() {
    if (silentUnlockUrl) return silentUnlockUrl;
    const sampleRate = 8000;
    const frames = Math.floor(sampleRate * 0.06);
    const buffer = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(buffer);
    const write = (offset, text) => [...text].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
    write(0, 'RIFF');
    view.setUint32(4, 36 + frames * 2, true);
    write(8, 'WAVE');
    write(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, 'data');
    view.setUint32(40, frames * 2, true);
    silentUnlockUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    return silentUnlockUrl;
  }

  function currentSnippetFilename() {
    if (!gameAudio) return '';
    const source = gameAudio.getAttribute('src') || gameAudio.currentSrc || '';
    if (!source || source.startsWith('blob:')) return '';
    try {
      const pathname = new URL(source, location.href).pathname;
      const filename = decodeURIComponent(pathname.split('/').pop() || '');
      return filename.toLowerCase().endsWith('.mp3') ? filename : '';
    } catch {
      return '';
    }
  }

  function displaySession() {
    try {
      const saved = JSON.parse(localStorage.getItem('ntt-display') || 'null');
      if (!saved?.roomCode || !saved?.displayToken) return null;
      return saved;
    } catch {
      return null;
    }
  }

  function stopRevealFade() {
    if (revealFadeFrame !== null) cancelAnimationFrame(revealFadeFrame);
    revealFadeFrame = null;
  }

  function updateRevealFade() {
    if (revealAudio.paused || revealAudio.ended || document.body.dataset.phase !== 'REVEAL') {
      stopRevealFade();
      return;
    }
    const duration = Number(revealAudio.duration);
    const currentTime = Math.max(0, Number(revealAudio.currentTime) || 0);
    const fadeIn = Math.min(1, currentTime / REVEAL_FADE_IN_SECONDS);
    let fadeOut = 1;
    if (Number.isFinite(duration) && duration > 0) {
      fadeOut = Math.min(1, Math.max(0, duration - currentTime) / REVEAL_FADE_OUT_SECONDS);
    }
    revealAudio.volume = Math.max(0, Math.min(1, fadeIn, fadeOut));
    revealFadeFrame = requestAnimationFrame(updateRevealFade);
  }

  function startRevealFade() {
    stopRevealFade();
    revealAudio.volume = 0;
    revealFadeFrame = requestAnimationFrame(updateRevealFade);
  }

  function stopRevealAudio({ resetKey = true } = {}) {
    clearTimeout(revealRetryTimer);
    revealRetryTimer = null;
    stopRevealFade();
    revealAudio.pause();
    revealAudio.volume = 1;
    try { revealAudio.currentTime = 0; } catch {}
    revealAudio.removeAttribute('src');
    revealAudio.load();
    document.body.dataset.revealAudio = 'idle';
    revealAdvancePending = false;
    if (resetKey) lastRevealFilename = '';
  }

  async function advanceAfterReveal(filename) {
    if (revealAdvancePending || document.body.dataset.phase !== 'REVEAL' || !filename) return;
    const saved = displaySession();
    if (!saved) return;
    revealAdvancePending = true;
    try {
      const response = await fetch('/api/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'display:revealEnded', roomCode: saved.roomCode, token: saved.displayToken, filename })
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) {
        revealAdvancePending = false;
        console.warn('Could not auto-advance after reveal audio.', result);
      }
    } catch (error) {
      revealAdvancePending = false;
      console.warn('Could not auto-advance after reveal audio.', error);
    }
  }

  function playRevealAudio(attempt = 0) {
    if (document.body.dataset.phase !== 'REVEAL') return;
    const filename = currentSnippetFilename();
    if (!filename) {
      if (attempt < 20) revealRetryTimer = setTimeout(() => playRevealAudio(attempt + 1), 100);
      return;
    }
    if (lastRevealFilename === filename) return;

    lastRevealFilename = filename;
    revealAdvancePending = false;
    clearTimeout(revealRetryTimer);
    revealRetryTimer = null;

    revealAudio.src = `/audio/reveal/${encodeURIComponent(filename)}`;
    revealAudio.currentTime = 0;
    revealAudio.volume = 0;
    document.body.dataset.revealAudio = 'loading';

    const playPromise = revealAudio.play();
    if (!playPromise?.then) return;
    playPromise.then(() => {
      if (document.body.dataset.phase !== 'REVEAL' || lastRevealFilename !== filename) {
        stopRevealAudio({ resetKey: false });
        return;
      }
      document.body.dataset.revealAudio = 'playing';
      startRevealFade();
    }).catch((error) => {
      if (document.body.dataset.phase === 'REVEAL' && lastRevealFilename === filename) {
        document.body.dataset.revealAudio = 'missing';
        console.warn(`Reveal audio unavailable: /audio/reveal/${filename}`, error);
      }
    });
  }

  function syncRevealAudio() {
    if (document.body.dataset.phase === 'REVEAL') playRevealAudio();
    else stopRevealAudio();
  }

  document.addEventListener('click', (event) => {
    if (!event.target.closest?.('#enable-audio')) return;
    revealAudio.src = createSilentUnlockUrl();
    revealAudio.currentTime = 0;
    revealAudio.volume = 1;
    const unlock = revealAudio.play();
    unlock?.then(() => {
      revealAudio.pause();
      revealAudio.currentTime = 0;
      revealAudio.removeAttribute('src');
      revealAudio.load();
    }).catch(() => {});
  }, true);

  revealAudio.addEventListener('ended', () => {
    stopRevealFade();
    revealAudio.volume = 1;
    if (document.body.dataset.phase !== 'REVEAL' || !lastRevealFilename) return;
    document.body.dataset.revealAudio = 'ended';
    advanceAfterReveal(lastRevealFilename);
  });

  revealAudio.addEventListener('error', () => {
    stopRevealFade();
    revealAudio.volume = 1;
    if (document.body.dataset.phase === 'REVEAL' && lastRevealFilename) document.body.dataset.revealAudio = 'missing';
  });

  const observer = new MutationObserver(syncRevealAudio);
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-phase'] });
  syncRevealAudio();

  window.addEventListener('beforeunload', () => {
    observer.disconnect();
    stopRevealAudio();
    if (silentUnlockUrl) URL.revokeObjectURL(silentUnlockUrl);
  });
}
