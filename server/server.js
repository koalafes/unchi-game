import { WebSocketServer } from 'ws';
import { customAlphabet } from 'nanoid';

const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

const wss = new WebSocketServer({ port: PORT });

// Room and player state
const rooms = new Map(); // roomId -> { id, status, hostId, players: Map<id, player>, options, seed, startTime }

function makeRoom() {
  const id = nanoid();
  return {
    id,
    status: 'lobby', // 'lobby' | 'playing'
    hostId: null,
    players: new Map(),
    options: { difficulty: 'normal', playerCollision: false },
    seed: null,
    startTime: null,
  };
}

function broadcast(room, type, data) {
  const payload = JSON.stringify({ type, ...data });
  for (const p of room.players.values()) {
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(payload);
  }
}

function roomState(room) {
  return {
    roomId: room.id,
    hostId: room.hostId,
    status: room.status,
    options: room.options,
    players: Array.from(room.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      ready: !!p.ready,
      alive: !!p.alive,
    })),
  };
}

function assignNewHost(room) {
  const first = Array.from(room.players.values())[0];
  room.hostId = first ? first.id : null;
}

function endRoundIfDone(room) {
  if (room.status !== 'playing') return;
  const alive = Array.from(room.players.values()).filter(p => p.alive);
  if (alive.length <= 1) {
    const winnerId = alive[0]?.id || null;
    broadcast(room, 'round_end', { winnerId, ranks: buildRanks(room) });
    // Reset to lobby
    room.status = 'lobby';
    room.seed = null;
    room.startTime = null;
    for (const p of room.players.values()) {
      p.ready = false;
      p.alive = true;
    }
    broadcast(room, 'room_state', roomState(room));
  }
}

function buildRanks(room) {
  // Simple ranks: alive first, then by deathTime
  const arr = Array.from(room.players.values()).map(p => ({ id: p.id, alive: p.alive, deathTime: p.deathTime ?? Infinity }));
  arr.sort((a, b) => (b.alive - a.alive) || (a.deathTime - b.deathTime));
  return arr.map((x, i) => ({ id: x.id, rank: i + 1 }));
}

function sanitizeName(name) {
  const s = String(name || '').trim().slice(0, 16);
  return s || 'Player';
}

function send(ws, type, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...data }));
}

wss.on('connection', (ws) => {
  const client = { id: null, room: null };

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch {
      return send(ws, 'error', { code: 'bad_json', msg: 'Invalid JSON' });
    }
    const t = msg.type;

    if (t === 'create_room') {
      const room = makeRoom();
      rooms.set(room.id, room);
      const id = nanoid();
      const name = sanitizeName(msg.name);
      room.hostId = id;
      const player = { id, name, ws, ready: false, alive: true, x: 240, deathTime: null };
      room.players.set(id, player);
      client.id = id; client.room = room.id;
      send(ws, 'room_state', roomState(room));
      send(ws, 'hello', { id });
      return;
    }

    if (t === 'join_room') {
      const room = rooms.get(String(msg.roomId || ''));
      if (!room) return send(ws, 'error', { code: 'no_room', msg: 'Room not found' });
      if (room.status !== 'lobby') return send(ws, 'error', { code: 'in_progress', msg: 'Round in progress' });
      if (room.players.size >= 4) return send(ws, 'error', { code: 'full', msg: 'Room full' });
      const id = nanoid();
      const name = sanitizeName(msg.name);
      const player = { id, name, ws, ready: false, alive: true, x: 240, deathTime: null };
      room.players.set(id, player);
      client.id = id; client.room = room.id;
      broadcast(room, 'room_state', roomState(room));
      send(ws, 'hello', { id });
      return;
    }

    // All following require being in a room
    const room = rooms.get(client.room || '');
    if (!room) return send(ws, 'error', { code: 'no_room', msg: 'Not in room' });
    const me = room.players.get(client.id);
    if (!me) return send(ws, 'error', { code: 'no_player', msg: 'Player not found' });

    if (t === 'set_ready') {
      me.ready = !!msg.ready;
      broadcast(room, 'room_state', roomState(room));
      return;
    }

    if (t === 'set_options') {
      if (room.hostId !== me.id) return send(ws, 'error', { code: 'not_host', msg: 'Only host can change options' });
      if (room.status !== 'lobby') return send(ws, 'error', { code: 'in_progress', msg: 'Round in progress' });
      const { difficulty, playerCollision } = msg;
      if (difficulty && ['easy', 'normal', 'hard'].includes(difficulty)) room.options.difficulty = difficulty;
      if (typeof playerCollision === 'boolean') room.options.playerCollision = playerCollision;
      broadcast(room, 'room_state', roomState(room));
      return;
    }

    if (t === 'start_round') {
      if (room.hostId !== me.id) return send(ws, 'error', { code: 'not_host', msg: 'Only host can start' });
      if (room.status !== 'lobby') return send(ws, 'error', { code: 'in_progress', msg: 'Round in progress' });
      const allReady = Array.from(room.players.values()).every(p => p.ready);
      if (!allReady) return send(ws, 'error', { code: 'not_ready', msg: 'All players must be ready' });
      room.status = 'playing';
      room.seed = Math.floor(Math.random() * 0xFFFFFFFF) >>> 0;
      room.startTime = Date.now() + 1500; // start in 1.5s to align
      for (const p of room.players.values()) { p.alive = true; p.deathTime = null; }
      broadcast(room, 'round_start', { seed: room.seed, startTime: room.startTime, serverTime: Date.now(), options: room.options });
      broadcast(room, 'room_state', roomState(room));
      return;
    }

    if (t === 'pos') {
      if (room.status !== 'playing' || !me.alive) return;
      const x = Number(msg.x);
      if (Number.isFinite(x)) me.x = Math.max(21, Math.min(459, x));
      // relay to others
      const payload = JSON.stringify({ type: 'positions', positions: [{ id: me.id, x: me.x, t: Date.now() }] });
      for (const p of room.players.values()) {
        if (p.id === me.id) continue;
        if (p.ws.readyState === p.ws.OPEN) p.ws.send(payload);
      }
      return;
    }

    if (t === 'dead') {
      if (room.status !== 'playing' || !me.alive) return;
      me.alive = false;
      me.deathTime = Date.now();
      broadcast(room, 'player_dead', { id: me.id });
      endRoundIfDone(room);
      return;
    }

    if (t === 'leave') {
      ws.close();
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(client.room || '');
    if (!room) return;
    const p = room.players.get(client.id);
    if (!p) return;
    const wasHost = room.hostId === p.id;
    const wasAlivePlaying = room.status === 'playing' && p.alive;
    room.players.delete(p.id);
    if (room.players.size === 0) {
      rooms.delete(room.id);
      return;
    }
    if (wasHost) assignNewHost(room);
    if (wasAlivePlaying) {
      broadcast(room, 'player_dead', { id: p.id });
      endRoundIfDone(room);
    }
    broadcast(room, 'room_state', roomState(room));
  });
});

console.log(`[unchi] WebSocket server listening on :${PORT}`);
