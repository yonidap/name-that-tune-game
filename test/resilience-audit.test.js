import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

process.env.STEAL_MS = '180';
const { createServer } = await import('../src/server.js');
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
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
      if (res.statusCode !== 200) {
        const status = res.statusCode;
        req.destroy();
        return reject(new Error(`SSE ${role}/${team || '-'} failed: ${status}`));
      }
      res.on('data', () => {});
      resolve({ close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

function sseStatus({ room, role, token, team }) {
  return new Promise((resolve) => {
    const query = new URLSearchParams({ room, role, token });
    if (team) query.set('team', team);
    const req = http.get(`${base}/events?${query}`, (res) => {
      const status = res.statusCode;
      req.destroy();
      resolve(status);
    });
    req.on('error', () => resolve(0));
  });
}

const streams = [];
try {
  const created = await post('/api/display/create', {
    gameLength: 'short',
    teamNames: { A: 'A', B: 'B' }
  });
  assert.equal(created.status, 200);
  const { roomCode, displayToken, hostPin } = created.body;

  const host = await post('/api/host/join', { roomCode, hostPin });
  assert.equal(host.status, 200);
  const hostToken = host.body.hostToken;

  const capA = await post('/api/captain/join', { roomCode, team: 'A' });
  const capB = await post('/api/captain/join', { roomCode, team: 'B' });
  assert.equal(capA.status, 200);
  assert.equal(capB.status, 200);
  const tokenA = capA.body.captainToken;
  const tokenB = capB.body.captainToken;

  let displayStream = await connectSse({ room: roomCode, role: 'display', token: displayToken });
  streams.push(displayStream);
  streams.push(await connectSse({ room: roomCode, role: 'host', token: hostToken }));
  let aStream = await connectSse({ room: roomCode, role: 'captain', team: 'A', token: tokenA });
  streams.push(aStream);
  streams.push(await connectSse({ room: roomCode, role: 'captain', team: 'B', token: tokenB }));

  await post('/api/action', { action: 'display:audioReady', roomCode, token: displayToken, ready: true });
  assert.equal((await post('/api/action', { action: 'host:start', roomCode, token: hostToken })).status, 200);

  let state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'READY', 'START GAME must make song 1 playable immediately');
  assert.equal(state.activeTeam, 'A');

  // STOP must become authoritative immediately; it must not wait for a display callback.
  const firstPlay = await post('/api/action', { action: 'captain:play', roomCode, token: tokenA, team: 'A' });
  assert.equal(firstPlay.status, 200);
  assert.equal((await post('/api/action', { action: 'captain:pause', roomCode, token: tokenA, team: 'A' })).status, 200);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'PAUSED');

  // An occupied/connected captain slot cannot be taken over anonymously.
  assert.equal((await post('/api/captain/join', { roomCode, team: 'A' })).status, 409);

  // A genuinely disconnected captain may reconnect from a different phone.
  aStream.close();
  await sleep(3100); // exceeds the 3 s double-claim guard
  const rejoinedA = await post('/api/captain/join', { roomCode, team: 'A' });
  assert.equal(rejoinedA.status, 200);
  const tokenA2 = rejoinedA.body.captainToken;
  assert.notEqual(tokenA2, tokenA, 'replacement phone must receive a fresh captain token');
  assert.equal(
    await sseStatus({ room: roomCode, role: 'captain', team: 'A', token: tokenA }),
    403,
    'the rotated old token must no longer authorize SSE'
  );
  aStream = await connectSse({ room: roomCode, role: 'captain', team: 'A', token: tokenA2 });
  streams.push(aStream);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'PAUSED', 'captain replacement must preserve the current turn state');
  assert.equal(state.activeTeam, 'A');

  // Advance all five Easy songs. Only the real difficulty transition may show ROUND_INTRO.
  for (let index = 0; index < 5; index += 1) {
    state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
    assert.equal(state.currentIndex, index);
    assert.ok(['READY', 'PAUSED'].includes(state.phase));
    assert.equal((await post('/api/action', { action: 'host:reveal', roomCode, token: hostToken })).status, 200);
    assert.equal((await post('/api/action', { action: 'host:next', roomCode, token: hostToken })).status, 200);
  }
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.currentIndex, 5);
  assert.equal(state.round, 'medium');
  assert.equal(state.phase, 'ROUND_INTRO');
  assert.equal(state.activeTeam, 'B', 'Medium must start with Team B');
  assert.equal((await post('/api/action', { action: 'host:beginRound', roomCode, token: hostToken })).status, 200);

  // END GAME must permanently cancel a pending steal timeout.
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  const duration = state.song.duration;
  const bPlay = await post('/api/action', { action: 'captain:play', roomCode, token: tokenB, team: 'B' });
  assert.equal(bPlay.status, 200);
  await post('/api/action', {
    action: 'display:audioProgress', roomCode, token: displayToken,
    seq: bPlay.body.playbackSeq, position: Math.min(0.3, duration / 4), paused: true
  });
  assert.equal((await post('/api/action', { action: 'captain:lockAnswer', roomCode, token: tokenB, team: 'B' })).status, 200);
  assert.equal((await post('/api/action', { action: 'host:markWrong', roomCode, token: hostToken })).status, 200);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'STEAL');
  assert.equal((await post('/api/action', { action: 'host:endGame', roomCode, token: hostToken })).status, 200);
  await sleep(260);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'FINISHED');
  assert.equal(state.stealDeadline, null);

  // PLAY AGAIN must behave like the original start: song 1 is immediately READY.
  assert.equal((await post('/api/action', { action: 'host:restart', roomCode, token: hostToken })).status, 200);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.currentIndex, 0);
  assert.equal(state.round, 'easy');
  assert.equal(state.phase, 'READY');
  assert.deepEqual(state.scores, { A: 0, B: 0 });

  // Host can explicitly free a captain slot during the live game for a replacement phone.
  assert.equal((await post('/api/action', { action: 'host:releaseCaptain', roomCode, token: hostToken, team: 'A' })).status, 200);
  const replacementA = await post('/api/captain/join', { roomCode, team: 'A' });
  assert.equal(replacementA.status, 200);

  // Display refresh/reconnect revokes audio permission, but the same display token may reconnect.
  displayStream.close();
  await sleep(80);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.audioReady, false);
  displayStream = await connectSse({ room: roomCode, role: 'display', token: displayToken });
  streams.push(displayStream);
  assert.equal((await post('/api/action', { action: 'display:audioReady', roomCode, token: displayToken, ready: true })).status, 200);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.audioReady, true);

  // Client-side recovery contracts that caused the real-device failure.
  const game = fs.readFileSync('public/game.js', 'utf8');
  const interaction = fs.readFileSync('public/interaction-ui.js', 'utf8');
  assert.match(game, /isTransientRestoreError/, 'transient restore failures must keep valid sessions');
  assert.match(game, /readStoredJson\('ntt-display'\)/, 'display refresh must restore from the same storage key used by saveDisplay');
  assert.doesNotMatch(game, /ttt-display/, 'legacy typo must never return');
  assert.match(game, /savedTeams\.length > 1/, 'restore must explicitly handle browsers that contain both team sessions');
  assert.match(game, /captainToken = result\.captainToken \|\| saved\.captainToken/, 'restore must use a rotated server token');
  assert.match(game, /display-audio-recovery/, 'display refresh must expose speaker recovery');
  assert.doesNotMatch(interaction, /ensureInitialEasyReady/, 'first-song readiness must stay server-authoritative');

  console.log('Full resilience audit passed');
} finally {
  for (const stream of streams) {
    try { stream.close(); } catch {}
  }
  await new Promise((resolve) => server.close(resolve));
}
