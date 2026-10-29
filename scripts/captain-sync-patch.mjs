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

// Regression test: Team A can recover current READY state even if its SSE client is stale/ignored.
{
  const file = 'test/captain-live-sync.test.js';
  const content = `import assert from 'node:assert/strict';\nimport http from 'node:http';\nimport fs from 'node:fs';\nimport { createServer } from '../src/server.js';\n\nconst server = createServer();\nawait new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));\nconst base = \\`http://127.0.0.1:\\${server.address().port}\\`;\nconst streams = [];\nasync function post(route, body) {\n  const response = await fetch(base + route, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });\n  return { status:response.status, body:await response.json() };\n}\nfunction sse({ room, role, token, team }) {\n  return new Promise((resolve, reject) => {\n    const params = new URLSearchParams({ room, role, token }); if (team) params.set('team', team);\n    const req = http.get(base + '/events?' + params, (res) => {\n      if (res.statusCode !== 200) return reject(new Error('SSE ' + res.statusCode));\n      res.once('data', () => resolve({ req, res }));\n      res.on('data', () => {});\n    });\n    req.on('error', reject);\n  });\n}\ntry {\n  const created = await post('/api/display/create', { gameLength:'short' });\n  const { roomCode, displayToken, hostPin } = created.body;\n  const host = await post('/api/host/join', { roomCode, hostPin });\n  const a = await post('/api/captain/join', { roomCode, team:'A' });\n  const b = await post('/api/captain/join', { roomCode, team:'B' });\n  streams.push(await sse({ room:roomCode, role:'display', token:displayToken }));\n  streams.push(await sse({ room:roomCode, role:'host', token:host.body.hostToken }));\n  const staleA = await sse({ room:roomCode, role:'captain', team:'A', token:a.body.captainToken }); streams.push(staleA);\n  streams.push(await sse({ room:roomCode, role:'captain', team:'B', token:b.body.captainToken }));\n  await post('/api/action', { action:'display:audioReady', roomCode, token:displayToken, ready:true });\n  const started = await post('/api/action', { action:'host:start', roomCode, token:host.body.hostToken });\n  assert.equal(started.status, 200);\n\n  const polledA = await post('/api/state', { roomCode, role:'captain', team:'A', token:a.body.captainToken });\n  assert.equal(polledA.status, 200);\n  assert.equal(polledA.body.state.phase, 'READY');\n  assert.equal(polledA.body.state.activeTeam, 'A');\n\n  let oldClosed = false; staleA.res.once('close', () => { oldClosed = true; });\n  const reconnected = await post('/api/captain/join', { roomCode, team:'A', captainToken:a.body.captainToken, forceReconnect:true });\n  assert.equal(reconnected.status, 200);\n  assert.equal(reconnected.body.state.phase, 'READY');\n  await new Promise((resolve) => setTimeout(resolve, 30));\n  assert.equal(oldClosed, true, 'force reconnect must close the stale captain SSE');\n\n  const client = fs.readFileSync('public/game.js', 'utf8');\n  assert.match(client, /setInterval\\(pollAuthoritativeState, 1500\\)/);\n  assert.match(client, /ntt:captain-reconnected/);\n  const interaction = fs.readFileSync('public/interaction-ui.js', 'utf8');\n  assert.match(interaction, /forceReconnect:true/);\n  assert.doesNotMatch(interaction, /result\\.captainToken[\\s\\S]{0,500}location\\.reload\\(\\)/);\n  console.log('Captain live-sync recovery audit passed');\n} finally {\n  for (const stream of streams) { try { stream.req.destroy(); } catch {} }\n  await new Promise((resolve) => server.close(resolve));\n}\n`;
  fs.writeFileSync(file, content);
}

{
  const file = 'package.json';
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!pkg.scripts.check.includes('test/captain-live-sync.test.js')) pkg.scripts.check += ' && node --check test/captain-live-sync.test.js';
  if (!pkg.scripts.test.includes('test/captain-live-sync.test.js')) pkg.scripts.test += ' && node test/captain-live-sync.test.js';
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}

console.log('Captain live-sync patch applied.');
