import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntt-durable-'));
const stateFile = path.join(dir, 'rooms.json');
process.env.GAME_STATE_FILE = stateFile;
process.env.STEAL_MS = '1000';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer(moduleTag) {
  const specifier = '../src/server.js?durability=' + moduleTag + '-' + Date.now();
  const mod = await import(specifier);
  const server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, base: 'http://127.0.0.1:' + port };
}
async function post(base, route, body) {
  const response = await fetch(base + route, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
  return { status:response.status, body:await response.json() };
}
function connectSse(base, { room, role, token, team }) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({ room, role, token });
    if (team) query.set('team', team);
    const req = http.get(base + '/events?' + query, (res) => {
      if (res.statusCode !== 200) return reject(new Error('SSE failed: ' + res.statusCode));
      res.on('data', () => {});
      resolve({ close:() => req.destroy() });
    });
    req.on('error', reject);
  });
}

let first; let second; const streams = [];
try {
  first = await startServer('first');
  const created = await post(first.base, '/api/display/create', { gameLength:'short', teamNames:{ A:'Alpha', B:'Beta' } });
  assert.equal(created.status, 200);
  const { roomCode, displayToken, hostPin } = created.body;
  const host = await post(first.base, '/api/host/join', { roomCode, hostPin });
  const capA = await post(first.base, '/api/captain/join', { roomCode, team:'A' });
  const capB = await post(first.base, '/api/captain/join', { roomCode, team:'B' });
  const hostToken = host.body.hostToken; const tokenA = capA.body.captainToken; const tokenB = capB.body.captainToken;
  streams.push(await connectSse(first.base, { room:roomCode, role:'display', token:displayToken }));
  streams.push(await connectSse(first.base, { room:roomCode, role:'host', token:hostToken }));
  streams.push(await connectSse(first.base, { room:roomCode, role:'captain', team:'A', token:tokenA }));
  streams.push(await connectSse(first.base, { room:roomCode, role:'captain', team:'B', token:tokenB }));
  await post(first.base, '/api/action', { action:'display:audioReady', roomCode, token:displayToken, ready:true });
  await post(first.base, '/api/action', { action:'host:start', roomCode, token:hostToken });
  let state = (await post(first.base, '/api/host/join', { roomCode, hostToken })).body.state;
  const play = await post(first.base, '/api/action', { action:'captain:play', roomCode, token:tokenA, team:'A' });
  await post(first.base, '/api/action', { action:'display:audioProgress', roomCode, token:displayToken, seq:play.body.playbackSeq, position:Math.min(1.2, state.song.duration / 3), paused:true });
  state = (await post(first.base, '/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'PAUSED');
  const before = { currentIndex:state.currentIndex, points:state.currentPoints, heard:state.totalHeardSeconds, scores:state.scores };
  for (const stream of streams.splice(0)) stream.close();
  await sleep(350);
  await new Promise((resolve) => first.server.close(resolve));
  first = null;
  assert.ok(fs.existsSync(stateFile), 'durable state file must exist before restart');

  second = await startServer('second');
  const resumed = await post(second.base, '/api/display/resume', { roomCode, displayToken });
  assert.equal(resumed.status, 200, 'display token must survive a process restart');
  assert.equal(resumed.body.state.currentIndex, before.currentIndex);
  assert.equal(resumed.body.state.phase, 'PAUSED');
  assert.equal(resumed.body.state.audioReady, false, 'audio readiness must be revoked after process restart');
  assert.equal(resumed.body.state.currentPoints, before.points);
  assert.ok(Math.abs(resumed.body.state.totalHeardSeconds - before.heard) < 0.05);
  assert.deepEqual(resumed.body.state.scores, before.scores);
  assert.equal((await post(second.base, '/api/host/join', { roomCode, hostToken })).status, 200, 'host token must survive restart');
  assert.equal((await post(second.base, '/api/captain/join', { roomCode, team:'A', captainToken:tokenA })).status, 200, 'captain A token must survive restart');
  assert.equal((await post(second.base, '/api/captain/join', { roomCode, team:'B', captainToken:tokenB })).status, 200, 'captain B token must survive restart');
  const health = await fetch(second.base + '/api/health').then((r) => r.json());
  assert.equal(health.statePersistence, true);

  const browser = fs.readFileSync('public/game.js', 'utf8');
  assert.match(browser, /setInterval\(ping, 4 \* 60_000\)/, 'main display must send inbound keepalive before Render idle timeout');
  console.log('Durability restart audit passed');
} finally {
  for (const stream of streams) { try { stream.close(); } catch {} }
  if (first?.server?.listening) await new Promise((resolve) => first.server.close(resolve));
  if (second?.server?.listening) await new Promise((resolve) => second.server.close(resolve));
  fs.rmSync(dir, { recursive:true, force:true });
}
