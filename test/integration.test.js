import assert from 'node:assert/strict';
import http from 'node:http';
import { songs } from '../data/songs.js';

process.env.STEAL_MS = '180';
const { createServer } = await import('../src/server.js');

const ids = new Set(songs.map((song) => song.id));
assert.equal(songs.length, 44, 'song bank should contain 44 songs');
assert.equal(ids.size, songs.length, 'song ids must be unique');
assert.deepEqual(
  Object.fromEntries(['easy','medium','hard'].map((d) => [d, songs.filter((s) => s.difficulty === d).length])),
  { easy:14, medium:18, hard:12 },
  'difficulty counts must stay 14/18/12'
);
assert.ok(songs.every((s) => s.duration > 0 && s.audioFile.startsWith('/audio/')), 'every song needs duration and audio path');

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
      resolve({ req, res, close:() => req.destroy() });
    });
    req.on('error', reject);
  });
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const streams = [];
try {
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);

  const fullCreated = await post('/api/display/create', { gameLength:'full', teamNames:{ A:'Full A', B:'Full B' } });
  assert.equal(fullCreated.status, 200);
  assert.equal(fullCreated.body.state.totalSongs, 44, 'Full Battle must include all 44 songs');

  const created = await post('/api/display/create', { gameLength:'normal', teamNames:{ A:'Alpha', B:'Beta' } });
  assert.equal(created.status, 200);
  const { roomCode, displayToken, hostPin } = created.body;
  assert.equal(created.body.state.totalSongs, 21);

  const resume = await post('/api/display/resume', { roomCode, displayToken });
  assert.equal(resume.status, 200);
  assert.equal(resume.body.hostPin, hostPin);

  const hostJoin = await post('/api/host/join', { roomCode, hostPin });
  assert.equal(hostJoin.status, 200);
  const hostToken = hostJoin.body.hostToken;

  const joinA = await post('/api/captain/join', { roomCode, team:'A' });
  const joinB = await post('/api/captain/join', { roomCode, team:'B' });
  assert.equal(joinA.status, 200); assert.equal(joinB.status, 200);
  const tokenA = joinA.body.captainToken; const tokenB = joinB.body.captainToken;

  const earlyStart = await post('/api/action', { action:'host:start', roomCode, token:hostToken });
  assert.equal(earlyStart.status, 409);
  assert.equal(earlyStart.body.error, 'ROOM_NOT_READY');

  streams.push(await connectSse({ room:roomCode, role:'display', token:displayToken }));
  streams.push(await connectSse({ room:roomCode, role:'host', token:hostToken }));
  streams.push(await connectSse({ room:roomCode, role:'captain', team:'A', token:tokenA }));
  streams.push(await connectSse({ room:roomCode, role:'captain', team:'B', token:tokenB }));
  await post('/api/action', { action:'display:audioReady', roomCode, token:displayToken, ready:true });

  const start = await post('/api/action', { action:'host:start', roomCode, token:hostToken });
  assert.equal(start.status, 200);
  let state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'READY', 'START GAME must make song 1 playable immediately');
  assert.equal(state.currentPoints, 10);
  assert.equal(state.totalHeardSeconds, 0);
  assert.equal(state.activeTeam, 'A');
  const duration = state.song.duration;

  const blindLock = await post('/api/action', { action:'captain:lockAnswer', roomCode, token:tokenA, team:'A' });
  assert.equal(blindLock.status, 409);
  assert.equal(blindLock.body.error, 'HEAR_SOMETHING_FIRST');

  let play = await post('/api/action', { action:'captain:play', roomCode, token:tokenA, team:'A' });
  assert.equal(play.status, 200);
  let seq = play.body.playbackSeq;
  await post('/api/action', { action:'display:audioProgress', roomCode, token:displayToken, seq, position:duration * 0.5, paused:false });
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.currentPoints, 8);
  assert.ok(Math.abs(state.totalHeardSeconds - duration * 0.5) < 0.05);

  await post('/api/action', { action:'captain:pause', roomCode, token:tokenA, team:'A' });
  await post('/api/action', { action:'display:audioProgress', roomCode, token:displayToken, seq, position:duration * 0.5, paused:true });
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'PAUSED');

  play = await post('/api/action', { action:'captain:play', roomCode, token:tokenA, team:'A' });
  seq = play.body.playbackSeq;
  await post('/api/action', { action:'display:audioEnded', roomCode, token:displayToken, seq, position:Math.max(0, duration - 0.4) });
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.playbacksCompleted, 1, 'a slightly shorter media file should still count as a complete configured snippet');
  assert.equal(state.awaitingReplay, true);
  assert.equal(state.currentPoints, 5);

  play = await post('/api/action', { action:'captain:play', roomCode, token:tokenA, team:'A' });
  seq = play.body.playbackSeq;
  await post('/api/action', { action:'display:audioProgress', roomCode, token:displayToken, seq, position:duration * 0.5, paused:false });
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.currentPoints, 4);

  await post('/api/action', { action:'display:audioEnded', roomCode, token:displayToken, seq, position:duration });
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.playbacksCompleted, 2);
  assert.equal(state.currentPoints, 2);
  assert.equal(state.canPlay, false);
  assert.equal((await post('/api/action', { action:'captain:play', roomCode, token:tokenA, team:'A' })).status, 409);

  assert.equal((await post('/api/action', { action:'captain:lockAnswer', roomCode, token:tokenA, team:'A' })).status, 200);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'ANSWER_LOCKED');
  assert.equal((await post('/api/action', { action:'host:undo', roomCode, token:hostToken })).status, 200);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'PAUSED', 'undo after lock must only unlock the answer');
  assert.equal(state.currentPoints, 2);
  assert.equal((await post('/api/action', { action:'captain:lockAnswer', roomCode, token:tokenA, team:'A' })).status, 200);

  const correct = await post('/api/action', { action:'host:markCorrect', roomCode, token:hostToken });
  assert.equal(correct.status, 200); assert.equal(correct.body.awarded, 2);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.scores.A, 2); assert.equal(state.phase, 'REVEAL');

  assert.equal((await post('/api/action', { action:'host:next', roomCode, token:hostToken })).status, 200);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  if (state.phase === 'ROUND_INTRO') await post('/api/action', { action:'host:beginRound', roomCode, token:hostToken });
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  const active = state.activeTeam;
  const activeToken = active === 'A' ? tokenA : tokenB;
  const d2 = state.song.duration;
  play = await post('/api/action', { action:'captain:play', roomCode, token:activeToken, team:active });
  seq = play.body.playbackSeq;
  await post('/api/action', { action:'display:audioProgress', roomCode, token:displayToken, seq, position:d2 * 0.1, paused:true });
  await post('/api/action', { action:'captain:lockAnswer', roomCode, token:activeToken, team:active });
  await post('/api/action', { action:'host:markWrong', roomCode, token:hostToken });
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'STEAL');
  await sleep(260);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'REVEAL', 'unlocked steal should auto-expire to reveal');

  await post('/api/action', { action:'host:next', roomCode, token:hostToken });
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  if (state.phase === 'ROUND_INTRO') await post('/api/action', { action:'host:beginRound', roomCode, token:hostToken });
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  const active3 = state.activeTeam;
  const token3 = active3 === 'A' ? tokenA : tokenB;
  play = await post('/api/action', { action:'captain:play', roomCode, token:token3, team:active3 });
  assert.equal(play.status, 200);
  streams[0].close();
  await sleep(60);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.audioReady, false, 'display disconnect must revoke audio readiness');
  assert.equal(state.phase, 'PAUSED', 'display disconnect during playback must fail safe to PAUSED');

  const created2 = await post('/api/display/create', { gameLength:'short', teamNames:{ A:'A', B:'B' } });
  const host2 = await post('/api/host/join', { roomCode:created2.body.roomCode, hostPin:created2.body.hostPin });
  const cap2 = await post('/api/captain/join', { roomCode:created2.body.roomCode, team:'A' });
  assert.equal(cap2.status, 200);
  const release = await post('/api/action', { action:'host:releaseCaptain', roomCode:created2.body.roomCode, token:host2.body.hostToken, team:'A' });
  assert.equal(release.status, 200);
  const cap2Again = await post('/api/captain/join', { roomCode:created2.body.roomCode, team:'A' });
  assert.equal(cap2Again.status, 200, 'host should be able to reset a captain slot in lobby');

  console.log('Integration audit passed');
} finally {
  for (const stream of streams) { try { stream.close(); } catch {} }
  await new Promise((resolve) => server.close(resolve));
}
