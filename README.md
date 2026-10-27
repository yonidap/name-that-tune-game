# Name That Tune — real-time party game

A two-team music guessing game with a dedicated audience/game screen, a host-controller phone, and two captain phones. The game screen is connected to the speakers; captain phones remotely play/pause the current snippet, while only the host phone judges answers and advances the game. Points decrease as more of the snippet is heard.

## Current MVP

- Two teams with one captain each
- Dedicated audience/game screen with no admin controls
- Separate host-controller phone protected by a room PIN
- Room code + phone join flow
- Song answer visible only to the host controller until reveal
- Easy / Medium / Hard rounds
- Short (15), Normal (21), and Full (40) game lengths
- Remote play/pause from the active captain
- Scoring based on actual audio position, not wall-clock time
- Pause / discuss / continue without losing points while paused
- Lock answer
- 1-point steal after an incorrect answer
- Manual score correction and undo
- Reconnect tokens for host and captains
- Missing-audio demo mode for testing the full flow
- Render deployment configuration

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000/host` on the computer connected to the speakers. Create a room. The lobby shows a `/control/ROOM` link + PIN for the host phone and a `/join/ROOM` link for both captain phones.

## Audio files

Copyrighted music is **not committed to this repository**. Put your pre-cut snippets in `public/audio/` using the filenames defined in `data/songs.js`.

Example:

```text
public/audio/toxic.mp3
public/audio/billie-jean.mp3
...
```

When a file is missing, the host automatically uses a generated demo tone. That makes it possible to test all real-time game mechanics before loading the actual snippets.

The `sourceStart` field in `data/songs.js` is only a preparation reference. Timings can differ between releases and karaoke/instrumental versions, so verify each final snippet by ear before the event.

## Production notes

The MVP keeps game rooms in Node process memory. A server restart clears active rooms. For a party session on a single Render instance this is acceptable; a later production version should persist snapshots in Redis/Postgres and use a Server-Sent Events (SSE) + HTTP actions adapter if horizontally scaled.

## Game state

Main phases:

```text
LOBBY
  → ROUND_INTRO
  → READY ↔ PLAYING ↔ PAUSED
  → ANSWER_LOCKED
  → REVEAL
       ↘ on wrong: STEAL → STEAL_LOCKED → REVEAL
  → next song / next round
  → FINISHED
```

The host-controller phone receives title and artist. The game screen receives only the audio source until reveal, so the audience cannot see the answer early. Captain clients never receive the answer.

## Transport

The app deliberately uses only Node.js built-ins: captain commands are HTTP POST actions and server-to-client real-time updates use Server-Sent Events (SSE). This keeps deployment dependency-free while preserving low-latency party-game controls.
