# Reveal audio snippets

Put the full-song reveal snippets in this folder.

Use the exact same filename as the matching gameplay snippet in `public/audio/`.

Examples:
- `public/audio/poker-face.mp3` -> `public/audio/reveal/poker-face.mp3`
- `public/audio/anti-hero.mp3` -> `public/audio/reveal/anti-hero.mp3`
- `public/audio/bahom-shel-tel-aviv.mp3` -> `public/audio/reveal/bahom-shel-tel-aviv.mp3`

Each reveal clip should start at the same source position as the matching instrumental/gameplay snippet, but it should be longer so the room can enjoy the real song after the turn. A target length of about 20–30 seconds is ideal.

The reveal clip plays automatically on the main display when the game enters the Reveal screen. It does not affect scoring or playback counts.

While the reveal clip is playing, the host can press NEXT at any time; the reveal audio stops immediately and the game moves on. If nobody presses NEXT, the game automatically advances when the reveal file reaches its natural end.

After advancing, the next song behaves normally: it waits in READY for the next captain to press Play. If the next song starts a new difficulty round, the game shows ROUND_INTRO and waits for the host to start that round.

If a reveal clip is missing or cannot play, the game stays on the Reveal screen so the host can move on manually.

Recommended format: MP3, normalized to approximately the same loudness as the gameplay snippets.
