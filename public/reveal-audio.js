const isDisplayRoute = location.pathname.replace(/\/+$/, '') === '/host';

if (isDisplayRoute) {
  const gameAudio = document.querySelector('#game-audio');
  const revealAudio = document.createElement('audio');
  revealAudio.id = 'reveal-audio';
  revealAudio.preload = 'auto';
  revealAudio.playsInline = true;
  revealAudio.hidden = true;
  document.body.appendChild(revealAudio);

  let lastRevealFilename = '';
  let revealStopTimer = null;
  let revealRetryTimer = null;
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

  function stopRevealAudio({ resetKey = true } = {}) {
    clearTimeout(revealStopTimer);
    clearTimeout(revealRetryTimer);
    revealStopTimer = null;
    revealRetryTimer = null;
    revealAudio.pause();
    try { revealAudio.currentTime = 0; } catch {}
    revealAudio.removeAttribute('src');
    revealAudio.load();
    document.body.dataset.revealAudio = 'idle';
    if (resetKey) lastRevealFilename = '';
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
    clearTimeout(revealStopTimer);
    clearTimeout(revealRetryTimer);
    revealRetryTimer = null;

    const gameplayDuration = gameAudio && Number.isFinite(gameAudio.duration) && gameAudio.duration > 0
      ? gameAudio.duration
      : 0;

    revealAudio.src = `/audio/reveal/${encodeURIComponent(filename)}`;
    revealAudio.currentTime = 0;
    revealAudio.volume = 1;
    document.body.dataset.revealAudio = 'loading';

    const playPromise = revealAudio.play();
    if (!playPromise?.then) return;
    playPromise.then(() => {
      if (document.body.dataset.phase !== 'REVEAL' || lastRevealFilename !== filename) {
        stopRevealAudio({ resetKey: false });
        return;
      }
      document.body.dataset.revealAudio = 'playing';
      if (gameplayDuration > 0) {
        revealStopTimer = setTimeout(() => {
          if (document.body.dataset.phase === 'REVEAL' && lastRevealFilename === filename) {
            revealAudio.pause();
            document.body.dataset.revealAudio = 'ended';
          }
        }, gameplayDuration * 1000 + 50);
      }
    }).catch((error) => {
      document.body.dataset.revealAudio = 'missing';
      console.warn(`Reveal audio unavailable: /audio/reveal/${filename}`, error);
    });
  }

  function syncRevealAudio() {
    if (document.body.dataset.phase === 'REVEAL') {
      playRevealAudio();
    } else {
      stopRevealAudio();
    }
  }

  document.addEventListener('click', (event) => {
    if (!event.target.closest?.('#enable-audio')) return;
    revealAudio.src = createSilentUnlockUrl();
    revealAudio.currentTime = 0;
    const unlock = revealAudio.play();
    unlock?.then(() => {
      revealAudio.pause();
      revealAudio.currentTime = 0;
      revealAudio.removeAttribute('src');
      revealAudio.load();
    }).catch(() => {});
  }, true);

  revealAudio.addEventListener('ended', () => {
    clearTimeout(revealStopTimer);
    revealStopTimer = null;
    if (document.body.dataset.phase === 'REVEAL') document.body.dataset.revealAudio = 'ended';
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
