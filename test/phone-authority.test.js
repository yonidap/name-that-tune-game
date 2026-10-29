import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createServer } from '../src/server.js';

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let displayStream = null;

async function post(route, body) {
  const response = await fetch(base + route, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(body)
  });
  return { status:response.status, body:await response.json() };
}

function connectDisplaySse(roomCode, displayToken) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ room:roomCode, role:'display', token:displayToken });
    const req = http.get(`${base}/events?${params}`, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`Display SSE failed: ${res.statusCode}`));
      res.on('data', () => {});
      res.once('data', () => resolve(req));
    });
    req.on('error', reject);
  });
}

try {
  const created = await post('/api/display/create', { gameLength:'short' });
  assert.equal(created.status, 200);
  const { roomCode, displayToken, hostPin } = created.body;

  // The display remains realtime because audio commands must be fail-safe and immediate.
  displayStream = await connectDisplaySse(roomCode, displayToken);

  const host = await post('/api/host/join', { roomCode, hostPin });
  const a = await post('/api/captain/join', { roomCode, team:'A' });
  const b = await post('/api/captain/join', { roomCode, team:'B' });
  assert.equal(host.status, 200);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  // No host/captain SSE connections are created here. Their presence is maintained by authenticated HTTP polling.
  assert.equal((await post('/api/state', { roomCode, role:'host', token:host.body.hostToken })).status, 200);
  assert.equal((await post('/api/state', { roomCode, role:'captain', team:'A', token:a.body.captainToken })).status, 200);
  assert.equal((await post('/api/state', { roomCode, role:'captain', team:'B', token:b.body.captainToken })).status, 200);

  await post('/api/action', { action:'display:audioReady', roomCode, token:displayToken, ready:true });
  const start = await post('/api/action', { action:'host:start', roomCode, token:host.body.hostToken });
  assert.equal(start.status, 200, 'game must start when phone presence comes from polling rather than SSE');

  const stateA = await post('/api/state', { roomCode, role:'captain', team:'A', token:a.body.captainToken });
  const stateB = await post('/api/state', { roomCode, role:'captain', team:'B', token:b.body.captainToken });
  assert.equal(stateA.body.state.phase, 'READY');
  assert.equal(stateA.body.state.activeTeam, 'A');
  assert.equal(stateB.body.state.phase, 'READY');
  assert.equal(stateB.body.state.activeTeam, 'A');
  assert.ok(Number.isInteger(stateA.body.state.revision));
  assert.ok(stateA.body.state.revision > 0);
  assert.equal(typeof stateA.body.state.buildId, 'string');
  assert.equal(typeof stateA.body.state.instanceId, 'string');

  const client = fs.readFileSync('public/game.js', 'utf8');
  assert.match(client, /if \(mode !== 'display'\) \{[\s\S]{0,400}startStatePolling\(\);[\s\S]{0,200}return;/, 'phones must use polling as authoritative state transport');
  assert.match(client, /nextRevision < currentRevision/, 'client must reject stale state revisions');
  assert.match(client, /mode === 'display' \? 1500 : 750/, 'phone polling cadence must be sub-second');
  console.log('Phone authoritative-state audit passed');
} finally {
  try { displayStream?.destroy(); } catch {}
  await new Promise((resolve) => server.close(resolve));
}
