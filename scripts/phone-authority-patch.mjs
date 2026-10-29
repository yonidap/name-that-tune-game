import fs from 'node:fs';

function replaceOnce(text, oldText, newText, label) {
  if (!text.includes(oldText)) throw new Error(`${label}: source block not found`);
  return text.replace(oldText, newText);
}

{
  const file = 'src/server.js';
  let s = fs.readFileSync(file, 'utf8');

  s = replaceOnce(s,
    "const GAME_STATE_FILE = String(process.env.GAME_STATE_FILE || '').trim();\nconst rooms = new Map();",
    "const GAME_STATE_FILE = String(process.env.GAME_STATE_FILE || '').trim();\nconst BUILD_ID = String(process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'dev').slice(0, 12);\nconst INSTANCE_ID = crypto.randomBytes(4).toString('hex');\nconst PRESENCE_MS = 10_000;\nconst rooms = new Map();",
    'server identity constants');

  s = replaceOnce(s,
    "    history: Array.isArray(saved.history) ? saved.history.slice(-40) : [],\n    clients: new Set(), stealTimer: null, audioReady: false",
    "    history: Array.isArray(saved.history) ? saved.history.slice(-40) : [],\n    revision: Math.max(0, Number(saved.revision) || 0),\n    lastSeen: { display:null, host:null, A:null, B:null },\n    clients: new Set(), stealTimer: null, audioReady: false",
    'hydrate presence and revision');

  s = replaceOnce(s,
    "function touch(room) { room.updatedAt = Date.now(); }\nfunction connectionStatus(room) {\n  const clients = [...room.clients];\n  return {\n    display: clients.some((client) => client.role === 'display'),\n    host: clients.some((client) => client.role === 'host'),\n    A: clients.some((client) => client.role === 'captain' && client.team === 'A'),\n    B: clients.some((client) => client.role === 'captain' && client.team === 'B')\n  };\n}",
    "function touch(room) { room.updatedAt = Date.now(); }\nfunction markSeen(room, role, team = null) {\n  if (!room.lastSeen) room.lastSeen = { display:null, host:null, A:null, B:null };\n  const key = role === 'captain' ? team : role;\n  if (['display','host','A','B'].includes(key)) room.lastSeen[key] = Date.now();\n}\nfunction connectionStatus(room) {\n  const clients = [...room.clients];\n  const recent = (key) => Boolean(room.lastSeen?.[key] && Date.now() - room.lastSeen[key] <= PRESENCE_MS);\n  return {\n    display: recent('display') || clients.some((client) => client.role === 'display'),\n    host: recent('host') || clients.some((client) => client.role === 'host'),\n    A: recent('A') || clients.some((client) => client.role === 'captain' && client.team === 'A'),\n    B: recent('B') || clients.some((client) => client.role === 'captain' && client.team === 'B')\n  };\n}",
    'presence model');

  s = replaceOnce(s,
    "    roomCode: room.code, phase: room.phase, round: room.round, roundLabel: roundLabel(room.round),",
    "    roomCode: room.code, phase: room.phase, round: room.round, roundLabel: roundLabel(room.round),\n    revision: Math.max(0, Number(room.revision) || 0), buildId: BUILD_ID, instanceId: INSTANCE_ID,",
    'public revision and identity');

  s = replaceOnce(s,
    "function broadcastState(room) { touch(room); schedulePersist(); for (const client of room.clients) sendSse(client, 'state', publicState(room, client.role, client.team)); }",
    "function broadcastState(room) { room.revision = Math.max(0, Number(room.revision) || 0) + 1; touch(room); schedulePersist(); for (const client of room.clients) sendSse(client, 'state', publicState(room, client.role, client.team)); }",
    'monotonic room revision');

  s = replaceOnce(s,
    "if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, statePersistence: Boolean(GAME_STATE_FILE), rooms: rooms.size });",
    "if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, statePersistence: Boolean(GAME_STATE_FILE), rooms: rooms.size, buildId: BUILD_ID, instanceId: INSTANCE_ID });",
    'health identity');

  s = replaceOnce(s,
    "      revealed: false, audioReady: false, audioFallback: null, stealDeadline: null, stealTimer: null, history: [], clients: new Set(),\n      createdAt: now, updatedAt: now",
    "      revealed: false, audioReady: false, audioFallback: null, stealDeadline: null, stealTimer: null, history: [], clients: new Set(),\n      revision: 0, lastSeen: { display:now, host:null, A:null, B:null }, createdAt: now, updatedAt: now",
    'room initial presence');

  s = replaceOnce(s,
    "    if (!displayOk(room, body.displayToken)) return json(res, 403, { ok: false, error: 'UNAUTHORIZED' });\n    return json(res, 200, { ok: true, roomCode: room.code, displayToken: room.displayToken, hostPin: room.hostPin, state: publicState(room, 'display') });",
    "    if (!displayOk(room, body.displayToken)) return json(res, 403, { ok: false, error: 'UNAUTHORIZED' });\n    markSeen(room, 'display');\n    return json(res, 200, { ok: true, roomCode: room.code, displayToken: room.displayToken, hostPin: room.hostPin, state: publicState(room, 'display') });",
    'display resume presence');

  s = replaceOnce(s,
    "    if (body.hostToken && room.hostToken === body.hostToken) return json(res, 200, { ok: true, hostToken: body.hostToken, state: publicState(room, 'host') });",
    "    if (body.hostToken && room.hostToken === body.hostToken) { markSeen(room, 'host'); return json(res, 200, { ok: true, hostToken: body.hostToken, state: publicState(room, 'host') }); }",
    'existing host presence');

  s = replaceOnce(s,
    "    if (!room.hostToken) room.hostToken = token();\n    broadcastState(room);",
    "    if (!room.hostToken) room.hostToken = token();\n    markSeen(room, 'host');\n    broadcastState(room);",
    'new host presence');

  s = replaceOnce(s,
    "    if (body.captainToken && room.captainTokens[team] === body.captainToken) {\n      if (body.forceReconnect) { closeCaptainClients(room, team); broadcastState(room); }\n      return json(res, 200, { ok: true, captainToken: body.captainToken, state: publicState(room, 'captain', team) });\n    }",
    "    if (body.captainToken && room.captainTokens[team] === body.captainToken) {\n      markSeen(room, 'captain', team);\n      if (body.forceReconnect) { closeCaptainClients(room, team); broadcastState(room); }\n      return json(res, 200, { ok: true, captainToken: body.captainToken, state: publicState(room, 'captain', team) });\n    }",
    'existing captain presence');

  s = replaceOnce(s,
    "      const captainToken = token(); room.captainTokens[team] = captainToken; room.captainClaimedAt[team] = Date.now(); broadcastState(room);",
    "      const captainToken = token(); room.captainTokens[team] = captainToken; room.captainClaimedAt[team] = Date.now(); markSeen(room, 'captain', team); broadcastState(room);",
    'reclaimed captain presence');

  s = replaceOnce(s,
    "    const captainToken = token(); room.captainTokens[team] = captainToken; room.captainClaimedAt[team] = Date.now(); broadcastState(room);",
    "    const captainToken = token(); room.captainTokens[team] = captainToken; room.captainClaimedAt[team] = Date.now(); markSeen(room, 'captain', team); broadcastState(room);",
    'new captain presence');

  s = replaceOnce(s,
    "    if (!['display', 'host', 'captain'].includes(role)) return json(res, 400, { ok: false, error: 'INVALID_ROLE' });\n    touch(room);",
    "    if (!['display', 'host', 'captain'].includes(role)) return json(res, 400, { ok: false, error: 'INVALID_ROLE' });\n    markSeen(room, role, role === 'captain' ? team : null);\n    touch(room);",
    'poll presence heartbeat');

  s = replaceOnce(s,
    "  if (action.startsWith('captain:') && !captainOk(room, body.team, body.token)) return json(res, 403, { ok: false, error: 'UNAUTHORIZED' });\n\n  if (action === 'host:start') {",
    "  if (action.startsWith('captain:') && !captainOk(room, body.team, body.token)) return json(res, 403, { ok: false, error: 'UNAUTHORIZED' });\n  if (action.startsWith('host:')) markSeen(room, 'host');\n  if (action.startsWith('display:')) markSeen(room, 'display');\n  if (action.startsWith('captain:')) markSeen(room, 'captain', body.team);\n\n  if (action === 'host:start') {",
    'action presence heartbeat');

  fs.writeFileSync(file, s);
}

{
  const file = 'public/game.js';
  let s = fs.readFileSync(file, 'utf8');

  s = replaceOnce(s,
    "let statePollTimer = null;\nlet statePollInFlight = false;",
    "let statePollTimer = null;\nlet statePollInFlight = false;\nlet lastAppliedRevision = -1;",
    'client revision tracker');

  s = replaceOnce(s,
`function applyAuthoritativeState(next) {
  if (!next) return;
  const previous = state;
  if (mode === 'display' && previous) {
    const leftPlayback = next.phase !== 'PLAYING' && (previous.phase === 'PLAYING' || activePlaybackSeq);
    const changedSong = previous.currentIndex !== next.currentIndex;
    if (leftPlayback || changedSong) {
      playbackCommandGeneration += 1;
      audio.pause();
      clearInterval(progressTimer); progressTimer = null;
      activePlaybackSeq = 0;
    }
  }
  const patch = canPatchLive(previous, next);
  state = next;
  roomCode = state.roomCode;
  if (patch) updateLiveUi(); else render();
}
`,
`function applyAuthoritativeState(next) {
  if (!next) return;
  const nextRevision = Number(next.revision ?? -1);
  const currentRevision = Number(state?.revision ?? lastAppliedRevision ?? -1);
  if (state && next.roomCode === state.roomCode && nextRevision >= 0 && currentRevision >= 0 && nextRevision < currentRevision) return;
  const previous = state;
  if (mode === 'display' && previous) {
    const leftPlayback = next.phase !== 'PLAYING' && (previous.phase === 'PLAYING' || activePlaybackSeq);
    const changedSong = previous.currentIndex !== next.currentIndex;
    if (leftPlayback || changedSong) {
      playbackCommandGeneration += 1;
      audio.pause();
      clearInterval(progressTimer); progressTimer = null;
      activePlaybackSeq = 0;
    }
  }
  const patch = canPatchLive(previous, next);
  state = next;
  if (nextRevision >= 0) lastAppliedRevision = Math.max(lastAppliedRevision, nextRevision);
  roomCode = state.roomCode;
  document.body.dataset.build = state.buildId || '';
  document.body.dataset.instance = state.instanceId || '';
  if (patch) updateLiveUi(); else render();
}
`,
    'apply authoritative state');

  s = replaceOnce(s,
`async function pollAuthoritativeState() {
  const payload = stateSessionPayload();
  if (!payload || statePollInFlight) return;
  statePollInFlight = true;
  try {
    const result = await api('/api/state', payload);
    if (result?.ok && result.state) applyAuthoritativeState(result.state);
  } finally {
    statePollInFlight = false;
  }
}
function startStatePolling() {
  clearInterval(statePollTimer);
  statePollTimer = null;
  if (!stateSessionPayload()) return;
  setTimeout(() => pollAuthoritativeState(), 250);
  statePollTimer = setInterval(pollAuthoritativeState, 1500);
}
`,
`async function pollAuthoritativeState() {
  const payload = stateSessionPayload();
  if (!payload || statePollInFlight) return;
  statePollInFlight = true;
  try {
    const result = await api('/api/state', payload);
    if (result?.ok && result.state) {
      document.body.dataset.connection = 'online';
      applyAuthoritativeState(result.state);
    } else {
      document.body.dataset.connection = 'offline';
    }
  } finally {
    statePollInFlight = false;
  }
}
function startStatePolling() {
  clearInterval(statePollTimer);
  statePollTimer = null;
  if (!stateSessionPayload()) return;
  pollAuthoritativeState();
  const intervalMs = mode === 'display' ? 1500 : 750;
  statePollTimer = setInterval(pollAuthoritativeState, intervalMs);
}
`,
    'phone polling cadence');

  s = replaceOnce(s,
`function connectEvents() {
  const token = mode === 'display' ? displayToken : mode === 'host' ? hostToken : captainToken;
  if (!roomCode || !token || mode === 'home') return;
  eventSource?.close();
  const params = new URLSearchParams({ room:roomCode, role:mode, token });
  if (mode === 'captain') params.set('team', team);
  eventSource = new EventSource(\`/events?\${params}\`);
  eventSource.onopen = () => {
    document.body.dataset.connection = 'online';
    if (mode === 'display' && audioUnlocked) emit('display:audioReady', { ready:true });
  };
  eventSource.onerror = () => {
    document.body.dataset.connection = 'offline';
    pollAuthoritativeState();
  };
  eventSource.addEventListener('state', (event) => applyAuthoritativeState(JSON.parse(event.data)));
  if (mode === 'display') {
    eventSource.addEventListener('audio-play', (event) => handleAudioPlay(JSON.parse(event.data)));
    eventSource.addEventListener('audio-pause', (event) => handleAudioPause(JSON.parse(event.data || '{}')));
  }
  startStatePolling();
}
`,
`function connectEvents() {
  const token = mode === 'display' ? displayToken : mode === 'host' ? hostToken : captainToken;
  if (!roomCode || !token || mode === 'home') return;
  eventSource?.close();
  eventSource = null;
  if (mode !== 'display') {
    document.body.dataset.connection = 'online';
    startStatePolling();
    return;
  }
  const params = new URLSearchParams({ room:roomCode, role:mode, token });
  eventSource = new EventSource(\`/events?\${params}\`);
  eventSource.onopen = () => {
    document.body.dataset.connection = 'online';
    if (audioUnlocked) emit('display:audioReady', { ready:true });
  };
  eventSource.onerror = () => {
    document.body.dataset.connection = 'offline';
    pollAuthoritativeState();
  };
  eventSource.addEventListener('state', (event) => applyAuthoritativeState(JSON.parse(event.data)));
  eventSource.addEventListener('audio-play', (event) => handleAudioPlay(JSON.parse(event.data)));
  eventSource.addEventListener('audio-pause', (event) => handleAudioPause(JSON.parse(event.data || '{}')));
  startStatePolling();
}
`,
    'phone polling-only transport');

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
