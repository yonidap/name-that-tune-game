import fs from 'node:fs';

function replaceOnce(text, oldText, newText, label) {
  if (!text.includes(oldText)) throw new Error(`${label}: source block not found`);
  return text.replace(oldText, newText);
}

// --- Server-side durable room checkpoints ---
{
  const file = 'src/server.js';
  let s = fs.readFileSync(file, 'utf8');

  s = replaceOnce(
    s,
    "const STEAL_MS = Math.max(100, Number(process.env.STEAL_MS || 10_000));\nconst rooms = new Map();\n",
    "const STEAL_MS = Math.max(100, Number(process.env.STEAL_MS || 10_000));\nconst GAME_STATE_FILE = String(process.env.GAME_STATE_FILE || '').trim();\nconst rooms = new Map();\nlet persistTimer = null;\n",
    'persistence constants'
  );

  s = replaceOnce(
    s,
    `function cleanName(value, fallback) {\n  const text = String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 24);\n  return text || fallback;\n}\nfunction touch(room) { room.updatedAt = Date.now(); }\n`,
    `function cleanName(value, fallback) {\n  const text = String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 24);\n  return text || fallback;\n}\nfunction serializableRoom(room) {\n  const { clients, stealTimer, ...saved } = room;\n  return saved;\n}\nfunction persistRoomsNow() {\n  if (!GAME_STATE_FILE) return;\n  const directory = path.dirname(GAME_STATE_FILE);\n  fs.mkdirSync(directory, { recursive: true });\n  const tempFile = \\`${'${GAME_STATE_FILE}'}.tmp\\`;\n  const payload = JSON.stringify({ version: 1, savedAt: Date.now(), rooms: [...rooms.values()].map(serializableRoom) });\n  fs.writeFileSync(tempFile, payload, 'utf8');\n  fs.renameSync(tempFile, GAME_STATE_FILE);\n}\nfunction schedulePersist() {\n  if (!GAME_STATE_FILE) return;\n  clearTimeout(persistTimer);\n  persistTimer = setTimeout(() => {\n    persistTimer = null;\n    try { persistRoomsNow(); } catch (error) { console.error('Could not persist game state:', error); }\n  }, 120);\n  persistTimer.unref?.();\n}\nfunction hydrateRoom(saved) {\n  if (!saved || typeof saved !== 'object' || !saved.code || !saved.displayToken || !Array.isArray(saved.playlist)) return null;\n  const room = {\n    ...saved,\n    captainTokens: { A: saved.captainTokens?.A || null, B: saved.captainTokens?.B || null },\n    captainClaimedAt: { A: saved.captainClaimedAt?.A || null, B: saved.captainClaimedAt?.B || null },\n    teamNames: { A: cleanName(saved.teamNames?.A, 'Team A'), B: cleanName(saved.teamNames?.B, 'Team B') },\n    scores: { A: Math.max(0, Number(saved.scores?.A) || 0), B: Math.max(0, Number(saved.scores?.B) || 0) },\n    history: Array.isArray(saved.history) ? saved.history.slice(-40) : [],\n    clients: new Set(), stealTimer: null, audioReady: false\n  };\n  if (room.phase === 'PLAYING') room.phase = 'PAUSED';\n  if (room.phase === 'STEAL') {\n    if (!room.stealDeadline || room.stealDeadline <= Date.now()) {\n      room.phase = 'REVEAL'; room.revealed = true; room.stealDeadline = null;\n    } else {\n      scheduleStealExpiry(room);\n    }\n  }\n  return room;\n}\nfunction loadPersistedRooms() {\n  if (!GAME_STATE_FILE || !fs.existsSync(GAME_STATE_FILE)) return;\n  try {\n    const parsed = JSON.parse(fs.readFileSync(GAME_STATE_FILE, 'utf8'));\n    const savedRooms = Array.isArray(parsed?.rooms) ? parsed.rooms : [];\n    for (const saved of savedRooms) {\n      const room = hydrateRoom(saved);\n      if (room) rooms.set(room.code, room);\n    }\n    if (rooms.size) console.log(\\`Restored ${'${rooms.size}'} game room(s) from durable state.\\`);\n  } catch (error) {\n    console.error('Could not restore persisted game state:', error);\n  }\n}\nfunction touch(room) { room.updatedAt = Date.now(); }\n`,
    'persistence helpers'
  );

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

  s = replaceOnce(
    s,
    "export function createServer() {\n",
    "loadPersistedRooms();\n\nexport function createServer() {\n",
    'restore rooms on startup'
  );

  s = replaceOnce(
    s,
    "    for (const [code, room] of rooms.entries()) if (room.updatedAt < staleBefore && room.clients.size === 0) { clearStealTimer(room); rooms.delete(code); }\n  }, 30 * 60 * 1000).unref();\n  server.listen(PORT, () => console.log(`Name That Tune running on http://localhost:${PORT}`));\n}",
    "    let changed = false;\n    for (const [code, room] of rooms.entries()) if (room.updatedAt < staleBefore && room.clients.size === 0) { clearStealTimer(room); rooms.delete(code); changed = true; }\n    if (changed) schedulePersist();\n  }, 30 * 60 * 1000).unref();\n  const shutdown = () => {\n    try { clearTimeout(persistTimer); persistTimer = null; persistRoomsNow(); } catch (error) { console.error('Final state checkpoint failed:', error); }\n    server.close(() => process.exit(0));\n    setTimeout(() => process.exit(0), 2000).unref();\n  };\n  process.once('SIGTERM', shutdown);\n  process.once('SIGINT', shutdown);\n  server.listen(PORT, () => console.log(`Name That Tune running on http://localhost:${PORT}`));\n}",
    'shutdown persistence'
  );

  fs.writeFileSync(file, s);
}

// --- Main display keepalive: inbound HTTP prevents Render Free idle spin-down ---
{
  const file = 'public/game.js';
  let s = fs.readFileSync(file, 'utf8');
  s = replaceOnce(
    s,
    "\nrestoreSession();\n",
    `\nfunction startDisplayKeepAlive() {\n  if (mode !== 'display') return;\n  const ping = () => fetch('/api/health', { method:'GET', cache:'no-store' }).catch(() => {});\n  ping();\n  setInterval(ping, 4 * 60_000);\n}\n\nstartDisplayKeepAlive();\nrestoreSession();\n`,
    'display keepalive'
  );
  fs.writeFileSync(file, s);
}

// --- Restart recovery integration test ---
{
  const file = 'test/durability.test.js';
  const content = `import assert from 'node:assert/strict';\nimport fs from 'node:fs';\nimport http from 'node:http';\nimport os from 'node:os';\nimport path from 'node:path';\n\nconst dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntt-durable-'));\nconst stateFile = path.join(dir, 'rooms.json');\nprocess.env.GAME_STATE_FILE = stateFile;\nprocess.env.STEAL_MS = '1000';\nconst sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\n\nasync function startServer(moduleTag) {\n  const mod = await import(\\`../src/server.js?durability=\\${moduleTag}-\\${Date.now()}\\`);\n  const server = mod.createServer();\n  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));\n  const { port } = server.address();\n  return { server, base: \\`http://127.0.0.1:\\${port}\\` };\n}\nasync function post(base, route, body) {\n  const response = await fetch(\\`\\${base}\\${route}\\`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });\n  return { status:response.status, body:await response.json() };\n}\nfunction connectSse(base, { room, role, token, team }) {\n  return new Promise((resolve, reject) => {\n    const query = new URLSearchParams({ room, role, token });\n    if (team) query.set('team', team);\n    const req = http.get(\\`\\${base}/events?\\${query}\\`, (res) => {\n      if (res.statusCode !== 200) return reject(new Error(\\`SSE failed: \\${res.statusCode}\\`));\n      res.on('data', () => {});\n      resolve({ close:() => req.destroy() });\n    });\n    req.on('error', reject);\n  });\n}\n\nlet first; let second; const streams = [];\ntry {\n  first = await startServer('first');\n  const created = await post(first.base, '/api/display/create', { gameLength:'short', teamNames:{ A:'Alpha', B:'Beta' } });\n  assert.equal(created.status, 200);\n  const { roomCode, displayToken, hostPin } = created.body;\n  const host = await post(first.base, '/api/host/join', { roomCode, hostPin });\n  const capA = await post(first.base, '/api/captain/join', { roomCode, team:'A' });\n  const capB = await post(first.base, '/api/captain/join', { roomCode, team:'B' });\n  const hostToken = host.body.hostToken; const tokenA = capA.body.captainToken; const tokenB = capB.body.captainToken;\n  streams.push(await connectSse(first.base, { room:roomCode, role:'display', token:displayToken }));\n  streams.push(await connectSse(first.base, { room:roomCode, role:'host', token:hostToken }));\n  streams.push(await connectSse(first.base, { room:roomCode, role:'captain', team:'A', token:tokenA }));\n  streams.push(await connectSse(first.base, { room:roomCode, role:'captain', team:'B', token:tokenB }));\n  await post(first.base, '/api/action', { action:'display:audioReady', roomCode, token:displayToken, ready:true });\n  await post(first.base, '/api/action', { action:'host:start', roomCode, token:hostToken });\n  let state = (await post(first.base, '/api/host/join', { roomCode, hostToken })).body.state;\n  const play = await post(first.base, '/api/action', { action:'captain:play', roomCode, token:tokenA, team:'A' });\n  await post(first.base, '/api/action', { action:'display:audioProgress', roomCode, token:displayToken, seq:play.body.playbackSeq, position:Math.min(1.2, state.song.duration / 3), paused:true });\n  state = (await post(first.base, '/api/host/join', { roomCode, hostToken })).body.state;\n  assert.equal(state.phase, 'PAUSED');\n  const before = { currentIndex:state.currentIndex, points:state.currentPoints, heard:state.totalHeardSeconds, scores:state.scores };\n  for (const stream of streams.splice(0)) stream.close();\n  await sleep(350);\n  await new Promise((resolve) => first.server.close(resolve));\n  first = null;\n  assert.ok(fs.existsSync(stateFile), 'durable state file must exist before restart');\n\n  second = await startServer('second');\n  const resumed = await post(second.base, '/api/display/resume', { roomCode, displayToken });\n  assert.equal(resumed.status, 200, 'display token must survive a process restart');\n  assert.equal(resumed.body.state.currentIndex, before.currentIndex);\n  assert.equal(resumed.body.state.phase, 'PAUSED');\n  assert.equal(resumed.body.state.audioReady, false, 'audio readiness must be revoked after process restart');\n  assert.equal(resumed.body.state.currentPoints, before.points);\n  assert.ok(Math.abs(resumed.body.state.totalHeardSeconds - before.heard) < 0.05);\n  assert.deepEqual(resumed.body.state.scores, before.scores);\n  assert.equal((await post(second.base, '/api/host/join', { roomCode, hostToken })).status, 200, 'host token must survive restart');\n  assert.equal((await post(second.base, '/api/captain/join', { roomCode, team:'A', captainToken:tokenA })).status, 200, 'captain A token must survive restart');\n  assert.equal((await post(second.base, '/api/captain/join', { roomCode, team:'B', captainToken:tokenB })).status, 200, 'captain B token must survive restart');\n  const health = await fetch(\\`\\${second.base}/api/health\\`).then((r) => r.json());\n  assert.equal(health.statePersistence, true);\n\n  const browser = fs.readFileSync('public/game.js', 'utf8');\n  assert.match(browser, /setInterval\\(ping, 4 \\* 60_000\\)/, 'main display must send an inbound keepalive before Render idle timeout');\n  console.log('Durability restart audit passed');\n} finally {\n  for (const stream of streams) { try { stream.close(); } catch {} }\n  if (first?.server?.listening) await new Promise((resolve) => first.server.close(resolve));\n  if (second?.server?.listening) await new Promise((resolve) => second.server.close(resolve));\n  fs.rmSync(dir, { recursive:true, force:true });\n}\n`;
  fs.writeFileSync(file, content);
}

// --- Include durability regression test in the standard CI suite ---
{
  const file = 'package.json';
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!pkg.scripts.check.includes('test/durability.test.js')) pkg.scripts.check += ' && node --check test/durability.test.js';
  if (!pkg.scripts.test.includes('test/durability.test.js')) pkg.scripts.test += ' && node test/durability.test.js';
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}

// --- Document the operational requirement for truly durable Render recovery ---
{
  const file = 'README.md';
  let s = fs.readFileSync(file, 'utf8');
  const marker = '## Production limitations\n';
  const section = `## Party-session durability\n\nThe main display sends an inbound health request every four minutes so a Render Free web service does not go idle while the display is open.\n\nFor restart-safe room recovery, set \\`GAME_STATE_FILE\\` to a path on durable storage (for example \\`/var/data/name-that-tune-state.json\\` on a Render Persistent Disk). Every authoritative state change is checkpointed atomically. On process restart, rooms, playlist order, scores, host/captain tokens, current song and playback progress are restored. A room that was actively playing comes back as \\`PAUSED\\` so it never resumes audio unexpectedly. Audio readiness is intentionally revoked until the display reconnects.\n\nWithout durable storage, a provider-level restart can still erase in-memory room state. Render Free web services cannot attach Persistent Disks.\n\n`;
  if (!s.includes('## Party-session durability')) s = s.replace(marker, section + marker);
  fs.writeFileSync(file, s);
}

console.log('Durability patch applied');
