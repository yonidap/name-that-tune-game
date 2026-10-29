import fs from 'node:fs';

function replaceOnce(text, oldText, newText, label) {
  if (!text.includes(oldText)) throw new Error(`${label}: source block not found`);
  return text.replace(oldText, newText);
}

{
  const file = 'src/server.js';
  let s = fs.readFileSync(file, 'utf8');

  s = replaceOnce(
    s,
    "const GAME_STATE_FILE = String(process.env.GAME_STATE_FILE || '').trim();\nconst rooms = new Map();",
    "const GAME_STATE_FILE = String(process.env.GAME_STATE_FILE || '').trim();\nconst BUILD_ID = String(process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'dev').slice(0, 12);\nconst INSTANCE_ID = crypto.randomBytes(4).toString('hex');\nconst PRESENCE_MS = 10_000;\nconst rooms = new Map();",
    'server identity constants'
  );

  s = replaceOnce(
    s,
    "    history: Array.isArray(saved.history) ? saved.history.slice(-40) : [],\n    clients: new Set(), stealTimer: null, audioReady: false",
    "    history: Array.isArray(saved.history) ? saved.history.slice(-40) : [],\n    revision: Math.max(0, Number(saved.revision) || 0),\n    lastSeen: { display:null, host:null, A:null, B:null },\n    clients: new Set(), stealTimer: null, audioReady: false",
    'hydrate presence and revision'
  );

  s = replaceOnce(
    s,
    "function touch(room) { room.updatedAt = Date.now(); }\nfunction connectionStatus(room) {\n  const clients = [...room.clients];\n  return {\n    display: clients.some((client) => client.role === 'display'),\n    host: clients.some((client) => client.role === 'host'),\n    A: clients.some((client) => client.role === 'captain' && client.team === 'A'),\n    B: clients.some((client) => client.role === 'captain' && client.team === 'B')\n  };\n}",
    "function touch(room) { room.updatedAt = Date.now(); }\nfunction markSeen(room, role, team = null) {\n  if (!room.lastSeen) room.lastSeen = { display:null, host:null, A:null, B:null };\n  const key = role === 'captain' ? team : role;\n  if (['display','host','A','B'].includes(key)) room.lastSeen[key] = Date.now();\n}\nfunction connectionStatus(room) {\n  const clients = [...room.clients];\n  const recent = (key) => Boolean(room.lastSeen?.[key] && Date.now() - room.lastSeen[key] <= PRESENCE_MS);\n  return {\n    display: recent('display') || clients.some((client) => client.role === 'display'),\n    host: recent('host') || clients.some((client) => client.role === 'host'),\n    A: recent('A') || clients.some((client) => client.role === 'captain' && client.team === 'A'),\n    B: recent('B') || clients.some((client) => client.role === 'captain' && client.team === 'B')\n  };\n}",
    'presence model'
  );

  s = replaceOnce(
    s,
    "    roomCode: room.code, phase: room.phase, round: room.round, roundLabel: roundLabel(room.round),",
    "    roomCode: room.code, phase: room.phase, round: room.round, roundLabel: roundLabel(room.round),\n    revision: Math.max(0, Number(room.revision) || 0), buildId: BUILD_ID, instanceId: INSTANCE_ID,",
    'public revision and identity'
  );

  s = replaceOnce(
    s,
    "function broadcastState(room) { touch(room); schedulePersist(); for (const client of room.clients) sendSse(client, 'state', publicState(room, client.role, client.team)); }",
    "function broadcastState(room) { room.revision = Math.max(0, Number(room.revision) || 0) + 1; touch(room); schedulePersist(); for (const client of room.clients) sendSse(client, 'state', publicState(room, client.role, client.team)); }",
    'monotonic room revision'
  );

  s = replaceOnce(
    s,
    "if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, statePersistence: Boolean(GAME_STATE_FILE), rooms: rooms.size });",
    "if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, statePersistence: Boolean(GAME_STATE_FILE), rooms: rooms.size, buildId: BUILD_ID, instanceId: INSTANCE_ID });",
    'health identity'
  );

  s = replaceOnce(
    s,
    "      revealed: false, audioReady: false, audioFallback: null, stealDeadline: null, stealTimer: null, history: [], clients: new Set(),\n      createdAt: now, updatedAt: now",
    "      revealed: false, audioReady: false, audioFallback: null, stealDeadline: null, stealTimer: null, history: [], clients: new Set(),\n      revision: 0, lastSeen: { display:now, host:null, A:null, B:null }, createdAt: now, updatedAt: now",
    'room initial presence'
  );

  s = replaceOnce(
    s,
    "    if (!displayOk(room, body.displayToken)) return json(res, 403, { ok: false, error: 'UNAUTHORIZED' });\n    return json(res, 200, { ok: true, roomCode: room.code, displayToken: room.displayToken, hostPin: room.hostPin, state: publicState(room, 'display') });",
    "    if (!displayOk(room, body.displayToken)) return json(res, 403, { ok: false, error: 'UNAUTHORIZED' });\n    markSeen(room, 'display');\n    return json(res, 200, { ok: true, roomCode: room.code, displayToken: room.displayToken, hostPin: room.hostPin, state: publicState(room, 'display') });",
    'display resume presence'
  );

  s = replaceOnce(
    s,
    "    if (body.hostToken && room.hostToken === body.hostToken) return json(res, 200, { ok: true, hostToken: body.hostToken, state: publicState(room, 'host') });",
    "    if (body.hostToken && room.hostToken === body.hostToken) { markSeen(room, 'host'); return json(res, 200, { ok: true, hostToken: body.hostToken, state: publicState(room, 'host') }); }",
    'existing host presence'
  );

  s = replaceOnce(
    s,
    "    if (!room.hostToken) room.hostToken = token();\n    broadcastState(room);",
    "    if (!room.hostToken) room.hostToken = token();\n    markSeen(room, 'host');\n    broadcastState(room);",
    'new host presence'
  );

  s = replaceOnce(
    s,
    "    if (body.captainToken && room.captainTokens[team] === body.captainToken) {\n      if (body.forceReconnect) { closeCaptainClients(room, team); broadcastState(room); }\n      return json(res, 200, { ok: true, captainToken: body.captainToken, state: publicState(room, 'captain', team) });\n    }",
    "    if (body.captainToken && room.captainTokens[team] === body.captainToken) {\n      markSeen(room, 'captain', team);\n      if (body.forceReconnect) { closeCaptainClients(room, team); broadcastState(room); }\n      return json(res, 200, { ok: true, captainToken: body.captainToken, state: publicState(room, 'captain', team) });\n    }",
    'existing captain presence'
  );

  s = replaceOnce(
    s,
    "      const captainToken = token(); room.captainTokens[team] = captainToken; room.captainClaimedAt[team] = Date.now(); broadcastState(room);",
    "      const captainToken = token(); room.captainTokens[team] = captainToken; room.captainClaimedAt[team] = Date.now(); markSeen(room, 'captain', team); broadcastState(room);",
    'reclaimed captain presence'
  );

  s = replaceOnce(
    s,
    "    const captainToken = token(); room.captainTokens[team] = captainToken; room.captainClaimedAt[team] = Date.now(); broadcastState(room);",
    "    const captainToken = token(); room.captainTokens[team] = captainToken; room.captainClaimedAt[team] = Date.now(); markSeen(room, 'captain', team); broadcastState(room);",
    'new captain presence'
  );

  s = replaceOnce(
    s,
    "    if (!['display', 'host', 'captain'].includes(role)) return json(res, 400, { ok: false, error: 'INVALID_ROLE' });\n    touch(room);",
    "    if (!['display', 'host', 'captain'].includes(role)) return json(res, 400, { ok: false, error: 'INVALID_ROLE' });\n    markSeen(room, role, role === 'captain' ? team : null);\n    touch(room);",
    'poll presence heartbeat'
  );

  s = replaceOnce(
    s,
    "  if (action.startsWith('captain:') && !captainOk(room, body.team, body.token)) return json(res, 403, { ok: false, error: 'UNAUTHORIZED' });\n\n  if (action === 'host:start') {",
    "  if (action.startsWith('captain:') && !captainOk(room, body.team, body.token)) return json(res, 403, { ok: false, error: 'UNAUTHORIZED' });\n  if (action.startsWith('host:')) markSeen(room, 'host');\n  if (action.startsWith('display:')) markSeen(room, 'display');\n  if (action.startsWith('captain:')) markSeen(room, 'captain', body.team);\n\n  if (action === 'host:start') {",
    'action presence heartbeat'
  );

  fs.writeFileSync(file, s);
}

{
  const file = 'public/game.js';
  let s = fs.readFileSync(file, 'utf8');

  s = replaceOnce(
    s,
    "let statePollTimer = null;\nlet statePollInFlight = false;",
    "let statePollTimer = null;\nlet statePollInFlight = false;\nlet lastAppliedRevision = -1;",
    'client revision tracker'
  );

  const applyStart = s.indexOf('function applyAuthoritativeState(next) {');
  const payloadStart = s.indexOf('function stateSessionPayload()', applyStart);
  if (applyStart < 0 || payloadStart < 0) throw new Error('applyAuthoritativeState block not found');
  const applyBlock = s.slice(applyStart, payloadStart);
  const newApply = `function applyAuthoritativeState(next) {\n  if (!next) return;\n  const nextRevision = Number(next.revision ?? -1);\n  const currentRevision = Number(state?.revision ?? lastAppliedRevision ?? -1);\n  if (state && next.roomCode === state.roomCode && nextRevision >= 0 && currentRevision >= 0 && nextRevision < currentRevision) return;\n  const previous = state;\n  if (mode === 'display' && previous) {\n    const leftPlayback = next.phase !== 'PLAYING' && (previous.phase === 'PLAYING' || activePlaybackSeq);\n    const changedSong = previous.currentIndex !== next.currentIndex;\n    if (leftPlayback || changedSong) {\n      playbackCommandGeneration += 1;\n      audio.pause();\n      clearInterval(progressTimer); progressTimer = null;\n      activePlaybackSeq = 0;\n    }\n  }\n  const patch = canPatchLive(previous, next);\n  state = next;\n  if (nextRevision >= 0) lastAppliedRevision = Math.max(lastAppliedRevision, nextRevision);\n  roomCode = state.roomCode;\n  document.body.dataset.build = state.buildId || '';\n  document.body.dataset.instance = state.instanceId || '';\n  if (patch) updateLiveUi(); else render();\n}\n`;
  s = s.replace(applyBlock, newApply);

  const pollStart = s.indexOf('async function pollAuthoritativeState() {');
  const connectStart = s.indexOf('function connectEvents() {', pollStart);
  if (pollStart < 0 || connectStart < 0) throw new Error('polling block not found');
  const pollingBlock = s.slice(pollStart, connectStart);
  const newPolling = `async function pollAuthoritativeState() {\n  const payload = stateSessionPayload();\n  if (!payload || statePollInFlight) return;\n  statePollInFlight = true;\n  try {\n    const result = await api('/api/state', payload);\n    if (result?.ok && result.state) {\n      document.body.dataset.connection = 'online';\n      applyAuthoritativeState(result.state);\n    } else {\n      document.body.dataset.connection = 'offline';\n    }\n  } finally {\n    statePollInFlight = false;\n  }\n}\nfunction startStatePolling() {\n  clearInterval(statePollTimer);\n  statePollTimer = null;\n  if (!stateSessionPayload()) return;\n  pollAuthoritativeState();\n  const intervalMs = mode === 'display' ? 1500 : 750;\n  statePollTimer = setInterval(pollAuthoritativeState, intervalMs);\n}\n`;
  s = s.replace(pollingBlock, newPolling);

  const connectEnd = s.indexOf('function saveDisplay()', connectStart);
  if (connectEnd < 0) throw new Error('connectEvents end not found');
  const connectBlock = s.slice(connectStart, connectEnd);
  const newConnect = `function connectEvents() {\n  const token = mode === 'display' ? displayToken : mode === 'host' ? hostToken : captainToken;\n  if (!roomCode || !token || mode === 'home') return;\n  eventSource?.close();\n  eventSource = null;\n  if (mode !== 'display') {\n    document.body.dataset.connection = 'online';\n    startStatePolling();\n    return;\n  }\n  const params = new URLSearchParams({ room:roomCode, role:mode, token });\n  eventSource = new EventSource(\`/events?\${params}\`);\n  eventSource.onopen = () => {\n    document.body.dataset.connection = 'online';\n    if (audioUnlocked) emit('display:audioReady', { ready:true });\n  };\n  eventSource.onerror = () => {\n    document.body.dataset.connection = 'offline';\n    pollAuthoritativeState();\n  };\n  eventSource.addEventListener('state', (event) => applyAuthoritativeState(JSON.parse(event.data)));\n  eventSource.addEventListener('audio-play', (event) => handleAudioPlay(JSON.parse(event.data)));\n  eventSource.addEventListener('audio-pause', (event) => handleAudioPause(JSON.parse(event.data || '{}')));\n  startStatePolling();\n}\n`;
  s = s.replace(connectBlock, newConnect);

  fs.writeFileSync(file, s);
}

{
  const file = 'package.json';
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!pkg.scripts.check.includes('test/phone-authority.test.js')) pkg.scripts.check += ' && node --check test/phone-authority.test.js';
  if (!pkg.scripts.test.includes('test/phone-authority.test.js')) pkg.scripts.test += ' && node test/phone-authority.test.js';
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}

console.log('Phone authoritative-state patch applied.');
