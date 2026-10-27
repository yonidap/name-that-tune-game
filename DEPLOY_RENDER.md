# Deploy on Render

This project is a single Node web service because active rooms, SSE connections, and the authoritative game state live in one server process.

1. Create a Render Web Service from this GitHub repository.
2. Runtime: Node.
3. Build command: `npm install`.
4. Start command: `npm start`.
5. Health check: `/api/health`.
6. Keep **one instance** for the current MVP. Horizontal scaling requires shared persistence plus a realtime fan-out layer.

`render.yaml` contains the same defaults.

After deployment, open `/host` on the computer connected to the speakers. The lobby shows QR codes for the host controller and both captains, with manual room-code joining as a fallback.

## Important during a live game

Rooms currently exist only in Node process memory. A deploy, restart, crash, or Render process replacement will erase an active game room. **Do not push/deploy changes while a party game is in progress.**

`render.yaml` currently uses `autoDeploy: true` because the project is still being developed rapidly. Before relying on it for an event where accidental pushes are possible, consider disabling auto-deploy in Render for the duration of the event.
