# Laser Drop

Isometric 3D multiplayer **blind shooting** game for the browser: desktop, phone, tablet.

1. Join a room and land straight on the arena. Everyone roams and sees each other.
2. Host presses **Start**. Everyone vanishes; each player only sees themselves.
3. **3 seconds** (all players at once) to move and aim.
4. Everyone is revealed and every laser fires at the same moment. Hit = eliminated.
5. The outer ring drops and the next round starts. Last one standing wins (max 10 rounds, then survivors draw).

## Run locally

```bash
npm install
npm run dev        # auto-restarts on server changes, http://localhost:3000
npm start          # production mode
```

Phones on the same Wi-Fi: `http://<your-computer-ip>:3000` (`ipconfig getifaddr en1` on a Mac for Wi-Fi).

## Controls
- Desktop: **WASD / arrows** move · **mouse** aims
- Touch: **left stick** moves · **right stick** aims

## Deploy

**Railway**: push to GitHub → New Project → Deploy from repo. `railway.json` sets the start command and the `/health` check; `PORT` is provided automatically. WebSockets work out of the box.

**Anything with Docker** (Render, Fly.io, a VPS): `docker build -t laser-drop . && docker run -p 3000:3000 laser-drop`.

Env vars (all optional): `PORT` (default 3000), `MAX_ROOMS` (default 300), `NODE_ENV=production`.

## Production notes
- Server-authoritative game loop (10 Hz). Opponents' positions are never sent during the blind phase, so they can't be cheated out of the network traffic.
- Every socket event is rate limited (token bucket) and validated; messages over 4 KB disconnect the client; handler errors are logged, never crash the process.
- Graceful shutdown on `SIGTERM`: clients see "Server is updating" and auto-reconnect back into their room.
- three.js is self-hosted from `node_modules` (no CDN), gzip on, versioned vendor files cached 30 days, app files revalidated via ETag.
- `/health` returns JSON: uptime, rooms, players, sockets.
- Client: reconnect banner, WebGL fallback message, context-loss recovery, reduced-motion support, sound toggle, fullscreen, share-sheet invites, PWA manifest.

## Tuning
Timings, hit radius and round cap are constants at the top of `game.js`.

## Structure
- `server.js`: HTTP + Socket.IO, rooms, rate limiting, lifecycle
- `game.js`: roam → plan → reveal → fire → shrink state machine, blind per-player snapshots, bots, standings
- `public/hex.js`: hex grid math shared by server and client
- `public/client.js`: Three.js renderer, input, effects, UI
