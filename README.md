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
- Host and captain phones fetch authenticated authoritative snapshots every 750 ms. They do not depend on a long-lived SSE connection for game state.
- Every room state carries a monotonic `revision`; clients reject older snapshots so a delayed response cannot roll a phone back to an earlier phase.
- The main display keeps SSE because audio play/pause commands must remain realtime and fail-safe.
- Stale audio progress events are ignored with a per-playback sequence number.
- If the main game screen disconnects during playback, the room fails safe to `PAUSED` and audio readiness is revoked.
- After a display refresh, the display session is validated before restoration and speakers must be enabled again.
- Host and captain phones can reconnect using their saved tokens.
- The host can reset a stuck captain slot during the lobby or an active game; an active playback is paused before that slot is released.
- `UNDO` restores the previous meaningful game state. For example, undo immediately after `LOCK ANSWER` returns to the paused decision state instead of jumping to an earlier song.
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

CI runs both commands on every push and pull request. The integration tests exercise the real HTTP/SSE state machine, including:

- room creation and reconnect;
- server-side start gating;
- phone-only authoritative polling with no Host/Captain SSE dependency;
- monotonic room revisions and stale-state rejection;
- 10 → 5 → 2 scoring across two playbacks;
- pause/continue behavior;
- rejection of a third playback;
- answer locking and undo;
- correct scoring;
- steal timeout;
- display disconnect fail-safe;
- captain-slot reset and replacement-phone recovery;
- manual end-game undo;
- client audio-race guards and final-score recovery controls;
- full process-restart recovery from a persisted mid-game checkpoint;
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
- HTTP POST actions — client commands and authenticated Host/Captain state polling.
- Server-Sent Events (SSE) — realtime state/audio transport for the main display only.
- `data/songs.js` — song metadata and snippet durations.
- `test/integration.test.js` — end-to-end state-machine audit.
- `test/durability.test.js` — process-restart persistence audit.
- `test/phone-authority.test.js` — verifies Host/Captain phones work without SSE and still receive the first READY turn correctly.

There is one authoritative game server; browser clients never own game state.

## Deployment identity check

`GET /api/health` reports `buildId` and `instanceId` in addition to health/persistence status. On Render, `buildId` is derived from `RENDER_GIT_COMMIT`. Use it before a live test to confirm the public site is actually serving the expected Git commit; `instanceId` changes whenever the Node process restarts.

## Party-session durability

The main display sends an inbound health request every four minutes so a Render Free web service does not go idle while the display is open.

For restart-safe room recovery, set `GAME_STATE_FILE` to a path on durable storage (for example `/var/data/name-that-tune-state.json` on a Render Persistent Disk). Every authoritative state change is checkpointed atomically. On process restart, rooms, playlist order, scores, host/captain tokens, current song and playback progress are restored. A room that was actively playing comes back as `PAUSED` so it never resumes audio unexpectedly. Audio readiness is intentionally revoked until the display reconnects.

Without durable storage, a provider-level restart can still erase in-memory room state. Render Free web services cannot attach Persistent Disks.

## Production limitations

By default, rooms live in Node memory. For the party deployment, durable restart protection requires `GAME_STATE_FILE` to point at persistent storage. A paid Render web service can attach a Persistent Disk; a Free web service cannot. Do not deploy code during an active game, because even with durable state a deploy causes a brief service interruption.

The QR generator and Google Fonts are loaded from external CDNs. If the QR library cannot load, the room code/manual join path still works; if the fonts fail, browser fallback fonts are used.

The host PIN is intended for a low-stakes private party game, not strong authentication. There is currently no brute-force rate limiting on the 4-digit PIN.
