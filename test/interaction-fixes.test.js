import assert from 'node:assert/strict';
import http from 'node:http';

process.env.STEAL_MS = '1000';
const { createServer } = await import('../src/server.js');

const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

async function post(path, body) {
  const response = await fetch(`${base}${path}`, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
  const json = await response.json();
  return { status:response.status, body:json };
}
function connectSse({ room, role, token, team }) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({ room, role, token });
    if (team) query.set('team', team);
    const req = http.get(`${base}/events?${query}`, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`SSE ${role} failed: ${res.statusCode}`));
      res.on('data', () => {});
      resolve({ close:() => req.destroy() });
    });
    req.on('error', reject);
  });
}
const streams = [];
try {
  const created = await post('/api/display/create', { gameLength:'short', teamNames:{ A:'A', B:'B' } });
  const { roomCode, displayToken, hostPin } = created.body;
  const host = await post('/api/host/join', { roomCode, hostPin });
  const hostToken = host.body.hostToken;
  const capA = await post('/api/captain/join', { roomCode, team:'A' });
  const capB = await post('/api/captain/join', { roomCode, team:'B' });
  const tokenA = capA.body.captainToken;
  const tokenB = capB.body.captainToken;

  streams.push(await connectSse({ room:roomCode, role:'display', token:displayToken }));
  streams.push(await connectSse({ room:roomCode, role:'host', token:hostToken }));
  streams.push(await connectSse({ room:roomCode, role:'captain', team:'A', token:tokenA }));
  streams.push(await connectSse({ room:roomCode, role:'captain', team:'B', token:tokenB }));
  await post('/api/action', { action:'display:audioReady', roomCode, token:displayToken, ready:true });
  await post('/api/action', { action:'host:start', roomCode, token:hostToken });
  await post('/api/action', { action:'host:beginRound', roomCode, token:hostToken });

  let state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  const active = state.activeTeam;
  const activeToken = active === 'A' ? tokenA : tokenB;
  const stealTeam = active === 'A' ? 'B' : 'A';
  const stealToken = stealTeam === 'A' ? tokenA : tokenB;
  const duration = state.song.duration;

  let play = await post('/api/action', { action:'captain:play', roomCode, token:activeToken, team:active });
  await post('/api/action', { action:'display:audioEnded', roomCode, token:displayToken, seq:play.body.playbackSeq, position:duration });
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.awaitingReplay, true);
  assert.equal(state.playbacksCompleted, 1);

  play = await post('/api/action', { action:'captain:play', roomCode, token:activeToken, team:active });
  assert.equal(play.status, 200);
  assert.equal(play.body.startAt, 0, 'the second playback starts from the beginning exactly once');
  const replayPosition = duration * 0.43;
  await post('/api/action', { action:'display:audioProgress', roomCode, token:displayToken, seq:play.body.playbackSeq, position:replayPosition, paused:true });
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'PAUSED');
  assert.ok(Math.abs(state.listenedSeconds - replayPosition) < 0.06);

  const resumed = await post('/api/action', { action:'captain:play', roomCode, token:activeToken, team:active });
  assert.equal(resumed.status, 200);
  assert.ok(Math.abs(resumed.body.startAt - replayPosition) < 0.06, 'paused replay must resume from its saved position');
  await post('/api/action', { action:'display:audioProgress', roomCode, token:displayToken, seq:resumed.body.playbackSeq, position:replayPosition + 0.1, paused:true });

  const pass = await post('/api/action', { action:'captain:dontKnow', roomCode, token:activeToken, team:active });
  assert.equal(pass.status, 200);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'STEAL');
  assert.equal(state.activeTeam, stealTeam);
  assert.ok(state.stealDeadline > Date.now());

  const lockSteal = await post('/api/action', { action:'captain:lockSteal', roomCode, token:stealToken, team:stealTeam });
  assert.equal(lockSteal.status, 200);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'STEAL_LOCKED');
  assert.equal(state.stealDeadline, null, 'steal timer deadline must be cleared when answer is locked');

  await post('/api/action', { action:'host:markWrong', roomCode, token:hostToken });
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'REVEAL');

  await post('/api/action', { action:'host:next', roomCode, token:hostToken });
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  if (state.phase === 'ROUND_INTRO') await post('/api/action', { action:'host:beginRound', roomCode, token:hostToken });
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  const active2 = state.activeTeam;
  const activeToken2 = active2 === 'A' ? tokenA : tokenB;
  const stealTeam2 = active2 === 'A' ? 'B' : 'A';
  const stealToken2 = stealTeam2 === 'A' ? tokenA : tokenB;
  play = await post('/api/action', { action:'captain:play', roomCode, token:activeToken2, team:active2 });
  await post('/api/action', { action:'display:audioProgress', roomCode, token:displayToken, seq:play.body.playbackSeq, position:0.2, paused:true });
  const pass2 = await post('/api/action', { action:'captain:dontKnow', roomCode, token:activeToken2, team:active2 });
  assert.equal(pass2.status, 200);
  const stealPass = await post('/api/action', { action:'captain:dontKnow', roomCode, token:stealToken2, team:stealTeam2 });
  assert.equal(stealPass.status, 200);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'REVEAL');
  assert.equal(state.stealDeadline, null);

  console.log('Interaction fixes passed');
} finally {
  for (const stream of streams) { try { stream.close(); } catch {} }
  await new Promise((resolve) => server.close(resolve));
}
