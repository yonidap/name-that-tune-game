# Deploy on Render

This project is a persistent Node web service because active game rooms and SSE connections live in one server process.

1. Create a new Render Web Service from the GitHub repository.
2. Runtime: Node.
3. Build command: `npm install`.
4. Start command: `npm start`.
5. Health check: `/api/health`.
6. Keep one instance for the MVP. Horizontal scaling requires shared persistence and a realtime fan-out layer.

`render.yaml` contains the same defaults.

After deployment, open `/host` on the computer connected to the speakers. Captains join from `/join/<ROOM_CODE>`.
