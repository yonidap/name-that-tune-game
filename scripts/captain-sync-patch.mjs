import fs from 'node:fs';

function replaceOnce(text, oldText, newText, label) {
  if (!text.includes(oldText)) throw new Error(`${label}: source block not found`);
  return text.replace(oldText, newText);
}

// Server: authenticated state snapshots + force reconnect that closes zombie SSE clients.
{
  const file = 'src/server.js';
  let s = fs.readFileSync(file, 'utf8');

  s = replaceOnce(
    s,
    "    if (body.captainToken && room.captainTokens[team] === body.captainToken) return json(res, 200, { ok: true, captainToken: body.captainToken, state: publicState(room, 'captain', team) });",
    "    if (body.captainToken && room.captainTokens[team] === body.captainToken) {\n      if (body.forceReconnect) { closeCaptainClients(room, team); broadcastState(room); }\n      return json(res, 200, { ok: true, captainToken: body.captainToken, state: publicState(room, 'captain', team) });\n    }",
    'captain force reconnect'
  );

  s = replaceOnce(
    s,
    "\n  if (url.pathname !== '/api/action') return json(res, 404, { ok: false, error: 'NOT_FOUND' });\n  const room = roomOrError(body.roomCode, res); if (!room) return;\n",
    "\n  if (url.pathname === '/api/state') {\n    const room = roomOrError(body.roomCode, res); if (!room) return;\n    const role = String(body.role || '');\n    const team = body.team;\n    if (role === 'display' && !displayOk(room, body.token)) return json(res, 403, { ok: false, error: 'UNAUTHORIZED' });\n    if (role === 'host' && !hostOk(room, body.token)) return json(res, 403, { ok: false, error: 'UNAUTHORIZED' });\n    if (role === 'captain' && !captainOk(room, team, body.token)) return json(res, 403, { ok: false, error: 'UNAUTHORIZED' });\n    if (!['display', 'host', 'captain'].includes(role)) return json(res, 400, { ok: false, error: 'INVALID_ROLE' });\n    touch(room);\n    return json(res, 200, { ok: true, state: publicState(room, role, role === 'captain' ? team : null) });\n  }\n\n  if (url.pathname !== '/api/action') return json(res, 404, { ok: false, error: 'NOT_FOUND' });\n  const room = roomOrError(body.roomCode, res); if (!room) return;\n",
    'authenticated state snapshot endpoint'
  );

  fs.writeFileSync(file, s);
}

// Browser: apply state from either SSE or polling, so one broken EventSource cannot freeze a phone.
{
  const file = 'public/game.js';
  let s = fs.readFileSync(file, 'utf8');

  s = replaceOnce(
    s,
    "let playbackCommandGeneration = 0;\n",
    "let playbackCommandGeneration = 0;\nlet statePollTimer = null;\nlet statePollInFlight = false;\n",
    'state polling globals'
  );

  const oldConnect = `function connectEvents() {\n  const token = mode === 'display' ? displayToken : mode === 'host' ? hostToken : captainToken;\n  if (!roomCode || !token || mode === 'home') return;\n  eventSource?.close();\n  const params = new URLSearchParams({ room:roomCode, role:mode, token });\n  if (mode === 'captain') params.set('team', team);\n  eventSource = new EventSource(\`/events?\${params}\`);\n  eventSource.onopen = () => {\n    document.body.dataset.connection = 'online';\n    if (mode === 'display' && audioUnlocked) emit('display:audioReady', { ready:true });\n  };\n  eventSource.onerror = () => { document.body.dataset.connection = 'offline'; };\n  eventSource.addEventListener('state', (event) => {\n    const previous = state;\n    const next = JSON.parse(event.data);\n    if (mode === 'display' && previous) {\n      const leftPlayback = next.phase !== 'PLAYING' && (previous.phase === 'PLAYING' || activePlaybackSeq);\n      const changedSong = previous.currentIndex !== next.currentIndex;\n      if (leftPlayback || changedSong) {\n        playbackCommandGeneration += 1;\n        audio.pause();\n        clearInterval(progressTimer); progressTimer = null;\n        activePlaybackSeq = 0;\n      }\n    }\n    const patch = canPatchLive(previous, next);\n    state = next;\n    roomCode = state.roomCode;\n    if (patch) updateLiveUi(); else render();\n  });\n  if (mode === 'display') {\n    eventSource.addEventListener('audio-play', (event) => handleAudioPlay(JSON.parse(event.data)));\n    eventSource.addEventListener('audio-pause', (event) => handleAudioPause(JSON.parse(event.data || '{}')));\n  }\n}`;

  const newConnect = `function applyAuthoritativeState(next) {\n  if (!next) return;\n  const previous = state;\n  if (mode === 'display' && previous) {\n    const leftPlayback = next.phase !== 'PLAYING' && (previous.phase === 'PLAYING' || activePlaybackSeq);\n    const changedSong = previous.currentIndex !== next.currentIndex;\n    if (leftPlayback || changedSong) {\n      playbackCommandGeneration += 1;\n      audio.pause();\n      clearInterval(progressTimer); progressTimer = null;\n      activePlaybackSeq = 0;\n    }\n  }\n  const patch = canPatchLive(previous, next);\n  state = next;\n  roomCode = state.roomCode;\n  if (patch) updateLiveUi(); else render();\n}\nfunction stateSessionPayload() {\n  const token = mode === 'display' ? displayToken : mode === 'host' ? hostToken : captainToken;\n  if (!roomCode || !token || mode === 'home') return null;\n  return { roomCode, role:mode, token, ...(mode === 'captain' ? { team } : {}) };\n}\nasync function pollAuthoritativeState() {\n  const payload = stateSessionPayload();\n  if (!payload || statePollInFlight) return;\n  statePollInFlight = true;\n  try {\n    const result = await api('/api/state', payload);\n    if (result?.ok && result.state) applyAuthoritativeState(result.state);\n  } finally {\n    statePollInFlight = false;\n  }\n}\nfunction startStatePolling() {\n  clearInterval(statePollTimer);\n  statePollTimer = null;\n  if (!stateSessionPayload()) return;\n  setTimeout(() => pollAuthoritativeState(), 250);\n  statePollTimer = setInterval(pollAuthoritativeState, 1500);\n}\nfunction connectEvents() {\n  const token = mode === 'display' ? displayToken : mode === 'host' ? hostToken : captainToken;\n  if (!roomCode || !token || mode === 'home') return;\n  eventSource?.close();\n  const params = new URLSearchParams({ room:roomCode, role:mode, token });\n  if (mode === 'captain') params.set('team', team);\n  eventSource = new EventSource(\`/events?\${params}\`);\n  eventSource.onopen = () => {\n    document.body.dataset.connection = 'online';\n    if (mode === 'display' && audioUnlocked) emit('display:audioReady', { ready:true });\n  };\n  eventSource.onerror = () => {\n    document.body.dataset.connection = 'offline';\n    pollAuthoritativeState();\n  };\n  eventSource.addEventListener('state', (event) => applyAuthoritativeState(JSON.parse(event.data)));\n  if (mode === 'display') {\n    eventSource.addEventListener('audio-play', (event) => handleAudioPlay(JSON.parse(event.data)));\n    eventSource.addEventListener('audio-pause', (event) => handleAudioPause(JSON.parse(event.data || '{}')));\n  }\n  startStatePolling();\n}`;

  s = replaceOnce(s, oldConnect, newConnect, 'dual SSE + polling state sync');

  s = replaceOnce(
    s,
    "  eventSource?.close();\n  eventSource = null;\n",
    "  eventSource?.close();\n  eventSource = null;\n  clearInterval(statePollTimer); statePollTimer = null;\n",
    'clear polling with display session'
  );

  s = replaceOnce(
    s,
    "\nfunction startDisplayKeepAlive() {",
    "\nwindow.addEventListener('ntt:captain-reconnected', (event) => {\n  if (mode !== 'captain') return;\n  const detail = event.detail || {};\n  if (!detail.roomCode || !['A','B'].includes(detail.team) || !detail.captainToken || !detail.state) return;\n  roomCode = detail.roomCode; team = detail.team; captainToken = detail.captainToken; state = detail.state;\n  finishRestore(); saveCaptain(); connectEvents(); render();\n});\n\nfunction startDisplayKeepAlive() {",
    'in-place captain reconnect event'
  );

  fs.writeFileSync(file, s);
}

// Reconnect control: no reload/black screen; force-close a zombie server SSE then rebind in place.
{
  const file = 'public/interaction-ui.js';
  let s = fs.readFileSync(file, 'utf8');
  s = replaceOnce(
    s,
    "      body:JSON.stringify({ roomCode:session.roomCode, team:session.team, captainToken:session.token }),",
    "      body:JSON.stringify({ roomCode:session.roomCode, team:session.team, captainToken:session.token, forceReconnect:true }),",
    'force reconnect request'
  );
  s = replaceOnce(
    s,
    "      location.reload();\n      return;",
    "      window.dispatchEvent(new CustomEvent('ntt:captain-reconnected', { detail:{ roomCode:session.roomCode, team:session.team, captainToken:result.captainToken, state:result.state } }));\n      return;",
    'reconnect without reload'
  );
  fs.writeFileSync(file, s);
}

{
  const file = 'package.json';
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!pkg.scripts.check.includes('test/captain-live-sync.test.js')) pkg.scripts.check += ' && node --check test/captain-live-sync.test.js';
  if (!pkg.scripts.test.includes('test/captain-live-sync.test.js')) pkg.scripts.test += ' && node test/captain-live-sync.test.js';
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}

console.log('Captain live-sync patch applied.');
