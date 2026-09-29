/* CastWave Frontend - Clean, High Performance Video & Screen Casting
   Receiver = Screen (TV, Laptop, Tablet). Sender = Remote (Phone, Laptop). */
(() => {
"use strict";

const PREFIX = "castwave-v1-";
const $ = (id) => document.getElementById(id);

/* ---------- Device Detection ---------- */
const ua = navigator.userAgent;
const DEVICE =
  /SmartTV|SMART-TV|Tizen|Web0S|WebOS|AFT|BRAVIA|Android TV|GoogleTV|CrKey/i.test(ua) ? "TV" :
  /iPad|Tablet/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) ? "Tablet" :
  /iPhone|Android|Mobile/i.test(ua) ? "Phone" : "Laptop";

$("meLabel").textContent = "This device: " + DEVICE;

const ICONS = {
  TV: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="13" rx="2"/><path d="M8 21h8"/></svg>',
  Laptop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>',
  Tablet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M11 18h2"/></svg>',
  Phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>',
};

let toastT;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 3600);
}

function show(v) {
  ["vHome", "vRecv", "vSend"].forEach((id) => ($(id).hidden = id !== v));
  window.scrollTo(0, 0);
}

const fmt = (s) => {
  if (!isFinite(s) || isNaN(s)) return "0:00";
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
};

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} }
};

/* ---------- ICE & Signaling ---------- */
let ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" }
];

const iceReady = fetch("/api/ice")
  .then((r) => r.json())
  .then((j) => {
    if (j.iceServers && j.iceServers.length) ICE = j.iceServers;
    $("srvDot").className = "dot on";
  })
  .catch(() => {
    $("srvDot").className = "dot off";
  });

function peerOpts() {
  const https = location.protocol === "https:";
  return {
    host: location.hostname,
    port: location.port ? Number(location.port) : https ? 443 : 80,
    path: "/peerjs",
    secure: https,
    debug: 0,
    config: {
      iceServers: ICE,
      sdpSemantics: "unified-plan"
    }
  };
}

let peer = null;
function resetPeer() {
  try { peer && peer.destroy(); } catch {}
  peer = null;
}

/* =============================== RECEIVER =============================== */
const R = { conn: null, call: null, accepted: false, stateTimer: null, beat: null, code: null, micAudio: null };
const rxV = $("rxVideo");
$("screenName").value = store.get("cw-name", DEVICE === "TV" ? "Living Room TV" : "My " + DEVICE);
$("screenName").addEventListener("change", (e) => {
  store.set("cw-name", e.target.value.trim());
  announce();
});

function rxSetStatus(txt, state) {
  $("rxStatus").textContent = txt;
  $("rxStatus2").textContent = txt;
  ["rxDot", "rxDot2"].forEach((id) => ($(id).className = "dot " + (state || "")));
}

function announce() {
  if (!R.code) return;
  fetch("/api/screens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: R.code,
      name: $("screenName").value.trim() || "Screen",
      device: DEVICE,
      busy: !!R.accepted
    })
  }).catch(() => {});
}

function unannounce() {
  if (R.code) fetch("/api/screens/" + R.code, { method: "DELETE", keepalive: true }).catch(() => {});
}

async function startReceiver() {
  show("vRecv");
  resetPeer();
  clearInterval(R.beat);
  unannounce();
  await iceReady;

  const code = store.get("cw-code", "") && /^\d{6}$/.test(store.get("cw-code", "")) && !R.retry
    ? store.get("cw-code")
    : String(Math.floor(100000 + Math.random() * 900000));
  R.retry = false;
  rxSetStatus("Connecting...", "wait");

  peer = new Peer(PREFIX + code, peerOpts());

  peer.on("open", () => {
    R.code = code;
    store.set("cw-code", code);
    $("rxCode").textContent = code;
    rxSetStatus("Ready. Waiting for a device", "on");
    const link = location.origin + "/?join=" + code;
    $("qr").src = "/api/qr?text=" + encodeURIComponent(link);
    $("qr").hidden = false;
    announce();
    R.beat = setInterval(announce, 12000);
  });

  peer.on("error", (e) => {
    if (e.type === "unavailable-id") {
      R.retry = true;
      return startReceiver();
    }
    rxSetStatus("Reconnecting (" + e.type + ")...", "wait");
    setTimeout(() => { if (!R.conn && !$("vRecv").hidden) startReceiver(); }, 3000);
  });

  peer.on("disconnected", () => { try { peer.reconnect(); } catch {} });

  peer.on("connection", (conn) => {
    if (R.conn && R.conn.open) {
      conn.on("open", () => {
        conn.send({ t: "busy" });
        setTimeout(() => conn.close(), 300);
      });
      return;
    }
    R.conn = conn;
    R.accepted = false;
    conn.on("data", rxData);
    conn.on("close", () => { if (R.conn === conn) rxEnd(true); });
  });

  peer.on("call", (call) => {
    if (!R.accepted || !R.conn || call.peer !== R.conn.peer) return call.close();
    try { R.call && R.call.close(); } catch {}
    R.call = call;
    call.answer();

    call.on("stream", (s) => {
      // If playing movie via URL, this stream is the user's live microphone voice
      if (rxV.src && !rxV.srcObject) {
        playMicVoice(s);
        return;
      }
      // Otherwise stream is Screen / Camera video + audio
      $("rxIdle").hidden = true;
      rxV.srcObject = s;
      rxPlay();
    });
  });

  initSinks();
}

function playMicVoice(stream) {
  if (!R.micAudio) {
    const a = document.createElement("audio");
    a.autoplay = true;
    a.playsInline = true;
    R.micAudio = a;
    document.body.appendChild(a);
  }
  R.micAudio.srcObject = stream;
  R.micAudio.play().catch(() => {});
  toast("Voice audio connected (hearing voice on TV speaker)");
}

function rxPlay() {
  rxV.play().then(() => {
    $("rxUnmute").hidden = true;
  }).catch((err) => {
    console.warn("Autoplay audio blocked, starting muted:", err);
    rxV.muted = true;
    rxV.play().then(() => {
      $("rxUnmute").hidden = false;
    }).catch(() => {
      $("rxUnmute").hidden = false;
    });
  });
}

function rxData(d) {
  if (!d || typeof d !== "object") return;
  switch (d.t) {
    case "hello":
      $("ringName").textContent = String(d.name || "A device").slice(0, 40);
      $("rxRing").hidden = false;
      rxSetStatus("Incoming cast...", "wait");
      break;
    case "play-url":
      $("rxIdle").hidden = true;
      $("rxChip").hidden = false;
      $("rxChip").textContent = String(d.name || "Playing Movie").slice(0, 120);
      rxV.srcObject = null;
      rxV.src = d.url;
      rxPlay();
      break;
    case "stream-start":
      $("rxIdle").hidden = true;
      $("rxChip").hidden = false;
      $("rxChip").textContent = String(d.label || "Live Stream").slice(0, 120);
      break;
    case "ctl":
      rxControl(d);
      break;
    case "stop":
      rxStopMedia();
      break;
    case "bye":
      rxEnd(true);
      break;
  }
}

function rxControl(d) {
  const v = Number(d.v);
  if (d.a === "play") rxPlay();
  else if (d.a === "pause") rxV.pause();
  else if (d.a === "seek" && isFinite(rxV.duration) && isFinite(v)) rxV.currentTime = Math.max(0, Math.min(rxV.duration, v));
  else if (d.a === "skip" && isFinite(v)) rxV.currentTime = Math.max(0, rxV.currentTime + v);
  else if (d.a === "vol" && isFinite(v)) rxV.volume = Math.max(0, Math.min(1, v));
}

function rxAccept() {
  R.accepted = true;
  $("rxRing").hidden = true;
  rxV.muted = false;
  rxV.play().catch(() => {});
  R.conn.send({ t: "accept", name: $("screenName").value.trim() || DEVICE });
  rxSetStatus("Connected to " + $("ringName").textContent, "on");
  $("rxEnd").hidden = false;
  announce();

  clearInterval(R.stateTimer);
  R.stateTimer = setInterval(() => {
    if (R.conn?.open) {
      R.conn.send({
        t: "state",
        cur: rxV.currentTime || 0,
        dur: isFinite(rxV.duration) ? rxV.duration : 0,
        paused: rxV.paused,
        vol: rxV.volume
      });
    }
  }, 400);
}

function rxStopMedia() {
  try { R.call && R.call.close(); } catch {}
  R.call = null;
  rxV.pause();
  rxV.srcObject = null;
  if (rxV.src) { URL.revokeObjectURL(rxV.src); rxV.removeAttribute("src"); rxV.load(); }
  if (R.micAudio) { R.micAudio.srcObject = null; }
  $("rxIdle").hidden = false;
  $("rxChip").hidden = true;
  $("rxBar").hidden = true;
}

function rxEnd(remote) {
  clearInterval(R.stateTimer);
  rxStopMedia();
  const c = R.conn;
  R.conn = null;
  R.accepted = false;
  if (!remote && c) {
    try { c.send({ t: "bye" }); } catch {}
    setTimeout(() => c.close(), 200);
  }
  $("rxRing").hidden = true;
  $("rxEnd").hidden = true;
  rxSetStatus("Ready. Waiting for a device", "on");
  announce();
  if (remote) toast("The device disconnected.");
}

$("rxAccept").onclick = rxAccept;
$("rxDecline").onclick = () => {
  const c = R.conn;
  R.conn = null;
  try { c?.send({ t: "decline" }); } catch {}
  $("rxRing").hidden = true;
  setTimeout(() => c?.close(), 300);
  rxSetStatus("Ready. Waiting for a device", "on");
};
$("rxEnd").onclick = () => rxEnd(false);
$("rxUnmuteBtn").onclick = () => {
  rxV.muted = false;
  rxPlay();
  $("rxUnmute").hidden = true;
};

/* Fullscreen support */
function isFullscreen() {
  return !!(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement ||
    $("stage").classList.contains("pseudo-fullscreen")
  );
}

function updateFsButton() {
  const fs = isFullscreen();
  $("fsBtn").textContent = fs ? "Exit full screen" : "Full screen";
}

async function toggleFullscreen() {
  const s = $("stage");
  const v = $("rxVideo");

  if (isFullscreen()) {
    if (s.classList.contains("pseudo-fullscreen")) {
      s.classList.remove("pseudo-fullscreen");
      updateFsButton();
      return;
    }
    try {
      if (document.exitFullscreen) await document.exitFullscreen();
      else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
      else if (document.mozCancelFullScreen) await document.mozCancelFullScreen();
      else if (document.msExitFullscreen) await document.msExitFullscreen();
    } catch {
      s.classList.remove("pseudo-fullscreen");
    }
    updateFsButton();
    return;
  }

  try {
    const req = s.requestFullscreen || s.webkitRequestFullscreen || s.mozRequestFullScreen || s.msRequestFullscreen;
    if (req) {
      await req.call(s);
      updateFsButton();
      return;
    }
  } catch (e) {}

  try {
    if (v.webkitEnterFullscreen) {
      v.webkitEnterFullscreen();
      return;
    } else if (v.requestFullscreen) {
      await v.requestFullscreen();
      updateFsButton();
      return;
    }
  } catch (e) {}

  s.classList.add("pseudo-fullscreen");
  updateFsButton();
}

$("fsBtn").onclick = toggleFullscreen;
$("stage").ondblclick = toggleFullscreen;
["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange", "MSFullscreenChange"].forEach((evt) => {
  document.addEventListener(evt, updateFsButton);
});

/* Speaker output management */
let sinksInit = false;
async function initSinks() {
  if (sinksInit || !("setSinkId" in HTMLMediaElement.prototype) || !navigator.mediaDevices?.enumerateDevices) return;
  sinksInit = true;
  $("sinkWrap").hidden = false;
  const fill = async () => {
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput");
    const sel = $("sinkSel");
    sel.innerHTML = "";
    outs.forEach((d, i) => {
      const o = document.createElement("option");
      o.value = d.deviceId;
      o.textContent = d.label || (d.deviceId === "default" ? "System Default" : "Speaker " + (i + 1));
      sel.appendChild(o);
    });
    if (!outs.length) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = "System Default";
      sel.appendChild(o);
    }
    $("sinkPerm").hidden = outs.some((d) => d.label);
  };
  $("sinkSel").onchange = (e) => rxV.setSinkId(e.target.value).then(() => toast("Sound routed to speaker")).catch(() => toast("Could not switch speaker."));
  $("sinkPerm").onclick = async () => {
    try {
      if (navigator.mediaDevices.selectAudioOutput) {
        const d = await navigator.mediaDevices.selectAudioOutput();
        await rxV.setSinkId(d.deviceId);
      } else {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
      }
      fill();
    } catch { toast("Microphone permission needed to read speaker names."); }
  };
  fill();
  navigator.mediaDevices.addEventListener?.("devicechange", fill);
}

/* ================================ SENDER ================================ */
const S = {
  conn: null,
  call: null,
  stream: null,
  micStream: null,
  micActive: false,
  state: { cur: 0, dur: 0, paused: true, vol: 1 },
  scan: null
};

const canScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
const canMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

function txSetStatus(txt, state) {
  $("txStatus").textContent = txt;
  $("txDot").className = "dot " + (state || "");
}

async function scanNearby() {
  try {
    const { screens } = await (await fetch("/api/screens")).json();
    const ul = $("nearby");
    ul.innerHTML = "";
    $("scanDot").className = "dot on";
    $("scanTxt").textContent = screens.length ? screens.length + " found" : "Scanning";
    if (!screens.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No screens found yet. Open CastWave on your TV or laptop and click “Receive a cast”.";
      ul.appendChild(li);
      return;
    }
    for (const s of screens) {
      const li = document.createElement("li"), b = document.createElement("button");
      b.disabled = s.busy;
      b.innerHTML = `<span class="ico">${ICONS[s.device] || ICONS.TV}</span><span><b></b><small></small></span><span class="pill${s.busy ? " busy" : ""}">${s.busy ? "In use" : "Ready"}</span>`;
      b.querySelector("b").textContent = s.name;
      b.querySelector("small").textContent = s.device + " - Code: " + s.code;
      b.onclick = () => { $("codeIn").value = s.code; connectTo(s.code); };
      li.appendChild(b);
      ul.appendChild(li);
    }
  } catch {
    $("scanDot").className = "dot off";
    $("scanTxt").textContent = "Offline";
  }
}

function startSender(prefill) {
  show("vSend");
  $("joinCard").hidden = false;
  $("srcCard").hidden = true;
  $("remoteCard").hidden = true;

  const notes = [];
  if (!canScreen) notes.push("Mobile browsers do not allow whole-screen mirroring. Cast a movie or camera instead.");
  if (!window.isSecureContext) notes.push("Camera and screen sharing require HTTPS.");
  $("srcNote").textContent = notes.join(" ");

  clearInterval(S.scan);
  scanNearby();
  S.scan = setInterval(scanNearby, 3000);
  if (prefill) { $("codeIn").value = prefill; connectTo(prefill); }
}

async function connectTo(code) {
  code = String(code || "").replace(/\D/g, "");
  if (code.length !== 6) return txSetStatus("Enter the 6-digit code shown on the screen.", "");
  await iceReady;
  resetPeer();
  txSetStatus("Calling screen " + code + "...", "wait");
  $("joinBtn").disabled = true;

  peer = new Peer(peerOpts());
  peer.on("open", () => {
    const conn = peer.connect(PREFIX + code, { reliable: true });
    S.conn = conn;
    const t = setTimeout(() => {
      if (!conn.open) {
        txSetStatus("No response from screen. Ensure both devices are online.", "");
        $("joinBtn").disabled = false;
      }
    }, 12000);

    conn.on("open", () => {
      clearTimeout(t);
      conn.send({ t: "hello", name: DEVICE === "Laptop" ? "A laptop" : "A " + DEVICE });
      txSetStatus("Ringing... please click Accept on the screen", "wait");
    });

    conn.on("data", txData);
    conn.on("close", () => { if (S.conn === conn) txEnd("The screen ended the cast."); });
  });

  peer.on("error", (e) => {
    $("joinBtn").disabled = false;
    txSetStatus(e.type === "peer-unavailable" ? "No screen found with that code." : "Connection issue (" + e.type + "). Try again.", "");
  });
}

function txData(d) {
  if (!d || typeof d !== "object") return;
  switch (d.t) {
    case "accept":
      clearInterval(S.scan);
      $("joinCard").hidden = true;
      $("srcCard").hidden = false;
      toast("Connected to " + String(d.name || "the screen").slice(0, 40));
      break;
    case "decline":
      txSetStatus("The screen declined.", "");
      $("joinBtn").disabled = false;
      S.conn?.close();
      S.conn = null;
      break;
    case "busy":
      txSetStatus("Screen is currently occupied.", "");
      $("joinBtn").disabled = false;
      break;
    case "bye":
      txEnd("The screen ended the cast.");
      break;
    case "state":
      S.state = d;
      renderState();
      break;
  }
}

function mediaCall(stream, label) {
  try { S.call && S.call.close(); } catch {}
  S.stream = stream;
  S.conn.send({ t: "stream-start", label });
  S.call = peer.call(S.conn.peer, stream);
}

/* Connect Live Voice (Microphone Talk) */
async function setMicrophoneState(wantOn) {
  if (!canMedia) {
    toast("Microphone is not supported on this browser.");
    return;
  }

  if (wantOn) {
    try {
      if (!S.micStream) {
        const mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        S.micStream = mic;
        if (S.conn && S.conn.open) {
          S.call = peer.call(S.conn.peer, mic);
        }
      }
      S.micStream.getAudioTracks().forEach((t) => (t.enabled = true));
      S.micActive = true;
      updateMicUI(true);
      toast("Microphone is ON - You can talk now");
    } catch (e) {
      console.warn("Microphone access denied:", e);
      toast("Microphone access was denied in browser permissions.");
      S.micActive = false;
      updateMicUI(false);
    }
  } else {
    if (S.micStream) {
      S.micStream.getAudioTracks().forEach((t) => (t.enabled = false));
    }
    S.micActive = false;
    updateMicUI(false);
    toast("Microphone is OFF - Muted");
  }
}

function updateMicUI(isOn) {
  const banner = document.querySelector(".mic-toggle-banner");
  const indicator = $("micIndicator");
  const title = $("micStatusTitle");
  const sub = $("micStatusSub");
  const btn = $("liveMicToggle");
  const btnText = $("liveMicText");

  if (!banner || !indicator || !title || !sub || !btn || !btnText) return;

  if (isOn) {
    banner.className = "mic-toggle-banner active";
    indicator.className = "mic-indicator";
    title.textContent = "Microphone is ON";
    sub.textContent = "Your voice is playing through the TV speaker";
    btn.className = "btn-mic-toggle active";
    btnText.textContent = "Turn Mic OFF";
  } else {
    banner.className = "mic-toggle-banner muted";
    indicator.className = "mic-indicator off";
    title.textContent = "Microphone is OFF";
    sub.textContent = "Tap button to speak through the TV speaker";
    btn.className = "btn-mic-toggle muted";
    btnText.textContent = "Turn Mic ON";
  }
}

function stopLocal() {
  S.stream?.getTracks().forEach((t) => t.stop());
  S.stream = null;
  S.micStream?.getTracks().forEach((t) => t.stop());
  S.micStream = null;
  S.micActive = false;
  try { S.call && S.call.close(); } catch {}
  S.call = null;

  $("preview").hidden = true;
  $("preview").srcObject = null;
  $("preview").src = "";
  $("xferWrap").hidden = true;
}

function showRemote(title, hasTransport) {
  $("remoteCard").hidden = false;
  $("nowTitle").textContent = title;
  ["seek", "back10", "playBtn", "fwd10"].forEach((id) => ($(id).disabled = !hasTransport));
  $("remote").querySelector(".transport").hidden = !hasTransport;
  $("seek").hidden = !hasTransport;
  $("remote").querySelector(".time").hidden = !hasTransport;
  $("remoteCard").scrollIntoView({ behavior: "smooth", block: "start" });
  updateMicUI(S.micActive);
}

/* 1. Fast Video & Movie Casting (High Speed Stream) */
$("sFile").onclick = () => $("fileIn").click();

$("fileIn").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f || !S.conn?.open) return;
  stopLocal();
  S.conn.send({ t: "stop" });

  try {
    toast("Streaming movie to TV...");
    $("xferWrap").hidden = false;
    $("xferTxt").textContent = "Connecting stream to TV...";
    $("xferPct").textContent = "Loading";

    // Upload to instant HTTP streaming endpoint
    const res = await fetch("/api/media/upload", {
      method: "POST",
      headers: {
        "x-mime-type": f.type || "video/mp4",
        "x-file-name": encodeURIComponent(f.name)
      },
      body: f
    });

    if (!res.ok) throw new Error("Stream upload failed");
    const media = await res.json();

    // Notify receiver to play the stream URL
    S.conn.send({ t: "play-url", url: media.url, name: f.name });

    // Show local preview
    $("preview").src = URL.createObjectURL(f);
    $("preview").hidden = false;
    $("preview").play().catch(() => {});
    $("preview").muted = true;

    showRemote(f.name, true);
    setTimeout(() => ($("xferWrap").hidden = true), 1200);

    // If Voice Talk was selected initially, start with mic ON
    if ($("micChk").checked) {
      await setMicrophoneState(true);
    } else {
      updateMicUI(false);
    }
  } catch (err) {
    console.error("Movie cast error:", err);
    toast("Could not stream that file. Please choose an MP4 or WebM video.");
    stopLocal();
  }
};

/* 2. Entire Screen & Display Sharing */
async function getScreenStream() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    throw new Error("Screen mirroring not supported.");
  }
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 }, cursor: "always" },
      audio: true
    });
  } catch (err) {
    if (err.name === "NotAllowedError" || err.name === "AbortError") throw err;
    return await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 }, cursor: "always" },
      audio: false
    });
  }
}

$("sScreen").onclick = async () => {
  if (!canScreen) {
    toast(DEVICE === "Phone" || DEVICE === "Tablet"
      ? "Mobile browsers restrict screen capture. Cast a movie or camera instead."
      : "Screen sharing requires Chrome, Edge, Safari, or Firefox.");
    return;
  }
  try {
    const s = await getScreenStream();
    stopLocal();

    const vt = s.getVideoTracks()[0];
    if (vt) {
      vt.onended = () => {
        S.conn?.send({ t: "stop" });
        stopLocal();
        $("remoteCard").hidden = true;
      };
    }

    mediaCall(s, "Screen from " + DEVICE);
    $("preview").srcObject = s;
    $("preview").hidden = false;
    $("preview").play().catch(() => {});
    showRemote("Mirroring your screen", false);
    toast("Mirroring screen to TV.");
    if ($("micChk").checked) {
      await setMicrophoneState(true);
    } else {
      updateMicUI(false);
    }
  } catch (e) {
    if (e.name !== "NotAllowedError" && e.name !== "AbortError") {
      toast("Screen share error: " + (e.message || "permission issue"));
    }
  }
};

/* 3. Camera & Live Voice */
$("sCam").onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1920 } },
      audio: true
    });
    stopLocal();
    mediaCall(s, "Camera from " + DEVICE);
    $("preview").srcObject = s;
    $("preview").hidden = false;
    $("preview").play().catch(() => {});
    showRemote("Casting camera and mic", false);
    updateMicUI(true);
    S.micActive = true;
  } catch {
    toast("Camera permission was denied.");
  }
};

/* Remote Controls */
let dragging = false;
function renderState() {
  const s = S.state;
  $("tCur").textContent = fmt(s.cur);
  $("tDur").textContent = fmt(s.dur);
  if (!dragging && s.dur) $("seek").value = Math.round((1000 * s.cur) / s.dur);
  $("playIco").innerHTML = s.paused ? '<path d="M8 5v14l11-7z"/>' : '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
}

function ctl(a, v) {
  S.conn?.send({ t: "ctl", a, v });
}

$("playBtn").onclick = () => {
  ctl(S.state.paused ? "play" : "pause");
  S.state.paused = !S.state.paused;
  renderState();
};
$("back10").onclick = () => ctl("skip", -10);
$("fwd10").onclick = () => ctl("skip", 10);
$("seek").oninput = () => {
  dragging = true;
  $("tCur").textContent = fmt(($("seek").value / 1000) * S.state.dur);
};
$("seek").onchange = () => {
  dragging = false;
  ctl("seek", ($("seek").value / 1000) * S.state.dur);
};
$("vol").oninput = () => ctl("vol", $("vol").value / 100);

/* Live Microphone Toggle Button */
$("liveMicToggle").onclick = () => {
  setMicrophoneState(!S.micActive);
};

$("micVol").oninput = (e) => {
  const val = Number(e.target.value) / 100;
  if (S.micStream) {
    // Gain/volume control
  }
};

$("stopCast").onclick = () => {
  S.conn?.send({ t: "stop" });
  stopLocal();
  $("remoteCard").hidden = true;
};

function txEnd(msg) {
  stopLocal();
  const c = S.conn;
  S.conn = null;
  try { c && c.open && c.close(); } catch {}
  $("remoteCard").hidden = true;
  $("srcCard").hidden = true;
  $("joinCard").hidden = false;
  $("joinBtn").disabled = false;
  txSetStatus(msg || "Disconnected.", "");
  if (msg) toast(msg);
  if (!$("vSend").hidden) {
    clearInterval(S.scan);
    scanNearby();
    S.scan = setInterval(scanNearby, 3000);
  }
}

$("txEnd").onclick = () => {
  try { S.conn?.send({ t: "bye" }); } catch {}
  setTimeout(() => txEnd("Disconnected."), 150);
};

$("joinBtn").onclick = () => connectTo($("codeIn").value);
$("codeIn").addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
  if (e.target.value.length === 6) connectTo(e.target.value);
});

/* ================= GOOGLE CAST / CHROMECAST SUPPORT ================= */
window["__onGCastApiAvailable"] = function(isAvailable) {
  if (isAvailable && typeof cast !== "undefined" && cast.framework && typeof chrome !== "undefined" && chrome.cast && chrome.cast.media) {
    try {
      cast.framework.CastContext.getInstance().setOptions({
        receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
      });
    } catch (e) {}
  }
};

$("chromecastDirectBtn").onclick = () => {
  if (typeof cast !== "undefined" && cast.framework) {
    try {
      cast.framework.CastContext.getInstance().requestSession().then(
        () => toast("Connected to Chromecast"),
        (err) => {
          if (err !== "cancel") toast("Chromecast: " + (err || "connecting..."));
        }
      );
      return;
    } catch (e) {}
  }

  if (navigator.presentation && navigator.presentation.defaultRequest) {
    try {
      navigator.presentation.defaultRequest.start().then(
        () => toast("Connected to Smart TV"),
        () => {}
      );
      return;
    } catch (e) {}
  }

  toast("Open this page on your TV browser or use Google Cast.");
};

/* ---------- Navigation ---------- */
function goHome() {
  stopLocal();
  rxStopMedia();
  clearInterval(R.beat);
  clearInterval(R.stateTimer);
  clearInterval(S.scan);
  unannounce();
  R.code = null;
  resetPeer();
  S.conn = null;
  R.conn = null;
  R.accepted = false;
  history.replaceState(null, "", "/");
  show("vHome");
}

$("goReceive").onclick = startReceiver;
$("goSend").onclick = () => startSender();
$("homeBtn").onclick = goHome;

window.addEventListener("pagehide", () => {
  try { S.conn?.send({ t: "bye" }); R.conn?.send({ t: "bye" }); } catch {}
  unannounce();
});

const j = new URLSearchParams(location.search).get("join");
if (j) startSender(j);
})();
