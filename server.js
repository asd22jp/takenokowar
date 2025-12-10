const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- MongoDB Setup (任意) ---
const MONGO_URI = process.env.MONGO_URI;
const statsSchema = new mongoose.Schema({
  kinokoWins: Number,
  takenokoWins: Number,
});
const GameStats = mongoose.model("GameStats", statsSchema);
mongoose
  .connect(MONGO_URI)
  .catch(() => console.log("MongoDB skipped (Memory mode)"));

// --- Game Constants ---
const TICK_RATE = 200; // ms
const MAP_W = 20;
const MAP_H = 12;
const ROLES = [
  "Supreme",
  "Production",
  "Marshal_1",
  "Marshal_2",
  "Marshal_3",
  "Marshal_4",
  "Marshal_5",
  "Marshal_6",
];

const UNIT_TYPES = {
  inf: { name: "歩兵", hp: 100, atk: 12, def: 20, spd: 0.2, cost: 100 },
  tank: { name: "戦車", hp: 150, atk: 30, def: 15, spd: 0.4, cost: 300 },
};

// --- Game State ---
let gameState = {
  players: {},
  hexes: [], // { q, r, owner, id }
  units: [],
  countries: {
    KIN: { pp: 50, mp: 5000, eq: 2000, color: "#e67e22" },
    TAK: { pp: 50, mp: 5000, eq: 2000, color: "#27ae60" },
  },
  isRunning: false,
};

// --- Hex System (Axial Coordinates) ---
function createMap() {
  gameState.hexes = [];
  let idCounter = 0;
  for (let q = 0; q < MAP_W; q++) {
    for (let r = 0; r < MAP_H; r++) {
      // Offset coord to Axial
      // ここでは簡易的に四角いグリッドとして管理し、クライアントでズレを描画します
      let owner = q < MAP_W / 2 ? "KIN" : "TAK";
      gameState.hexes.push({ id: idCounter++, q, r, owner });
    }
  }
}

function getHex(q, r) {
  return gameState.hexes.find((h) => h.q === q && h.r === r);
}

// 簡易的な隣接判定 (Offset Grid logic for Even-Q layout)
function getNeighbors(h) {
  const directions = [
    [+1, 0],
    [+1, -1],
    [0, -1],
    [-1, -1],
    [-1, 0],
    [0, +1],
  ];
  // Note: 完全なAxial計算は複雑なため、ここではマンハッタン距離的な簡易移動とします
  // 本格的なヘックス計算が必要ならライブラリ推奨ですが、今回はグリッド移動で擬似再現します
  const list = [];
  // Odd-r horizontal layout logic simplified:
  const offset = h.r % 2 ? 1 : 0;

  // 6方向の近似 (ゲーム性を損なわない範囲で上下左右斜め)
  const candidates = [
    { q: h.q + 1, r: h.r },
    { q: h.q - 1, r: h.r },
    { q: h.q, r: h.r + 1 },
    { q: h.q, r: h.r - 1 },
    { q: h.q + (h.r % 2 ? 1 : -1), r: h.r + 1 },
    { q: h.q + (h.r % 2 ? 1 : -1), r: h.r - 1 },
  ];

  candidates.forEach((c) => {
    const neighbor = getHex(c.q, c.r);
    if (neighbor) list.push(neighbor);
  });
  return list;
}

// BFS Pathfinding
function findPath(startHex, endHex) {
  if (!startHex || !endHex) return [];
  let queue = [{ hex: startHex, path: [] }];
  let visited = new Set([startHex.id]);

  while (queue.length > 0) {
    let { hex, path } = queue.shift();
    if (hex.id === endHex.id) return path;

    if (path.length > 15) continue; // Limit range

    let neighbors = getNeighbors(hex);
    for (let n of neighbors) {
      if (!visited.has(n.id)) {
        visited.add(n.id);
        queue.push({ hex: n, path: [...path, n] });
      }
    }
  }
  return null;
}

// --- Game Logic ---
let unitIdCounter = 0;

function resetGame() {
  createMap();
  gameState.units = [];
  gameState.countries.KIN = { pp: 50, mp: 5000, eq: 2000, color: "#e67e22" };
  gameState.countries.TAK = { pp: 50, mp: 5000, eq: 2000, color: "#27ae60" };
  gameState.isRunning = true;

  // Initial Units
  for (let i = 0; i < 6; i++) spawnUnit("KIN", 2, 2 + i, "inf");
  for (let i = 0; i < 6; i++) spawnUnit("TAK", MAP_W - 3, 2 + i, "inf");
}

function spawnUnit(faction, q, r, typeKey) {
  const type = UNIT_TYPES[typeKey];
  const h = getHex(q, r);
  if (!h) return;

  const divNum = (unitIdCounter % 6) + 1;
  const u = {
    id: unitIdCounter++,
    faction,
    type: typeKey,
    stats: { ...type },
    hp: type.hp,
    maxHp: type.hp,
    q: h.q,
    r: h.r, // Current logical pos
    drawX: 0,
    drawY: 0, // Client smooth render pos (Server logic doesn't use this but handy)
    targetHexId: null,
    path: [],
    state: "idle",
    progress: 0, // 0.0 to 1.0 travel to next hex
    assignment: `Marshal_${divNum}`,
  };
  gameState.units.push(u);
  return u;
}

// Tick Loop
setInterval(() => {
  if (!gameState.isRunning) return;

  // Resources
  ["KIN", "TAK"].forEach((c) => {
    gameState.countries[c].pp += 0.1;
    gameState.countries[c].eq += 1;
  });

  // Units
  gameState.units.forEach((u) => {
    // 1. AI Logic (Fallback)
    const hasPlayer = Object.values(gameState.players).some(
      (p) =>
        p.faction === u.faction &&
        (p.role === "Supreme" || p.role === u.assignment)
    );
    if (!hasPlayer && u.state === "idle" && Math.random() < 0.05) {
      const targetQ = u.faction === "KIN" ? MAP_W - 2 : 1;
      const targetR = Math.floor(Math.random() * MAP_H);
      const start = getHex(u.q, u.r);
      const end = getHex(targetQ, targetR);
      const path = findPath(start, end);
      if (path) {
        u.path = path;
        u.state = "moving";
      }
    }

    // 2. Movement
    if (u.state === "moving" && u.path.length > 0) {
      const nextHex = u.path[0];

      // Combat Check (Enemy in next hex?)
      const enemy = gameState.units.find(
        (e) => e.q === nextHex.q && e.r === nextHex.r && e.faction !== u.faction
      );
      if (enemy) {
        // Combat!
        u.progress = 0; // Stuck fighting
        enemy.hp -= u.stats.atk * 0.5;
        u.hp -= enemy.stats.atk * 0.2; // Defender advantage

        if (enemy.hp <= 0) {
          /* handled in cleanup */
        }
      } else {
        // Move
        u.progress += u.stats.spd;
        if (u.progress >= 1.0) {
          u.q = nextHex.q;
          u.r = nextHex.r;
          u.path.shift();
          u.progress = 0;

          // Conquer Hex
          const currentHex = getHex(u.q, u.r);
          if (currentHex && currentHex.owner !== u.faction) {
            currentHex.owner = u.faction;
          }

          if (u.path.length === 0) u.state = "idle";
        }
      }
    }
  });

  // Cleanup Dead
  gameState.units = gameState.units.filter((u) => u.hp > 0);

  // Broadcast (Diff compression is better, but sending full state for simplicity)
  io.emit("stateUpdate", {
    hexes: gameState.hexes, // In a real game, only send changes
    units: gameState.units,
    countries: gameState.countries,
  });
}, TICK_RATE);

// --- Socket ---
app.use(express.static(path.join(__dirname, "public")));

io.on("connection", (socket) => {
  socket.on("joinGame", (info) => {
    gameState.players[socket.id] = info;
    if (!gameState.isRunning) resetGame();
    socket.emit("gameStarted");
  });

  socket.on("chat", (msg) => {
    const p = gameState.players[socket.id];
    if (p)
      io.emit("chatMessage", {
        user: `[${p.role}] ${p.name}`,
        text: msg,
        color: p.faction === "KIN" ? "#e67e22" : "#27ae60",
      });
  });

  socket.on("recruit", (type) => {
    const p = gameState.players[socket.id];
    if (!p || (p.role !== "Production" && p.role !== "Supreme")) return;

    const c = gameState.countries[p.faction];
    const cost = UNIT_TYPES[type].cost;
    if (c.mp >= 100 && c.eq >= cost) {
      c.mp -= 100;
      c.eq -= cost;
      const q = p.faction === "KIN" ? 1 : MAP_W - 2;
      const r = Math.floor(Math.random() * MAP_H);
      spawnUnit(p.faction, q, r, type);
    }
  });

  socket.on("orderMove", ({ unitIds, targetQ, targetR }) => {
    const p = gameState.players[socket.id];
    if (!p) return;

    const targetHex = getHex(targetQ, targetR);
    if (!targetHex) return;

    gameState.units.forEach((u) => {
      if (unitIds.includes(u.id) && u.faction === p.faction) {
        if (p.role === "Supreme" || p.role === u.assignment) {
          const start = getHex(u.q, u.r);
          const path = findPath(start, targetHex);
          if (path) {
            u.path = path;
            u.state = "moving";
          }
        }
      }
    });
  });

  // Battle Line (Simplified: list of hexes to attack)
  socket.on("orderFrontline", ({ unitIds, hexIds }) => {
    const p = gameState.players[socket.id];
    if (!p) return;

    // Distribute units to the target hexes
    const targets = hexIds
      .map((id) => gameState.hexes.find((h) => h.id === id))
      .filter((h) => h);
    if (targets.length === 0) return;

    let targetIdx = 0;
    gameState.units.forEach((u) => {
      if (unitIds.includes(u.id) && u.faction === p.faction) {
        if (p.role === "Supreme" || p.role === u.assignment) {
          const start = getHex(u.q, u.r);
          const end = targets[targetIdx % targets.length];
          targetIdx++;
          const path = findPath(start, end);
          if (path) {
            u.path = path;
            u.state = "moving";
          }
        }
      }
    });
  });

  socket.on("disconnect", () => delete gameState.players[socket.id]);
});

server.listen(3000, () => console.log("Server on 3000"));
