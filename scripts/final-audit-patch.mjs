import fs from 'node:fs';

function replaceOnce(text, oldText, newText, label) {
  if (!text.includes(oldText)) throw new Error(`${label}: source block not found`);
  return text.replace(oldText, newText);
}

// Make manual END GAME fully undoable.
{
  const path = 'src/server.js';
  let s = fs.readFileSync(path, 'utf8');
  s = replaceOnce(
    s,
`  if (action === 'host:endGame') {
    if (['LOBBY', 'FINISHED'].includes(room.phase)) return json(res, 409, { ok: false, error: 'NOT_ALLOWED' });
    if (room.phase === 'PLAYING') sendDisplayEvent(room, 'audio-pause', { seq: room.playbackSeq });
    clearStealTimer(room); room.stealDeadline = null; room.phase = 'FINISHED'; room.revealed = true; broadcastState(room); return json(res, 200, { ok: true });
  }
`,
`  if (action === 'host:endGame') {
    if (['LOBBY', 'FINISHED'].includes(room.phase)) return json(res, 409, { ok: false, error: 'NOT_ALLOWED' });
    snapshot(room);
    if (room.phase === 'PLAYING') sendDisplayEvent(room, 'audio-pause', { seq: room.playbackSeq });
    clearStealTimer(room); room.stealDeadline = null; room.phase = 'FINISHED'; room.revealed = true; broadcastState(room); return json(res, 200, { ok: true });
  }
`,
    'host:endGame snapshot'
  );
  fs.writeFileSync(path, s);
}

// Remove a dead restore variable; keep the actual active-team restore path explicit.
{
  const path = 'public/game.js';
  let s = fs.readFileSync(path, 'utf8');
  s = replaceOnce(
    s,
    "      const restoreOrder = ['A','B'].includes(activeTeam) ? [activeTeam] : savedTeams.map((entry) => entry.team);\n",
    '',
    'dead restoreOrder'
  );
  fs.writeFileSync(path, s);
}

// Bound the captain manual reconnect request so its button can never hang forever.
{
  const path = 'public/interaction-ui.js';
  let s = fs.readFileSync(path, 'utf8');
  s = replaceOnce(
    s,
`async function reconnectCaptain(button) {
  const session = captainSession();
  if (!session) {
    location.reload();
    return;
  }
  if (button) button.disabled = true;
  try {
    const response = await fetch('/api/captain/join', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ roomCode:session.roomCode, team:session.team, captainToken:session.token })
    });
    const result = await response.json().catch(() => ({ ok:false, error:'BAD_RESPONSE' }));
    if (response.ok && result?.ok && result.captainToken) {
      localStorage.setItem(\`ntt-captain-${'${session.roomCode}'}-${'${session.team}'}\`, JSON.stringify({ roomCode:session.roomCode, team:session.team, captainToken:result.captainToken }));
      localStorage.setItem(\`ntt-captain-active-${'${session.roomCode}'}\`, session.team);
      location.reload();
      return;
    }
    if (button?.isConnected) button.disabled = false;
    if (result?.error === 'TEAM_TAKEN') alert('That team is already connected from another phone.');
    else alert('Could not reconnect. Check the connection and try again.');
  } catch {
    if (button?.isConnected) button.disabled = false;
    alert('Could not reconnect. Check the connection and try again.');
  }
}
`,
`async function reconnectCaptain(button) {
  const session = captainSession();
  if (!session) {
    location.reload();
    return;
  }
  if (button) button.disabled = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch('/api/captain/join', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ roomCode:session.roomCode, team:session.team, captainToken:session.token }),
      signal:controller.signal
    });
    const result = await response.json().catch(() => ({ ok:false, error:'BAD_RESPONSE' }));
    if (response.ok && result?.ok && result.captainToken) {
      localStorage.setItem(\`ntt-captain-${'${session.roomCode}'}-${'${session.team}'}\`, JSON.stringify({ roomCode:session.roomCode, team:session.team, captainToken:result.captainToken }));
      localStorage.setItem(\`ntt-captain-active-${'${session.roomCode}'}\`, session.team);
      location.reload();
      return;
    }
    if (button?.isConnected) button.disabled = false;
    if (result?.error === 'TEAM_TAKEN') alert('That team is already connected from another phone.');
    else alert('Could not reconnect. Check the connection and try again.');
  } catch {
    if (button?.isConnected) button.disabled = false;
    alert('Could not reconnect. Check the connection and try again.');
  } finally {
    clearTimeout(timeout);
  }
}
`,
    'captain reconnect timeout'
  );
  fs.writeFileSync(path, s);
}

// Bound and retry reveal auto-advance so a stalled POST cannot strand the game in REVEAL.
{
  const path = 'public/reveal-audio.js';
  let s = fs.readFileSync(path, 'utf8');
  s = replaceOnce(
    s,
    "  let revealAdvancePending = false;\n",
    "  let revealAdvancePending = false;\n  let revealAdvanceRetryTimer = null;\n",
    'reveal retry state'
  );
  s = replaceOnce(
    s,
`    clearTimeout(revealRetryTimer);
    revealRetryTimer = null;
    stopRevealFade();
`,
`    clearTimeout(revealRetryTimer);
    revealRetryTimer = null;
    clearTimeout(revealAdvanceRetryTimer);
    revealAdvanceRetryTimer = null;
    stopRevealFade();
`,
    'reveal retry cleanup'
  );
  s = replaceOnce(
    s,
`  async function advanceAfterReveal(filename) {
    if (revealAdvancePending || document.body.dataset.phase !== 'REVEAL' || !filename) return;
    const saved = displaySession();
    if (!saved) return;
    revealAdvancePending = true;
    try {
      const response = await fetch('/api/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'display:revealEnded', roomCode: saved.roomCode, token: saved.displayToken, filename })
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) {
        revealAdvancePending = false;
        console.warn('Could not auto-advance after reveal audio.', result);
      }
    } catch (error) {
      revealAdvancePending = false;
      console.warn('Could not auto-advance after reveal audio.', error);
    }
  }
`,
`  async function advanceAfterReveal(filename, attempt = 0) {
    if (revealAdvancePending || document.body.dataset.phase !== 'REVEAL' || !filename) return;
    const saved = displaySession();
    if (!saved) return;
    revealAdvancePending = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    let failed = false;
    try {
      const response = await fetch('/api/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'display:revealEnded', roomCode: saved.roomCode, token: saved.displayToken, filename }),
        signal: controller.signal
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) {
        failed = true;
        console.warn('Could not auto-advance after reveal audio.', result);
      }
    } catch (error) {
      failed = true;
      console.warn('Could not auto-advance after reveal audio.', error);
    } finally {
      clearTimeout(timeout);
      if (failed) {
        revealAdvancePending = false;
        if (attempt < 2 && document.body.dataset.phase === 'REVEAL' && lastRevealFilename === filename) {
          clearTimeout(revealAdvanceRetryTimer);
          revealAdvanceRetryTimer = setTimeout(() => advanceAfterReveal(filename, attempt + 1), 700 * (attempt + 1));
        }
      }
    }
  }
`,
    'reveal auto-advance timeout/retry'
  );
  fs.writeFileSync(path, s);
}

// Update regression tests to cover the real logic instead of an unused variable.
{
  const path = 'test/captain-session.test.js';
  let s = fs.readFileSync(path, 'utf8');
  s = replaceOnce(
    s,
    "assert.match(game, /restoreOrder = .*activeTeam/, 'captain restore must prefer the active team instead of always Team A');\n",
    "assert.match(game, /candidate = savedTeams\\.find\\(\\(entry\\) => entry\\.team === activeTeam\\)/, 'captain restore must prefer the active saved team instead of always Team A');\n",
    'captain restore regression assertion'
  );
  fs.writeFileSync(path, s);
}

// Integration coverage: manual END GAME must undo to the exact previous state.
{
  const path = 'test/resilience-audit.test.js';
  let s = fs.readFileSync(path, 'utf8');
  s = replaceOnce(
    s,
`  assert.equal(state.currentIndex, 0);
  assert.equal(state.round, 'easy');
  assert.equal(state.phase, 'READY');
  assert.deepEqual(state.scores, { A: 0, B: 0 });

  // Host can explicitly free a captain slot during the live game for a replacement phone.
`,
`  assert.equal(state.currentIndex, 0);
  assert.equal(state.round, 'easy');
  assert.equal(state.phase, 'READY');
  assert.deepEqual(state.scores, { A: 0, B: 0 });

  // Manual END GAME is itself undoable and returns to the immediately preceding safe state.
  assert.equal((await post('/api/action', { action: 'host:endGame', roomCode, token: hostToken })).status, 200);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'FINISHED');
  assert.equal((await post('/api/action', { action: 'host:undo', roomCode, token: hostToken })).status, 200);
  state = (await post('/api/host/join', { roomCode, hostToken })).body.state;
  assert.equal(state.phase, 'READY');
  assert.equal(state.currentIndex, 0);

  // Host can explicitly free a captain slot during the live game for a replacement phone.
`,
    'end game undo integration coverage'
  );
  fs.writeFileSync(path, s);
}

// Extend the second-pass static audit to the remaining network paths.
{
  const path = 'test/second-pass-audit.test.js';
  let s = fs.readFileSync(path, 'utf8');
  s = replaceOnce(
    s,
    "const interaction = fs.readFileSync('public/interaction-ui.js', 'utf8');\n",
    "const interaction = fs.readFileSync('public/interaction-ui.js', 'utf8');\nconst reveal = fs.readFileSync('public/reveal-audio.js', 'utf8');\nconst server = fs.readFileSync('src/server.js', 'utf8');\n",
    'second-pass test inputs'
  );
  s = replaceOnce(
    s,
    "assert.match(interaction, /host:undo/, 'final state must expose undo');\n",
    "assert.match(interaction, /host:undo/, 'final state must expose undo');\nassert.match(interaction, /signal:controller\\.signal/, 'captain recovery requests need a finite timeout');\nassert.match(reveal, /advanceAfterReveal\\(filename, attempt = 0\\)/, 'reveal auto-advance must support bounded retries');\nassert.match(reveal, /signal: controller\\.signal/, 'reveal auto-advance must have a finite timeout');\nassert.match(server, /host:endGame[\\s\\S]*?snapshot\\(room\\)/, 'manual end game must snapshot before finishing so final undo is exact');\n",
    'second-pass network assertions'
  );
  fs.writeFileSync(path, s);
}

console.log('Final audit patch applied');
