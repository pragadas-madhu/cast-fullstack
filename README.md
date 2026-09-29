# CastWave - Fullstack All-In-One Unified Architecture

Everything in one single self-contained project: Node.js Express backend serving the frontend UI, WebRTC signaling, Google Cast, and media streaming engine.

---

## Project Structure
```
fullstack-all-in-one/
├── server.js          # Express server + PeerJS signaling + Media streaming API
├── package.json       # Dependencies and scripts
└── public/            # Frontend Web UI
    ├── index.html     # HTML structure
    ├── style.css      # Light Mode CSS styling
    └── app.js         # Client WebRTC, Chromecast, and Audio Mixer logic
```

---

## How to Run:
```bash
cd fullstack-all-in-one
npm install
npm start
```
- **Access URL:** `http://localhost:3000` (or set `PORT=3001 npm start`)
- Everything starts with a single command!
