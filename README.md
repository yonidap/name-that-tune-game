# Name That Tune — real-time party game

A two-team music guessing game with a dedicated audience/game screen, a host-controller phone, and one captain phone per team. The game screen is connected to the speakers. Captains control playback; only the host judges answers and advances the game.

## Current game flow

- Two teams, one captain each.
- Dedicated audience/game screen with no admin controls.
- Separate host-controller phone protected by a 4-digit room PIN.
- Join by QR code or 4-character room code.
- Easy / Medium / Hard rounds.
- Game lengths: Quick Hit (15 songs), Main Event (21), Full Battle (44).
- Turns alternate between teams; Medium starts with the opposite team to reduce first-player bias.
- Captains can PLAY, STOP, continue the current play, and LOCK ANSWER.
- STOP only pauses the audio; thinking time does not reduce the score.
- The host is the only client that can mark CORRECT / WRONG, REVEAL, NEXT, UNDO, or manually correct scores.
- The answer is never sent to captain clients. It is sent to the audience screen only after reveal.

## Scoring and playback

A normal turn starts at **10 points**.

### First playback

As more of the configured snippet is heard, the value falls from **10 → 9 → 8 → 7 → 6 → 5**. If the first complete playback finishes, the song is worth **5 points**.

The captain may stop and continue the first playback as many times as needed. Pausing does not consume a playback and does not reduce the score.

### One replay only

After the first complete playback, the captain gets exactly **one replay from the beginning**. During that second playback the value continues down from **5 → 4 → 3 → 2**.

After the second complete playback:

- the value is **2 points**;
- playback is disabled;
- the captain must lock an answer.

A third playback is rejected by the server, not merely hidden in the UI.

## Wrong answers and steal

When the active team locks an answer, the host marks it correct or wrong.

- Correct: the active team receives the current point value.
- Wrong: the other team gets a **10-second steal window** worth **1 point**.
- The stealing captain must lock an answer before the timer expires.
- An unlocked steal automatically expires and reveals the song.
- The host can judge a steal only after the stealing captain has locked it.

## Resilience and controls

- Server-side state is authoritative for phase, score, playback count, timing, and permissions.
- Stale audio progress events are ignored with a per-playback sequence number.
- Pending browser playback commands and stale audio loads are cancelled when the game leaves `PLAYING` or changes songs, preventing a delayed `PLAY` from restarting after `STOP` / `REVEAL`.
- If the main game screen disconnects during playback, the room fails safe to `PAUSED` and audio readiness is revoked.
- After a display refresh, the display session is validated before restoration and speakers must be enabled again.
- Host and captain phones can reconnect using their saved tokens; recovery requests have finite network timeouts.
- Reveal auto-advance has a finite request timeout and bounded retry path; the host can still use `NEXT` manually.
- The host can reset a stuck captain slot during the lobby or an active game; an active playback is paused before that slot is released.
- `UNDO` restores the previous meaningful game state. Manual `END GAME` creates its own snapshot, so undoing from the final screen returns to the immediately preceding safe state.
- The host keeps `UNDO` and score-correction controls on the final-score screen.
- `PLAY AGAIN` starts a fresh shuffled game with the same room/controllers and clears the old score/history.
- The main display also offers `NEW ROOM` after the game ends.

## Audio handling

The game expects pre-cut snippets in `public/audio/` using the filenames defined in `data/songs.js`; reveal clips live in `public/audio/reveal/` with matching filenames.

Example:

```text
public/audio/toxic.mp3
public/audio/billie-jean.mp3
...
```

The configured `duration` in `data/songs.js` is the authoritative snippet length. If a media file is slightly longer, playback is stopped at the configured duration. If it ends slightly earlier, the media end still completes that playback.

When a file is missing or cannot load, the display falls back to a generated demo tone **and shows a visible warning on both the host controller and audience screen**. This keeps the mechanics testable without silently pretending the real song loaded.

The `sourceStart` field is only a preparation reference for cutting the source audio. Timings can differ between releases and karaoke/instrumental versions, so verify each final snippet by ear.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000/host` on the computer connected to the speakers. Create a room, scan the Captain/Host QR codes, enable speakers on the game screen, then start from the host phone.

## Automated audit

```bash
npm run check
npm test
```

CI runs both commands on every push and pull request. The integration test exercises the real HTTP/SSE state machine, including:

- room creation and reconnect;
- server-side start gating;
- 10 → 5 → 2 scoring across two playbacks;
- pause/continue behavior;
- rejection of a third playback;
- answer locking and undo;
- correct scoring;
- steal timeout;
- display disconnect fail-safe;
- captain-slot reset;
- manual end-game undo;
- client audio-race guards and final-score recovery controls;
- the 44-song bank and 14/18/12 difficulty split.

## State machine

```text
LOBBY
  → READY ↔ PLAYING ↔ PAUSED
  → ANSWER_LOCKED
      ├─ correct → REVEAL
      └─ wrong   → STEAL → STEAL_LOCKED → REVEAL
                         ↘ timeout → REVEAL
  → next song / ROUND_INTRO at a difficulty transition
  → FINISHED
```

## Architecture

The app intentionally stays small:

- `src/server.js` — the single authoritative game server/state machine.
- `public/game.js` — the main browser controller for audience, host, and captain modes.
- `public/reveal-audio.js` — reveal-clip playback and auto-advance.
- `public/interaction-ui.js` — supplemental captain/host recovery controls.
- HTTP POST actions — client commands.
- Server-Sent Events (SSE) — real-time server-to-client state and audio commands.
- `data/songs.js` — song metadata and snippet durations.
- `test/integration.test.js` — end-to-end state-machine audit.

There is one authoritative game server; the supplemental browser scripts do not own game state.

## Production limitations

The current MVP stores rooms **in the Node process memory**. A Render restart, redeploy, or process crash will erase active rooms. This is acceptable for development and a single party session, but it is the main remaining architectural limitation. Do not deploy changes during an active game. A future hardened version should persist room snapshots in Redis/Postgres.

The QR generator and Google Fonts are loaded from external CDNs. If the QR library cannot load, the room code/manual join path still works; if the fonts fail, browser fallback fonts are used.

The host PIN is intended for a low-stakes private party game, not strong authentication. There is currently no brute-force rate limiting on the 4-digit PIN.
