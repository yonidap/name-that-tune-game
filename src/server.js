import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { songs } from '../data/songs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const rooms = new Map();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GAME_LENGTHS = {
  short: { easy: 5, medium: 5, hard: 5 },
  normal: { easy: 7, medium: 7, hard: 7 },
  full: { easy: 12, medium: 14, hard: 14 }
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.svg': 'image/svg+xml'
};

function token() { return crypto.randomBytes(18).toString('base64url'); }
function makeRoomCode() {
  for (let tries = 0; tries < 30; tries += 1) {
    let code = '';
    for (let i = 0; i < 4; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Unable to allocate room code');
}
function shuffle(input) {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
function scoringFor(duration) {
  return [0.2, 0.4, 0.62, 0.82, 1].map((fraction, index) => ({ until: Number((duration * fraction).toFixed(2)), points: 5 - index }));
}
function makePlaylist(lengthKey) {
  const counts = GAME_LENGTHS[lengthKey] || GAME_LENGTHS.normal;
  return ['easy', 'medium', 'hard'].flatMap((difficulty) => shuffle(songs.filter((s) => s.difficulty === difficulty)).slice(0, counts[difficulty]).map((song) => ({ ...song, scoring: scoringFor(song.duration) })));
}
function currentSong(room) { return room.currentIndex >= 0 ? room.playlist[room.currentIndex] : null; }
function getPoints(song, seconds) {
  if (!song) return 5;
  const clamped = Math.max(0, Math.min(Number(seconds) || 0, song.duration));
  return song.scoring.find((tier) => clamped <= tier.until)?.points ?? 1;
}
function roundLabel(difficulty) { return difficulty === 'easy' ? 'EASY' : difficulty === 'medium' ? 'MEDIUM' : 'HARD'; }
function connectionStatus(room) {
  const clients = [...room.clients];
  return {
    host: clients.some((c) => c.role === 'host'),
    A: clients.some((c) => c.role === 'captain' && c.team === 'A'),
    B: clients.some((c) => c.role === 'captain' && c.team === 'B')
  };
}
function publicState(room, role, team = null) {
  const song = currentSong(room);
  const common = {
    roomCode: room.code, phase: room.phase, round: room.round, roundLabel: roundLabel(room.round), currentIndex: room.currentIndex,
    totalSongs: room.playlist.length, activeTeam: room.activeTeam, turnOwner: room.turnOwner, scores: room.scores, teamNames: room.teamNames,
    listenedSeconds: Number(room.listenedSeconds.toFixed(2)), currentPoints: room.currentPoints, duration: song?.duration ?? 0,
    scoring: song?.scoring ?? [], connected: connectionStatus(room), stealDeadline: room.stealDeadline,
    songNumber: room.currentIndex + 1, canControl: team ? room.activeTeam === team : false
  };
  if (role === 'host') return { ...common, gameLength: room.gameLength, song: song ? { id: song.id, title: song.title, artist: song.artist, difficulty: song.difficulty, audioFile: song.audioFile, duration: song.duration, sourceStart: song.sourceStart } : null };
  return { ...common, song: song ? { difficulty: song.difficulty, duration: song.duration } : null };
}
function sendSse(client, event, data) {
  try { client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
}
function broadcastState(room) {
  for (const client of room.clients) sendSse(client, 'state', publicState(room, client.role, client.team));
}
function sendHostEvent(room, event, data = {}) {
  for (const client of room.clients) if (client.role === 'host') sendSse(client, event, data);
}
function snapshot(room) {
  room.history.push({ phase: room.phase, currentIndex: room.currentIndex, round: room.round, activeTeam: room.activeTeam, turnOwner: room.turnOwner, scores: { ...room.scores }, listenedSeconds: room.listenedSeconds, currentPoints: room.currentPoints, revealed: room.revealed, stealDeadline: room.stealDeadline });
  if (room.history.length > 30) room.history.shift();
}
function restore(room, state) { Object.assign(room, state, { scores: { ...state.scores } }); }
function turnForIndex(playlist, index) {
  const song = playlist[index]; if (!song) return 'A';
  const roundSongsBefore = playlist.slice(0, index).filter((s) => s.difficulty === song.difficulty).length;
  const roundStarter = song.difficulty === 'medium' ? 'B' : 'A';
  return roundSongsBefore % 2 === 0 ? roundStarter : (roundStarter === 'A' ? 'B' : 'A');
}
function loadSong(room, index) {
  room.currentIndex = index;
  const song = currentSong(room);
  if (!song) { room.phase = 'FINISHED'; room.revealed = true; return; }
  const previousRound = room.round;
  room.round = song.difficulty;
  room.turnOwner = turnForIndex(room.playlist, index);
  room.activeTeam = room.turnOwner;
  room.listenedSeconds = 0; room.currentPoints = 5; room.revealed = false; room.stealDeadline = null;
  room.phase = previousRound !== room.round || index === 0 ? 'ROUND_INTRO' : 'READY';
}
function json(res, status, body) { const data = JSON.stringify(body); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' }); res.end(data); }
async function readJson(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw new Error('Body too large'); }
  return raw ? JSON.parse(raw) : {};
}
function cleanCode(value) { return String(value || '').toUpperCase(); }
function roomOrError(code, res) { const room = rooms.get(cleanCode(code)); if (!room) json(res, 404, { ok: false, error: 'ROOM_NOT_FOUND' }); return room; }
function hostOk(room, suppliedToken) { return Boolean(suppliedToken && suppliedToken === room.hostToken); }
function captainOk(room, team, suppliedToken) { return ['A', 'B'].includes(team) && suppliedToken && room.captainTokens[team] === suppliedToken; }

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  let body; try { body = await readJson(req); } catch { return json(res, 400, { ok: false, error: 'INVALID_JSON' }); }

  if (url.pathname === '/api/host/create') {
    const code = makeRoomCode(); const hostToken = token(); const lengthKey = GAME_LENGTHS[body.gameLength] ? body.gameLength : 'normal';
    const room = {
      code, hostToken, captainTokens: { A: null, B: null }, teamNames: { A: String(body.teamNames?.A || 'Team A').slice(0,24), B: String(body.teamNames?.B || 'Team B').slice(0,24) },
      playlist: makePlaylist(lengthKey), gameLength: lengthKey, phase: 'LOBBY', currentIndex: -1, round: 'easy', activeTeam: 'A', turnOwner: 'A',
      scores: { A: 0, B: 0 }, listenedSeconds: 0, currentPoints: 5, revealed: false, stealDeadline: null, history: [], clients: new Set(), createdAt: Date.now()
    };
    rooms.set(code, room);
    return json(res, 200, { ok: true, roomCode: code, hostToken, state: publicState(room, 'host') });
  }

  if (url.pathname === '/api/captain/join') {
    const room = roomOrError(body.roomCode, res); if (!room) return;
    const team = body.team; if (!['A','B'].includes(team)) return json(res,400,{ok:false,error:'INVALID_TEAM'});
    if (body.captainToken && room.captainTokens[team] === body.captainToken) return json(res,200,{ok:true,captainToken:body.captainToken,state:publicState(room,'captain',team)});
    if (room.captainTokens[team]) return json(res,409,{ok:false,error:'TEAM_TAKEN'});
    const captainToken = token(); room.captainTokens[team] = captainToken; broadcastState(room);
    return json(res,200,{ok:true,captainToken,state:publicState(room,'captain',team)});
  }

  if (url.pathname !== '/api/action') return json(res, 404, { ok: false, error: 'NOT_FOUND' });
  const room = roomOrError(body.roomCode, res); if (!room) return;
  const action = body.action;
  const isHostAction = action.startsWith('host:');
  if (isHostAction && !hostOk(room, body.token)) return json(res, 403, { ok:false,error:'UNAUTHORIZED' });
  if (action.startsWith('captain:') && !captainOk(room, body.team, body.token)) return json(res,403,{ok:false,error:'UNAUTHORIZED'});

  if (action === 'host:start' && room.phase === 'LOBBY') { snapshot(room); loadSong(room,0); broadcastState(room); return json(res,200,{ok:true}); }
  if (action === 'host:beginRound' && room.phase === 'ROUND_INTRO') { room.phase='READY'; broadcastState(room); return json(res,200,{ok:true}); }
  if (action === 'captain:play') {
    if (room.activeTeam !== body.team || !['READY','PAUSED'].includes(room.phase)) return json(res,409,{ok:false,error:'NOT_ALLOWED'});
    room.phase='PLAYING'; sendHostEvent(room,'audio-play',{startAt:room.listenedSeconds}); broadcastState(room); return json(res,200,{ok:true});
  }
  if (action === 'captain:pause') {
    if (room.activeTeam !== body.team || room.phase !== 'PLAYING') return json(res,409,{ok:false,error:'NOT_ALLOWED'});
    sendHostEvent(room,'audio-pause'); return json(res,200,{ok:true});
  }
  if (action === 'host:audioProgress') {
    if (!['PLAYING','PAUSED'].includes(room.phase)) return json(res,200,{ok:true});
    const song=currentSong(room); if (!song) return json(res,409,{ok:false,error:'NO_SONG'});
    room.listenedSeconds=Math.max(room.listenedSeconds,Math.min(Number(body.position)||0,song.duration)); room.currentPoints=getPoints(song,room.listenedSeconds);
    if (body.paused && room.phase==='PLAYING') room.phase='PAUSED'; if (room.listenedSeconds>=song.duration-.03) room.phase='PAUSED';
    broadcastState(room); return json(res,200,{ok:true});
  }
  if (action === 'captain:lockAnswer') {
    if (room.activeTeam!==body.team || !['READY','PAUSED'].includes(room.phase)) return json(res,409,{ok:false,error:'NOT_ALLOWED'});
    room.phase='ANSWER_LOCKED'; broadcastState(room); return json(res,200,{ok:true});
  }
  if (action === 'captain:lockSteal') {
    if (room.activeTeam!==body.team || room.phase!=='STEAL') return json(res,409,{ok:false,error:'NOT_ALLOWED'});
    room.phase='STEAL_LOCKED'; broadcastState(room); return json(res,200,{ok:true});
  }
  if (action === 'host:markCorrect') {
    if (!['ANSWER_LOCKED','STEAL','STEAL_LOCKED'].includes(room.phase)) return json(res,409,{ok:false,error:'NOT_ALLOWED'});
    snapshot(room); const awarded=room.phase.startsWith('STEAL')?1:room.currentPoints; room.scores[room.activeTeam]+=awarded; room.phase='REVEAL'; room.revealed=true; room.stealDeadline=null; broadcastState(room); return json(res,200,{ok:true,awarded});
  }
  if (action === 'host:markWrong') {
    if (room.phase==='ANSWER_LOCKED') { snapshot(room); room.activeTeam=room.turnOwner==='A'?'B':'A'; room.phase='STEAL'; room.stealDeadline=Date.now()+10000; broadcastState(room); return json(res,200,{ok:true,steal:true}); }
    if (['STEAL','STEAL_LOCKED'].includes(room.phase)) { snapshot(room); room.phase='REVEAL'; room.revealed=true; room.stealDeadline=null; broadcastState(room); return json(res,200,{ok:true,steal:false}); }
    return json(res,409,{ok:false,error:'NOT_ALLOWED'});
  }
  if (action === 'host:reveal') { if (room.phase==='PLAYING') sendHostEvent(room,'audio-pause'); snapshot(room); room.phase='REVEAL'; room.revealed=true; room.stealDeadline=null; broadcastState(room); return json(res,200,{ok:true}); }
  if (action === 'host:next') { if (room.phase!=='REVEAL') return json(res,409,{ok:false,error:'NOT_ALLOWED'}); snapshot(room); loadSong(room,room.currentIndex+1); broadcastState(room); return json(res,200,{ok:true}); }
  if (action === 'host:adjustScore') { if (!['A','B'].includes(body.team)) return json(res,400,{ok:false,error:'INVALID_TEAM'}); snapshot(room); room.scores[body.team]=Math.max(0,room.scores[body.team]+Math.max(-10,Math.min(10,Number(body.delta)||0))); broadcastState(room); return json(res,200,{ok:true}); }
  if (action === 'host:undo') { const previous=room.history.pop(); if (!previous) return json(res,409,{ok:false,error:'NO_HISTORY'}); restore(room,previous); sendHostEvent(room,'audio-pause'); broadcastState(room); return json(res,200,{ok:true}); }
  return json(res, 409, { ok:false, error:'NOT_ALLOWED' });
}

function handleEvents(req, res, url) {
  const code=cleanCode(url.searchParams.get('room')); const role=url.searchParams.get('role'); const team=url.searchParams.get('team'); const suppliedToken=url.searchParams.get('token');
  const room=rooms.get(code); if (!room) { res.writeHead(404); return res.end(); }
  if (role==='host' && !hostOk(room,suppliedToken)) { res.writeHead(403); return res.end(); }
  if (role==='captain' && !captainOk(room,team,suppliedToken)) { res.writeHead(403); return res.end(); }
  if (!['host','captain'].includes(role)) { res.writeHead(400); return res.end(); }
  res.writeHead(200, { 'content-type':'text/event-stream', 'cache-control':'no-cache, no-transform', 'connection':'keep-alive', 'x-accel-buffering':'no' });
  res.write(': connected\n\n');
  const client={res,role,team:role==='captain'?team:null}; room.clients.add(client); sendSse(client,'state',publicState(room,role,client.team)); broadcastState(room);
  const heartbeat=setInterval(()=>{ try{res.write(': ping\n\n');}catch{} },15000);
  req.on('close',()=>{ clearInterval(heartbeat); room.clients.delete(client); broadcastState(room); });
}

function serveStatic(req,res,url) {
  let pathname=decodeURIComponent(url.pathname);
  if (pathname==='/' || pathname==='/host' || pathname.startsWith('/join/') || pathname.startsWith('/screen/')) pathname='/index.html';
  const normalized=path.normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/,'');
  const filePath=path.join(publicDir,normalized);
  if (!filePath.startsWith(publicDir)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(filePath,(err,stat)=>{
    if (err || !stat.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200,{ 'content-type':MIME[path.extname(filePath).toLowerCase()]||'application/octet-stream', 'cache-control': pathname.startsWith('/audio/')?'public, max-age=3600':'no-cache' });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  try {
    if (url.pathname==='/events' && req.method==='GET') return handleEvents(req,res,url);
    if (url.pathname.startsWith('/api/')) return await handleApi(req,res,url);
    return serveStatic(req,res,url);
  } catch (error) { console.error(error); if (!res.headersSent) json(res,500,{ok:false,error:'INTERNAL_ERROR'}); else res.end(); }
});

setInterval(()=>{ const staleBefore=Date.now()-12*60*60*1000; for(const [code,room] of rooms.entries()) if(room.createdAt<staleBefore && room.clients.size===0) rooms.delete(code); },30*60*1000).unref();
server.listen(PORT,()=>console.log(`Name That Tune running on http://localhost:${PORT}`));
