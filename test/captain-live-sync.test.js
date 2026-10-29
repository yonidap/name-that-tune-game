import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { createServer } from '../src/server.js';

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const streams = [];

async function post(route, body) {
  const response = await fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

function sse({ room, role, token, team }) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ room, role, token });
    if (team) params.set('team', team);
    const req = http.get(base + '/events?' + params, (res) => {
      if (res.statusCode !== 200) return reject(new Error('SSE ' + res.statusCode));
      res.once('data', () => resolve({ req, res }));
      res.on('data', () => {});
    });
    req.on('error', reject);
  });
}

try {
  const created = await post('/api/display/create', { gameLength: 'short' });
  const { roomCode, displayToken, hostPin } = created.body;
  const host = await post('/api/host/join', { roomCode, hostPin });
  const a = await post('/api/captain/join', { roomCode, team: 'A' });
  const b = await post('/api/captain/join', { roomCode, team: 'B' });

  streams.push(await sse({ room: roomCode, role: 'display', token: displayToken }));
  streams.push(await sse({ room: roomCode, role: 'host', token: host.body.hostToken }));
  const staleA = await sse({ room: roomCode, role: 'captain', team: 'A', token: a.body.captainToken });
  streams.push(staleA);
  streams.push(await sse({ room: roomCode, role: 'captain', team: 'B', token: b.body.captainToken }));

  await post('/api/action', { action: 'display:audioReady', roomCode, token: displayToken, ready: true });
  const started = await post('/api/action', { action: 'host:start', roomCode, token: host.body.hostToken });
  assert.equal(started.status, 200);

  const polledA = await post('/api/state', { roomCode, role: 'captain', team: 'A', token: a.body.captainToken });
  assert.equal(polledA.status, 200);
  assert.equal(polledA.body.state.phase, 'READY');
  assert.equal(polledA.body.state.activeTeam, 'A');

  let oldClosed = false;
  staleA.res.once('close', () => { oldClosed = true; });
  const reconnected = await post('/api/captain/join', {
    roomCode,
    team: 'A',
    captainToken: a.body.captainToken,
    forceReconnect: true
  });
  assert.equal(reconnected.status, 200);
  assert.equal(reconnected.body.state.phase, 'READY');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(oldClosed, true, 'force reconnect must close the stale captain SSE');

  const client = fs.readFileSync('public/game.js', 'utf8');
  assert.match(client, /setInterval\(pollAuthoritativeState, 1500\)/);
  assert.match(client, /ntt:captain-reconnected/);
  const interaction = fs.readFileSync('public/interaction-ui.js', 'utf8');
  assert.match(interaction, /forceReconnect:true/);
  assert.doesNotMatch(interaction, /result\.captainToken[\s\S]{0,500}location\.reload\(\)/);

  console.log('Captain live-sync recovery audit passed');
} finally {
  for (const stream of streams) {
    try { stream.req.destroy(); } catch {}
  }
  await new Promise((resolve) => server.close(resolve));
}
