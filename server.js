// Lone Wolf - real-time multiplayer game server.
// Serves index.html and runs all game rules over WebSockets.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const TARGET = 3; // round wins needed
const MAX_N = 10; // numbers 1..10
const MAX_PLAYERS = 8;
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

const html = fs.readFileSync(path.join(__dirname, "index.html"));
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200);
    return res.end("ok");
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
});
const wss = new WebSocketServer({ server });
const rooms = new Map();

const rid = () => Math.random().toString(36).slice(2, 10);
function newCode() {
  for (;;) {
    const c = Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join("");
    if (!rooms.has(c)) return c;
  }
}
const send = (ws, obj) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
};

function view(room, pid) {
  const me = room.players.get(pid);
  return {
    type: "state",
    you: pid,
    code: room.code,
    host: room.host,
    phase: room.phase,
    round: room.round,
    target: TARGET,
    maxN: MAX_N,
    roster: room.roster,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      picked: p.pick !== null,
    })),
    scores: room.scores,
    last: room.last,
    champion: room.champion,
    mine: me ? me.pick : null,
  };
}
function broadcast(room) {
  for (const p of room.players.values()) send(p.ws, view(room, p.id));
}

function liveRoster(room) {
  return room.roster
    .map((r) => room.players.get(r.id))
    .filter((p) => p && p.connected);
}

function maybeResolve(room) {
  if (room.phase !== "picking") return;
  const live = liveRoster(room);
  if (live.length < 2 || !live.every((p) => p.pick !== null)) return;

  const picks = live.map((p) => ({ id: p.id, name: p.name, pick: p.pick }));
  const counts = {};
  picks.forEach((p) => (counts[p.pick] = (counts[p.pick] || 0) + 1));
  // Rule: lowest number picked by exactly one player wins the round.
  const winner =
    picks.filter((p) => counts[p.pick] === 1).sort((a, b) => a.pick - b.pick)[0] || null;
  if (winner) room.scores[winner.id] = (room.scores[winner.id] || 0) + 1;
  const over = winner && room.scores[winner.id] >= TARGET;
  room.last = { round: room.round, picks, winnerId: winner ? winner.id : null };
  room.phase = over ? "over" : "reveal";
  room.champion = over ? winner.id : null;
}

function removePlayer(room, pid) {
  room.players.delete(pid);
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.host === pid) {
    const next = [...room.players.values()].find((p) => p.connected) || [...room.players.values()][0];
    room.host = next.id;
  }
  maybeResolve(room);
  broadcast(room);
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  ws.ctx = null; // { room, pid }

  const fail = (message, code) => send(ws, { type: "error", message, code });

  ws.on("message", (raw) => {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const name = String(m.name || "").trim().slice(0, 14);

    if (m.type === "create") {
      if (!name) return fail("Enter your name first.");
      const code = newCode();
      const pid = rid();
      const room = {
        code, host: pid, phase: "lobby", round: 0, roster: [], scores: {},
        last: null, champion: null, players: new Map(), emptySince: null,
      };
      room.players.set(pid, { id: pid, name, ws, connected: true, pick: null });
      rooms.set(code, room);
      ws.ctx = { room, pid };
      return broadcast(room);
    }

    if (m.type === "join") {
      const room = rooms.get(String(m.code || "").toUpperCase());
      if (!name) return fail("Enter your name first.");
      if (!room) return fail("No room with that code. Check it with your host.");
      if (room.phase !== "lobby") return fail("That game already started. Ask the host for a new room.");
      if (room.players.size >= MAX_PLAYERS) return fail("That room is full (8 players max).");
      const pid = rid();
      room.players.set(pid, { id: pid, name, ws, connected: true, pick: null });
      ws.ctx = { room, pid };
      return broadcast(room);
    }

    if (m.type === "resume") {
      const room = rooms.get(String(m.code || "").toUpperCase());
      const p = room && room.players.get(m.id);
      if (!p) return fail("Session expired.", "resume_failed");
      p.ws = ws;
      p.connected = true;
      ws.ctx = { room, pid: p.id };
      maybeResolve(room);
      return broadcast(room);
    }

    if (!ws.ctx) return;
    const { room, pid } = ws.ctx;
    const isHost = room.host === pid;

    if (m.type === "start" && isHost && room.phase === "lobby") {
      const live = [...room.players.values()].filter((p) => p.connected);
      if (live.length < 2) return fail("You need at least 2 players.");
      room.roster = live.map((p) => ({ id: p.id, name: p.name }));
      room.scores = {};
      room.round = 1;
      room.last = null;
      room.champion = null;
      live.forEach((p) => (p.pick = null));
      room.phase = "picking";
      return broadcast(room);
    }

    if (m.type === "pick" && room.phase === "picking") {
      const n = Number(m.n);
      const p = room.players.get(pid);
      if (!Number.isInteger(n) || n < 1 || n > MAX_N) return;
      if (!room.roster.some((r) => r.id === pid) || p.pick !== null) return;
      p.pick = n;
      maybeResolve(room);
      return broadcast(room);
    }

    if (m.type === "next" && isHost && room.phase === "reveal") {
      room.round += 1;
      room.players.forEach((p) => (p.pick = null));
      room.phase = "picking";
      maybeResolve(room);
      return broadcast(room);
    }

    if (m.type === "again" && isHost && room.phase === "over") {
      for (const p of [...room.players.values()]) if (!p.connected) room.players.delete(p.id);
      room.players.forEach((p) => (p.pick = null));
      room.phase = "lobby";
      room.round = 0;
      room.roster = [];
      room.scores = {};
      room.last = null;
      room.champion = null;
      return broadcast(room);
    }

    if (m.type === "leave") {
      ws.ctx = null;
      removePlayer(room, pid);
    }
  });

  ws.on("close", () => {
    if (!ws.ctx) return;
    const { room, pid } = ws.ctx;
    const p = room.players.get(pid);
    if (!p || p.ws !== ws) return; // already replaced by a newer connection
    p.connected = false;
    if (room.host === pid) {
      const next = [...room.players.values()].find((x) => x.connected);
      if (next) room.host = next.id;
    }
    maybeResolve(room);
    broadcast(room);
  });
});

// Keep connections alive and clean up rooms nobody is in.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = [...room.players.values()].some((p) => p.connected);
    if (anyone) room.emptySince = null;
    else if (!room.emptySince) room.emptySince = now;
    else if (now - room.emptySince > 10 * 60 * 1000) rooms.delete(code);
  }
}, 30000);

server.listen(PORT, () => console.log(`Lone Wolf running on port ${PORT}`));
