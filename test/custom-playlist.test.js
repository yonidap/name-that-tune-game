import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { songs } from '../data/songs.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntt-custom-'));
process.env.GAME_STATE_FILE = path.join(tempDir, 'rooms.json');
const { createServer } = await import('../src/server.js?custom-test=' + Date.now());
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const post = async (route, body) => {
  const res = await fetch(base + route, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
  return { status:res.status, body:await res.json() };
};
function connectDisplay(roomCode, token) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ room:roomCode, role:'display', token });
    const req = http.get(base + '/events?' + params, (res) => {
      if (res.statusCode !== 200) return reject(new Error('Display SSE returned '+res.statusCode));
      res.on('data', () => {});
      resolve({ close:() => req.destroy() });
    });
    req.on('error', reject);
  });
}
let display;
try {
  const catalogResponse = await fetch(base + '/api/song-catalog');
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.songs.length, 44);
  assert.deepEqual(
    catalog.songs.map(({id,title,artist,difficulty}) => ({id,title,artist,difficulty})),
    songs.map(({id,title,artist,difficulty}) => ({id,title,artist,difficulty}))
  );
  assert.ok(catalog.songs.every((s) => !('audioFile' in s)), 'song setup should expose only searchable metadata');

  for (const songIds of [[], ['unknown'], ['toxic','toxic'], ['toxic',42], null, ['toxic', ...Array(50).fill('toxic')]]) {
    const response = await post('/api/display/create', {gameLength:'custom',songIds});
    assert.equal(response.status, 400, 'invalid custom song list must be rejected');
    assert.equal(response.body.error, 'INVALID_SONG_SELECTION');
  }

  const selectedIds = ['adoni', 'unicorn', 'toxic', 'i-will-survive', 'halaliyot'];
  const expected = new Set(selectedIds);
  const created = await post('/api/display/create', {
    gameLength:'custom', songIds:selectedIds, teamNames:{A:'Alpha',B:'Beta'}
  });
  assert.equal(created.status, 200);
  const { roomCode, displayToken, hostPin } = created.body;
  assert.equal(created.body.state.totalSongs, selectedIds.length);
  assert.equal(created.body.state.gameLength, 'custom');

  await pause(250);
  let persisted = JSON.parse(fs.readFileSync(process.env.GAME_STATE_FILE, 'utf8')).rooms.find((r) => r.code === roomCode);
  assert.deepEqual(persisted.selectedSongIds, selectedIds, 'selection must be part of durable room checkpoint');
  assert.deepEqual(new Set(persisted.playlist.map((s) => s.id)), expected);
  assert.equal(persisted.playlist.length, selectedIds.length);
  assert.deepEqual(persisted.playlist.map((s) => s.difficulty), ['easy','easy','medium','medium','hard']);
  assert.ok(persisted.playlist.every((s) => Array.isArray(s.scoring) && s.scoring.length > 0));

  const host = await post('/api/host/join', {roomCode,hostPin});
  assert.equal(host.status, 200);
  const hostToken = host.body.hostToken;
  await post('/api/captain/join', {roomCode,team:'A'});
  await post('/api/captain/join', {roomCode,team:'B'});
  display = await connectDisplay(roomCode,displayToken);
  assert.equal((await post('/api/action',{action:'display:audioReady',roomCode,token:displayToken,ready:true})).status,200);
  assert.equal((await post('/api/action',{action:'host:start',roomCode,token:hostToken})).status,200);

  const encountered = [];
  let transitions = 0;
  for (let i = 0; i < selectedIds.length; i++) {
    let state = (await post('/api/host/join',{roomCode,hostToken})).body.state;
    if (state.phase === 'ROUND_INTRO') {
      transitions += 1;
      assert.equal((await post('/api/action',{action:'host:beginRound',roomCode,token:hostToken})).status,200);
      state = (await post('/api/host/join',{roomCode,hostToken})).body.state;
    }
    assert.equal(state.phase,'READY');
    assert.equal(state.songNumber,i+1);
    encountered.push(state.song.id);
    assert.equal((await post('/api/action',{action:'host:reveal',roomCode,token:hostToken})).status,200);
    assert.equal((await post('/api/action',{action:'host:next',roomCode,token:hostToken})).status,200);
  }
  assert.deepEqual(new Set(encountered),expected,'only requested songs can play');
  assert.equal(transitions,2,'Easy → Medium → Hard transitions must still work');
  let state = (await post('/api/host/join',{roomCode,hostToken})).body.state;
  assert.equal(state.phase,'FINISHED');
  assert.equal((await post('/api/action',{action:'host:restart',roomCode,token:hostToken})).status,200);
  state = (await post('/api/host/join',{roomCode,hostToken})).body.state;
  assert.equal(state.phase,'READY');
  assert.equal(state.totalSongs,selectedIds.length);
  await pause(250);
  persisted = JSON.parse(fs.readFileSync(process.env.GAME_STATE_FILE,'utf8')).rooms.find((r) => r.code === roomCode);
  assert.deepEqual(new Set(persisted.playlist.map((s) => s.id)),expected,'Play Again must preserve the curated set');

  const onlyHard = await post('/api/display/create',{gameLength:'custom',songIds:['unicorn']});
  assert.equal(onlyHard.status,200);
  assert.equal(onlyHard.body.state.totalSongs,1);
  await pause(250);
  const hardRoom = JSON.parse(fs.readFileSync(process.env.GAME_STATE_FILE,'utf8')).rooms.find((r) => r.code === onlyHard.body.roomCode);
  assert.equal(hardRoom.playlist[0].difficulty,'hard');
  assert.equal(hardRoom.round,'hard','sparse rounds must start in the selected difficulty');

  const regular = await post('/api/display/create',{gameLength:'short',songIds:['unknown']});
  assert.equal(regular.status,200,'preset modes must ignore custom-only input');
  assert.equal(regular.body.state.totalSongs,15);
  console.log('Custom song selection audit passed');
} finally {
  display?.close();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, {recursive:true,force:true});
}
