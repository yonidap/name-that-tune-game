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
    "const STEAL_MS = Math.max(100, Number(process.env.STEAL_MS || 10_000));\nconst rooms = new Map();\n",
    "const STEAL_MS = Math.max(100, Number(process.env.STEAL_MS || 10_000));\nconst GAME_STATE_FILE = String(process.env.GAME_STATE_FILE || '').trim();\nconst rooms = new Map();\nlet persistTimer = null;\n",
    'persistence constants'
  );

  const oldHelpers = [
    "function cleanName(value, fallback) {",
    "  const text = String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 24);",
    "  return text || fallback;",
    "}",
    "function touch(room) { room.updatedAt = Date.now(); }"
  ].join('\n') + '\n';

  const newHelpers = [
    "function cleanName(value, fallback) {",
    "  const text = String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 24);",
    "  return text || fallback;",
    "}",
    "function serializableRoom(room) {",
    "  const { clients, stealTimer, ...saved } = room;",
    "  return saved;",
    "}",
    "function persistRoomsNow() {",
    "  if (!GAME_STATE_FILE) return;",
    "  const directory = path.dirname(GAME_STATE_FILE);",
    "  fs.mkdirSync(directory, { recursive: true });",
    "  const tempFile = GAME_STATE_FILE + '.tmp';",
    "  const payload = JSON.stringify({ version: 1, savedAt: Date.now(), rooms: [...rooms.values()].map(serializableRoom) });",
    "  fs.writeFileSync(tempFile, payload, 'utf8');",
    "  fs.renameSync(tempFile, GAME_STATE_FILE);",
    "}",
    "function schedulePersist() {",
    "  if (!GAME_STATE_FILE) return;",
    "  clearTimeout(persistTimer);",
    "  persistTimer = setTimeout(() => {",
    "    persistTimer = null;",
    "    try { persistRoomsNow(); } catch (error) { console.error('Could not persist game state:', error); }",
    "  }, 120);",
    "  persistTimer.unref?.();",
    "}",
    "function hydrateRoom(saved) {",
    "  if (!saved || typeof saved !== 'object' || !saved.code || !saved.displayToken || !Array.isArray(saved.playlist)) return null;",
    "  const room = {",
    "    ...saved,",
    "    captainTokens: { A: saved.captainTokens?.A || null, B: saved.captainTokens?.B || null },",
    "    captainClaimedAt: { A: saved.captainClaimedAt?.A || null, B: saved.captainClaimedAt?.B || null },",
    "    teamNames: { A: cleanName(saved.teamNames?.A, 'Team A'), B: cleanName(saved.teamNames?.B, 'Team B') },",
    "    scores: { A: Math.max(0, Number(saved.scores?.A) || 0), B: Math.max(0, Number(saved.scores?.B) || 0) },",
    "    history: Array.isArray(saved.history) ? saved.history.slice(-40) : [],",
    "    clients: new Set(), stealTimer: null, audioReady: false",
    "  };",
    "  if (room.phase === 'PLAYING') room.phase = 'PAUSED';",
    "  if (room.phase === 'STEAL') {",
    "    if (!room.stealDeadline || room.stealDeadline <= Date.now()) {",
    "      room.phase = 'REVEAL'; room.revealed = true; room.stealDeadline = null;",
    "    } else {",
    "      scheduleStealExpiry(room);",
    "    }",
    "  }",
    "  return room;",
    "}",
    "function loadPersistedRooms() {",
    "  if (!GAME_STATE_FILE || !fs.existsSync(GAME_STATE_FILE)) return;",
    "  try {",
    "    const parsed = JSON.parse(fs.readFileSync(GAME_STATE_FILE, 'utf8'));",
    "    const savedRooms = Array.isArray(parsed?.rooms) ? parsed.rooms : [];",
    "    for (const saved of savedRooms) {",
    "      const room = hydrateRoom(saved);",
    "      if (room) rooms.set(room.code, room);",
    "    }",
    "    if (rooms.size) console.log('Restored ' + rooms.size + ' game room(s) from durable state.');",
    "  } catch (error) {",
    "    console.error('Could not restore persisted game state:', error);",
    "  }",
    "}",
    "function touch(room) { room.updatedAt = Date.now(); }"
  ].join('\n') + '\n';

  s = replaceOnce(s, oldHelpers, newHelpers, 'persistence helpers');

  s = replaceOnce(
    s,
    "function broadcastState(room) { touch(room); for (const client of room.clients) sendSse(client, 'state', publicState(room, client.role, client.team)); }",
    "function broadcastState(room) { touch(room); schedulePersist(); for (const client of room.clients) sendSse(client, 'state', publicState(room, client.role, client.team)); }",
    'persist on state mutation'
  );

  s = replaceOnce(
    s,
    "  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });",
    "  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, statePersistence: Boolean(GAME_STATE_FILE), rooms: rooms.size });",
    'health persistence status'
  );

  s = replaceOnce(
    s,
    "    rooms.set(code, room);\n    return json(res, 200, { ok: true, roomCode: code, displayToken, hostPin, state: publicState(room, 'display') });",
    "    rooms.set(code, room);\n    schedulePersist();\n    return json(res, 200, { ok: true, roomCode: code, displayToken, hostPin, state: publicState(room, 'display') });",
    'persist room creation'
  );

  s = replaceOnce(s, "export function createServer() {\n", "loadPersistedRooms();\n\nexport function createServer() {\n", 'restore rooms on startup');

  const oldMain = [
    "    for (const [code, room] of rooms.entries()) if (room.updatedAt < staleBefore && room.clients.size === 0) { clearStealTimer(room); rooms.delete(code); }",
    "  }, 30 * 60 * 1000).unref();",
    "  server.listen(PORT, () => console.log(`Name That Tune running on http://localhost:${PORT}`));",
    "}"
  ].join('\n');
  const newMain = [
    "    let changed = false;",
    "    for (const [code, room] of rooms.entries()) if (room.updatedAt < staleBefore && room.clients.size === 0) { clearStealTimer(room); rooms.delete(code); changed = true; }",
    "    if (changed) schedulePersist();",
    "  }, 30 * 60 * 1000).unref();",
    "  const shutdown = () => {",
    "    try { clearTimeout(persistTimer); persistTimer = null; persistRoomsNow(); } catch (error) { console.error('Final state checkpoint failed:', error); }",
    "    server.close(() => process.exit(0));",
    "    setTimeout(() => process.exit(0), 2000).unref();",
    "  };",
    "  process.once('SIGTERM', shutdown);",
    "  process.once('SIGINT', shutdown);",
    "  server.listen(PORT, () => console.log(`Name That Tune running on http://localhost:${PORT}`));",
    "}"
  ].join('\n');
  s = replaceOnce(s, oldMain, newMain, 'shutdown persistence');

  fs.writeFileSync(file, s);
}

{
  const file = 'public/game.js';
  let s = fs.readFileSync(file, 'utf8');
  const keepAlive = [
    "",
    "function startDisplayKeepAlive() {",
    "  if (mode !== 'display') return;",
    "  const ping = () => fetch('/api/health', { method:'GET', cache:'no-store' }).catch(() => {});",
    "  ping();",
    "  setInterval(ping, 4 * 60_000);",
    "}",
    "",
    "startDisplayKeepAlive();",
    "restoreSession();",
    ""
  ].join('\n');
  s = replaceOnce(s, "\nrestoreSession();\n", keepAlive, 'display keepalive');
  fs.writeFileSync(file, s);
}

{
  const file = 'test/durability.test.js';
  const lines = [
    "import assert from 'node:assert/strict';",
    "import fs from 'node:fs';",
    "import http from 'node:http';",
    "import os from 'node:os';",
    "import path from 'node:path';",
    "",
    "const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntt-durable-'));",
    "const stateFile = path.join(dir, 'rooms.json');",
    "process.env.GAME_STATE_FILE = stateFile;",
    "process.env.STEAL_MS = '1000';",
    "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
    "",
    "async function startServer(moduleTag) {",
    "  const specifier = '../src/server.js?durability=' + moduleTag + '-' + Date.now();",
    "  const mod = await import(specifier);",
    "  const server = mod.createServer();",
    "  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));",
    "  const port = server.address().port;",
    "  return { server, base: 'http://127.0.0.1:' + port };",
    "}",
    "async function post(base, route, body) {",
    "  const response = await fetch(base + route, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });",
    "  return { status:response.status, body:await response.json() };",
    "}",
    "function connectSse(base, { room, role, token, team }) {",
    "  return new Promise((resolve, reject) => {",
    "    const query = new URLSearchParams({ room, role, token });",
    "    if (team) query.set('team', team);",
    "    const req = http.get(base + '/events?' + query, (res) => {",
    "      if (res.statusCode !== 200) return reject(new Error('SSE failed: ' + res.statusCode));",
    "      res.on('data', () => {});",
    "      resolve({ close:() => req.destroy() });",
    "    });",
    "    req.on('error', reject);",
    "  });",
    "}",
    "",
    "let first; let second; const streams = [];",
    "try {",
    "  first = await startServer('first');",
    "  const created = await post(first.base, '/api/display/create', { gameLength:'short', teamNames:{ A:'Alpha', B:'Beta' } });",
    "  assert.equal(created.status, 200);",
    "  const { roomCode, displayToken, hostPin } = created.body;",
    "  const host = await post(first.base, '/api/host/join', { roomCode, hostPin });",
    "  const capA = await post(first.base, '/api/captain/join', { roomCode, team:'A' });",
    "  const capB = await post(first.base, '/api/captain/join', { roomCode, team:'B' });",
    "  const hostToken = host.body.hostToken; const tokenA = capA.body.captainToken; const tokenB = capB.body.captainToken;",
    "  streams.push(await connectSse(first.base, { room:roomCode, role:'display', token:displayToken }));",
    "  streams.push(await connectSse(first.base, { room:roomCode, role:'host', token:hostToken }));",
    "  streams.push(await connectSse(first.base, { room:roomCode, role:'captain', team:'A', token:tokenA }));",
    "  streams.push(await connectSse(first.base, { room:roomCode, role:'captain', team:'B', token:tokenB }));",
    "  await post(first.base, '/api/action', { action:'display:audioReady', roomCode, token:displayToken, ready:true });",
    "  await post(first.base, '/api/action', { action:'host:start', roomCode, token:hostToken });",
    "  let state = (await post(first.base, '/api/host/join', { roomCode, hostToken })).body.state;",
    "  const play = await post(first.base, '/api/action', { action:'captain:play', roomCode, token:tokenA, team:'A' });",
    "  await post(first.base, '/api/action', { action:'display:audioProgress', roomCode, token:displayToken, seq:play.body.playbackSeq, position:Math.min(1.2, state.song.duration / 3), paused:true });",
    "  state = (await post(first.base, '/api/host/join', { roomCode, hostToken })).body.state;",
    "  assert.equal(state.phase, 'PAUSED');",
    "  const before = { currentIndex:state.currentIndex, points:state.currentPoints, heard:state.totalHeardSeconds, scores:state.scores };",
    "  for (const stream of streams.splice(0)) stream.close();",
    "  await sleep(350);",
    "  await new Promise((resolve) => first.server.close(resolve));",
    "  first = null;",
    "  assert.ok(fs.existsSync(stateFile), 'durable state file must exist before restart');",
    "",
    "  second = await startServer('second');",
    "  const resumed = await post(second.base, '/api/display/resume', { roomCode, displayToken });",
    "  assert.equal(resumed.status, 200, 'display token must survive a process restart');",
    "  assert.equal(resumed.body.state.currentIndex, before.currentIndex);",
    "  assert.equal(resumed.body.state.phase, 'PAUSED');",
    "  assert.equal(resumed.body.state.audioReady, false, 'audio readiness must be revoked after process restart');",
    "  assert.equal(resumed.body.state.currentPoints, before.points);",
    "  assert.ok(Math.abs(resumed.body.state.totalHeardSeconds - before.heard) < 0.05);",
    "  assert.deepEqual(resumed.body.state.scores, before.scores);",
    "  assert.equal((await post(second.base, '/api/host/join', { roomCode, hostToken })).status, 200, 'host token must survive restart');",
    "  assert.equal((await post(second.base, '/api/captain/join', { roomCode, team:'A', captainToken:tokenA })).status, 200, 'captain A token must survive restart');",
    "  assert.equal((await post(second.base, '/api/captain/join', { roomCode, team:'B', captainToken:tokenB })).status, 200, 'captain B token must survive restart');",
    "  const health = await fetch(second.base + '/api/health').then((r) => r.json());",
    "  assert.equal(health.statePersistence, true);",
    "",
    "  const browser = fs.readFileSync('public/game.js', 'utf8');",
    "  assert.match(browser, /setInterval\\(ping, 4 \\* 60_000\\)/, 'main display must send inbound keepalive before Render idle timeout');",
    "  console.log('Durability restart audit passed');",
    "} finally {",
    "  for (const stream of streams) { try { stream.close(); } catch {} }",
    "  if (first?.server?.listening) await new Promise((resolve) => first.server.close(resolve));",
    "  if (second?.server?.listening) await new Promise((resolve) => second.server.close(resolve));",
    "  fs.rmSync(dir, { recursive:true, force:true });",
    "}",
    ""
  ];
  fs.writeFileSync(file, lines.join('\n'));
}

{
  const file = 'package.json';
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!pkg.scripts.check.includes('test/durability.test.js')) pkg.scripts.check += ' && node --check test/durability.test.js';
  if (!pkg.scripts.test.includes('test/durability.test.js')) pkg.scripts.test += ' && node test/durability.test.js';
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}

{
  const file = 'README.md';
  let s = fs.readFileSync(file, 'utf8');
  const marker = '## Production limitations\n';
  const section = [
    '## Party-session durability',
    '',
    'The main display sends an inbound health request every four minutes so a Render Free web service does not go idle while the display is open.',
    '',
    'For restart-safe room recovery, set `GAME_STATE_FILE` to a path on durable storage (for example `/var/data/name-that-tune-state.json` on a Render Persistent Disk). Every authoritative state change is checkpointed atomically. On process restart, rooms, playlist order, scores, host/captain tokens, current song and playback progress are restored. A room that was actively playing comes back as `PAUSED` so it never resumes audio unexpectedly. Audio readiness is intentionally revoked until the display reconnects.',
    '',
    'Without durable storage, a provider-level restart can still erase in-memory room state. Render Free web services cannot attach Persistent Disks.',
    '',
    ''
  ].join('\n');
  if (!s.includes('## Party-session durability')) s = s.replace(marker, section + marker);
  fs.writeFileSync(file, s);
}

console.log('Durability patch applied');
