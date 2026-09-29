// CastWave backend
// - Serves frontend (public/)
// - PeerJS WebRTC signaling server (/peerjs)
// - High-speed HTTP Range Media Streaming (/api/media/:id) for instant movie playback
// - Nearby screens discovery (/api/screens)
// - QR code generation (/api/qr)
// - Health check (/api/health)

const path = require("path");
const http = require("http");
const fs = require("fs");
const os = require("os");
const express = require("express");
const { ExpressPeerServer } = require("peer");
const QRCode = require("qrcode");

const PORT = Number(process.env.PORT) || 3000;
const CODE_RE = /^\d{6}$/;
const PEER_PREFIX = "castwave-v1-";
const SCREEN_TTL_MS = 30_000;

const MEDIA_DIR = path.join(os.tmpdir(), "castwave_media");
try { if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true }); } catch (e) {}

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));

const server = http.createServer(app);

/* ---------- Signaling (PeerJS) ---------- */
const peerServer = ExpressPeerServer(server, {
  path: "/",
  proxied: true,
  allow_discovery: false,
  alive_timeout: 60_000,
});
app.use("/peerjs", peerServer);

peerServer.on("connection", (client) => log("peer connected", client.getId()));
peerServer.on("disconnect", (client) => {
  const id = client.getId();
  if (id.startsWith(PEER_PREFIX)) screens.delete(id.slice(PEER_PREFIX.length));
  log("peer disconnected", id);
});

/* ---------- ICE servers ---------- */
const FREE_STUN = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
];
let meteredCache = { at: 0, servers: [] };

async function turnServers() {
  if (process.env.TURN_URLS) {
    return [{
      urls: process.env.TURN_URLS.split(",").map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME || "",
      credential: process.env.TURN_CREDENTIAL || "",
    }];
  }
  const { METERED_APP, METERED_API_KEY } = process.env;
  if (METERED_APP && METERED_API_KEY) {
    if (Date.now() - meteredCache.at < 10 * 60_000) return meteredCache.servers;
    try {
      const url = `https://${METERED_APP}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED_API_KEY)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const servers = (await r.json()).filter((s) => String(s.urls).startsWith("turn"));
        meteredCache = { at: Date.now(), servers };
        return servers;
      }
    } catch (e) {}
  }
  return [];
}

app.get("/api/ice", async (_req, res) => {
  const turn = await turnServers();
  res.set("Cache-Control", "no-store").json({ iceServers: [...FREE_STUN, ...turn], turn: turn.length > 0 });
});

/* ---------- High-Performance Media Streaming (HTTP 206 Partial Content) ---------- */
app.post("/api/media/upload", (req, res) => {
  const id = "media_" + Date.now() + "_" + Math.random().toString(36).substring(2, 9);
  const mimeType = req.headers["x-mime-type"] || "video/mp4";
  const fileName = decodeURIComponent(req.headers["x-file-name"] || "video.mp4");
  const filePath = path.join(MEDIA_DIR, id);
  const metaPath = path.join(MEDIA_DIR, id + ".json");

  const writeStream = fs.createWriteStream(filePath);
  req.pipe(writeStream);

  writeStream.on("finish", () => {
    try {
      fs.writeFileSync(metaPath, JSON.stringify({ mimeType, fileName, createdAt: Date.now() }));
    } catch (e) {}
    res.json({ ok: true, id, url: `/api/media/${id}`, fileName, mimeType });
  });

  writeStream.on("error", (err) => {
    log("upload error", err);
    res.status(500).json({ error: "Upload failed" });
  });
});

app.get("/api/media/:id", (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g, "");
  const filePath = path.join(MEDIA_DIR, id);
  const metaPath = path.join(MEDIA_DIR, id + ".json");

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Media not found");
  }

  let mimeType = "video/mp4";
  try {
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (meta.mimeType) mimeType = meta.mimeType;
    }
  } catch (e) {}

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunksize,
      "Content-Type": mimeType,
      "Cache-Control": "public, max-age=3600",
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      "Content-Length": fileSize,
      "Content-Type": mimeType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    };
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// Periodic cleanup of temporary media files older than 2 hours
setInterval(() => {
  try {
    const files = fs.readdirSync(MEDIA_DIR);
    const now = Date.now();
    for (const f of files) {
      const fp = path.join(MEDIA_DIR, f);
      const st = fs.statSync(fp);
      if (now - st.mtimeMs > 2 * 60 * 60 * 1000) {
        fs.unlinkSync(fp);
      }
    }
  } catch (e) {}
}, 30 * 60 * 1000).unref();

/* ---------- Nearby Screens ---------- */
const screens = new Map();

const clean = (s, n) => String(s || "").replace(/[<>]/g, "").trim().slice(0, n);

app.post("/api/screens", (req, res) => {
  const code = String(req.body?.code || "");
  if (!CODE_RE.test(code)) return res.status(400).json({ error: "Code must be 6 digits." });
  const existing = screens.get(code);
  if (existing && existing.ip !== req.ip) return res.status(409).json({ error: "Code in use." });
  screens.set(code, {
    code,
    name: clean(req.body.name, 40) || "Screen",
    device: clean(req.body.device, 12) || "Screen",
    busy: !!req.body.busy,
    ip: req.ip,
    seen: Date.now(),
  });
  res.json({ ok: true, ttl: SCREEN_TTL_MS });
});

app.delete("/api/screens/:code", (req, res) => {
  const s = screens.get(req.params.code);
  if (s && s.ip === req.ip) screens.delete(req.params.code);
  res.json({ ok: true });
});

app.get("/api/screens", (req, res) => {
  const now = Date.now();
  const list = [...screens.values()]
    .filter((s) => s.ip === req.ip && now - s.seen < SCREEN_TTL_MS)
    .map(({ code, name, device, busy }) => ({ code, name, device, busy }));
  res.set("Cache-Control", "no-store").json({ screens: list });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, s] of screens) if (now - s.seen > SCREEN_TTL_MS) screens.delete(code);
}, 10_000).unref();

/* ---------- QR Code ---------- */
app.get("/api/qr", async (req, res) => {
  const text = String(req.query.text || "");
  if (!text || text.length > 300) return res.status(400).send("Bad text");
  try {
    const svg = await QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0f172a", light: "#ffffff" } });
    res.type("image/svg+xml").set("Cache-Control", "public, max-age=3600").send(svg);
  } catch { res.status(500).send("QR failed"); }
});

/* ---------- Health ---------- */
app.get("/api/health", (_req, res) => res.json({ ok: true, screens: screens.size, uptime: Math.round(process.uptime()) }));

/* ---------- Frontend ---------- */
app.use("/vendor", express.static(path.join(__dirname, "node_modules/peerjs/dist"), { maxAge: "7d" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

server.listen(PORT, () => log(`CastWave running on http://localhost:${PORT}`));

function log(...a) { console.log(new Date().toISOString(), ...a); }
