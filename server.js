const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- MongoDB Setup ---
// MongoDB AtlasのURIを記述（空欄でもメモリーモードで動きます）
const MONGO_URI = process.env.MONGODB_URI;
const gameSchema = new mongoose.Schema({
  winner: String,
  timestamp: { type: Date, default: Date.now },
  duration: Number,
});
const GameResult = mongoose.model("GameResult", gameSchema);

const statsSchema = new mongoose.Schema({
  kinokoWins: { type: Number, default: 0 },
  takenokoWins: { type: Number, default: 0 },
});
const GameStats = mongoose.model("GameStats", statsSchema);

mongoose
  .connect(MONGO_URI)
  .catch((err) =>
    console.log(
      "MongoDB connection skipped (Running in memory mode):",
      err.message
    )
  );

// --- Game Constants & State ---
const TICK_RATE = 100; // ms
// 役割定義: 6人の師団長を追加
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
  inf: { hp: 100, atk: 10, def: 5, spd: 2, cost: 100 },
  tank: { hp: 150, atk: 25, def: 15, spd: 4, cost: 300 },
};

let gameState = {
  players: {}, // socketId -> { name, faction, role }
  units: [],
  countries: {
    KIN: { pp: 50, mp: 5000, eq: 2000, score: 0, color: "#e67e22" },
    TAK: { pp: 50, mp: 5000, eq: 2000, score: 0, color: "#27ae60" },
  },
  lines: [], // Battle lines
  isRunning: false,
  startTime: 0,
};

// --- Helper Functions ---
function getWinStats() {
  return GameStats.findOne({})
    .then((s) => s || { kinokoWins: 0, takenokoWins: 0 })
    .catch(() => ({ kinokoWins: 0, takenokoWins: 0 }));
}

function resetGame() {
  gameState.units = [];
  gameState.countries = {
    KIN: { pp: 50, mp: 5000, eq: 2000, score: 0, color: "#e67e22" },
    TAK: { pp: 50, mp: 5000, eq: 2000, score: 0, color: "#27ae60" },
  };
  gameState.lines = [];
  gameState.startTime = Date.now();
  gameState.isRunning = true;

  // Initial Spawn (Random types)
  for (let i = 0; i < 6; i++) spawnUnit("KIN", 100, 100 + i * 50, "inf");
  for (let i = 0; i < 6; i++) spawnUnit("TAK", 1100, 100 + i * 50, "inf");
}

let unitIdCounter = 0;
function spawnUnit(faction, x, y, typeKey) {
  const type = UNIT_TYPES[typeKey];
  // IDに基づいて 1~6 の師団に割り振る (Round-robin)
  const divNum = (unitIdCounter % 6) + 1;

  const u = {
    id: unitIdCounter++,
    faction: faction,
    type: typeKey,
    hp: type.hp,
    maxHp: type.hp,
    x: x,
    y: y,
    target: null, // {x, y}
    state: "idle",
    assignment: `Marshal_${divNum}`, // Marshal_1 ~ Marshal_6
  };
  gameState.units.push(u);
  return u;
}

// --- Game Loop (Server Side Logic) ---
setInterval(() => {
  if (!gameState.isRunning) return;

  // 1. Resource Generation
  ["KIN", "TAK"].forEach((tag) => {
    gameState.countries[tag].pp += 0.05;
    gameState.countries[tag].eq += 0.5;
  });

  // 2. Unit Logic (Move & Combat)
  const units = gameState.units;
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i];

    // Check AI Control for missing roles
    // そのユニットを担当するプレイヤー(または総司令官)がいない場合、AIが操作
    const controllerExists = Object.values(gameState.players).some(
      (p) =>
        p.faction === u.faction &&
        (p.role === "Supreme" || p.role === u.assignment)
    );

    if (!controllerExists && u.state === "idle") {
      // AI Logic: Move towards enemy side
      const targetX = u.faction === "KIN" ? 1100 : 100;
      // 少しランダムに散らす
      u.target = { x: targetX, y: u.y + (Math.random() - 0.5) * 50 };
      if (u.target.y < 50) u.target.y = 50;
      if (u.target.y > 650) u.target.y = 650;
      u.state = "moving";
    }

    if (u.state === "moving" && u.target) {
      const stats = UNIT_TYPES[u.type];
      const dx = u.target.x - u.x;
      const dy = u.target.y - u.y;
      const dist = Math.hypot(dx, dy);

      if (dist < stats.spd) {
        u.x = u.target.x;
        u.y = u.target.y;
        u.state = "idle";
        u.target = null;
      } else {
        u.x += (dx / dist) * stats.spd;
        u.y += (dy / dist) * stats.spd;
      }
    }

    // Simple Combat (Proximity)
    const enemy = units.find(
      (e) => e.faction !== u.faction && Math.hypot(e.x - u.x, e.y - u.y) < 30
    );
    if (enemy) {
      const myStats = UNIT_TYPES[u.type];
      const enStats = UNIT_TYPES[enemy.type];
      enemy.hp -= Math.max(1, myStats.atk - enStats.def / 2) * 0.1;
    }

    if (u.hp <= 0) {
      units.splice(i, 1);
    }
  }

  // 3. Sending updates
  io.emit("stateUpdate", {
    units: gameState.units,
    countries: gameState.countries,
    lines: gameState.lines,
  });
}, TICK_RATE);

// --- Socket Handling ---
app.use(express.static(path.join(__dirname, "public")));

io.on("connection", async (socket) => {
  // Send initial stats
  const stats = await getWinStats();
  socket.emit("initStats", stats);

  socket.on("joinGame", ({ name, faction, role }) => {
    gameState.players[socket.id] = { name, faction, role };
    if (!gameState.isRunning) resetGame();

    io.emit("chatMessage", {
      user: "System",
      text: `${name} joined as ${faction} [${role}]`,
    });
    socket.emit("gameStarted");
  });

  socket.on("chat", (msg) => {
    const p = gameState.players[socket.id];
    if (p)
      io.emit("chatMessage", { user: `[${p.faction}] ${p.name}`, text: msg });
  });

  socket.on("recruit", (type) => {
    const p = gameState.players[socket.id];
    if (!p || (p.role !== "Production" && p.role !== "Supreme")) return;

    const cost = UNIT_TYPES[type].cost;
    const c = gameState.countries[p.faction];
    if (c.mp >= 100 && c.eq >= cost) {
      c.mp -= 100;
      c.eq -= cost;
      const spawnX = p.faction === "KIN" ? 50 : 1150;
      // 担当師団はランダム(順番)に割り当てられる
      spawnUnit(p.faction, spawnX, 300 + (Math.random() - 0.5) * 400, type);
      io.emit("log", `${p.name} recruited ${type}`);
    }
  });

  socket.on("moveUnits", ({ unitIds, x, y }) => {
    const p = gameState.players[socket.id];
    if (!p) return;

    gameState.units.forEach((u) => {
      if (unitIds.includes(u.id) && u.faction === p.faction) {
        // 自分の担当師団かチェック
        if (p.role === "Supreme" || p.role === u.assignment) {
          u.target = { x, y };
          u.state = "moving";
        }
      }
    });
  });

  socket.on("drawBattleLine", ({ points }) => {
    const p = gameState.players[socket.id];
    if (!p || (p.role !== "Supreme" && !p.role.startsWith("Marshal"))) return;

    // 自分の担当ユニットのみ抽出
    const myUnits = gameState.units.filter(
      (u) =>
        u.faction === p.faction &&
        (p.role === "Supreme" || u.assignment === p.role)
    );

    myUnits.forEach((u, i) => {
      // 線上に均等配置
      const targetPoint =
        points[Math.floor((i / myUnits.length) * points.length)];
      if (targetPoint) {
        u.target = targetPoint;
        u.state = "moving";
      }
    });

    gameState.lines.push({ faction: p.faction, points, timestamp: Date.now() });
    if (gameState.lines.length > 20) gameState.lines.shift();
  });

  socket.on("disconnect", () => {
    delete gameState.players[socket.id];
  });
});

server.listen(3000, () => {
  console.log("Server running on port 3000");
});
