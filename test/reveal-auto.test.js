import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';

const { createServer } = await import('../src/server.js');
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

async function post(body) {
  const response = await fetch(`${base}/api/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
async function api(route, body) {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}
function connectSse({ room, role, token, team }) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({ room, role, token });
    if (team) query.set('team', team);
    const req = http.get(`${base}/events?${query}`, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`SSE ${role} failed: ${res.statusCode}`));
      res.on('data', () => {});
      resolve({ close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

const streams = [];
try {
  const created = await api('/api/display/create', { gameLength: 'short', teamNames: { A: 'A', B: 'B' } });
  const { roomCode, displayToken, hostPin } = created.body;
  const host = await api('/api/host/join', { roomCode, hostPin });
  const hostToken = host.body.hostToken;
  const capA = await api('/api/captain/join', { roomCode, team: 'A' });
  const capB = await api('/api/captain/join', { roomCode, team: 'B' });

  streams.push(await connectSse({ room: roomCode, role: 'display', token: displayToken }));
  streams.push(await connectSse({ room: roomCode, role: 'host', token: hostToken }));
  streams.push(await connectSse({ room: roomCode, role: 'captain', team: 'A', token: capA.body.captainToken }));
  streams.push(await connectSse({ room: roomCode, role: 'captain', team: 'B', token: capB.body.captainToken }));

  await post({ action: 'display:audioReady', roomCode, token: displayToken, ready: true });
  assert.equal((await post({ action: 'host:start', roomCode, token: hostToken })).status, 200);

  let displayState = (await api('/api/display/resume', { roomCode, displayToken })).body.state;
  const firstIndex = displayState.currentIndex;
  const filename = path.basename(displayState.song.audioFile);

  assert.equal((await post({ action: 'host:reveal', roomCode, token: hostToken })).status, 200);
  let hostState = (await api('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(hostState.phase, 'REVEAL');

  const stale = await post({ action: 'display:revealEnded', roomCode, token: displayToken, filename: 'wrong-file.mp3' });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.ignored, true);
  hostState = (await api('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(hostState.currentIndex, firstIndex);
  assert.equal(hostState.phase, 'REVEAL');

  const ended = await post({ action: 'display:revealEnded', roomCode, token: displayToken, filename });
  assert.equal(ended.status, 200);
  hostState = (await api('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(hostState.currentIndex, firstIndex + 1, 'reveal end should advance exactly one song');
  assert.ok(['READY', 'ROUND_INTRO', 'FINISHED'].includes(hostState.phase));

  const duplicate = await post({ action: 'display:revealEnded', roomCode, token: displayToken, filename });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.ignored, true);
  const afterDuplicate = (await api('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(afterDuplicate.currentIndex, firstIndex + 1, 'duplicate reveal end must not skip another song');

  console.log('Reveal auto-advance test passed');
} finally {
  for (const stream of streams) { try { stream.close(); } catch {} }
  await new Promise((resolve) => server.close(resolve));
}
