# Multiplayer Quickstart

This repo includes a lightweight WebSocket server for 2–4 player rooms.

Server (Node.js):
- `cd server`
- `npm install`
- `npm start` (listens on port 8080)

Client:
- Open `index.html` with any static server (or directly in a browser).
- In the lobby, enter a name and click "Host". Share the Room ID.
- Others click "Join" with the same Room ID.
- Everyone toggles "Ready"; host clicks "Start".

Notes:
- Deterministic spawns use a shared seed and synchronized start time.
- Positions are relayed at ~15Hz and rendered with simple smoothing.
- Host can toggle player-to-player collision in the lobby.

