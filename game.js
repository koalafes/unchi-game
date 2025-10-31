(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const msgEl = document.getElementById('message');
  const helpEl = document.getElementById('help');
  const leftBtn = document.getElementById('leftBtn');
  const rightBtn = document.getElementById('rightBtn');
  const startBtn = document.getElementById('startBtn');
  // Lobby elements (for multiplayer)
  const lobbyEl = document.getElementById('lobby');
  const nameInput = document.getElementById('nameInput');
  const hostBtn = document.getElementById('hostBtn');
  const joinBtn = document.getElementById('joinBtn');
  const roomInput = document.getElementById('roomInput');
  const roomPanel = document.getElementById('roomPanel');
  const roomCodeEl = document.getElementById('roomCode');
  const playersEl = document.getElementById('players');
  const readyToggle = document.getElementById('readyToggle');
  const difficultySel = document.getElementById('difficulty');
  const collisionOpt = document.getElementById('collisionOpt');
  const startRoundBtn = document.getElementById('startRoundBtn');
  if (lobbyEl) lobbyEl.style.display = '';

  // World size (logical pixels)
  const W = canvas.width;   // 480
  const H = canvas.height;  // 720

  // Game state
  const State = {
    Title: 'title',
    Playing: 'playing',
    Paused: 'paused',
    GameOver: 'gameover',
    Spectating: 'spectating',
  };
  let state = State.Title;

  // Player
  const player = {
    x: W/2,
    y: H - 60,
    w: 42,
    h: 42,
    speed: 330, // px/s
    vx: 0,
    emoji: '🧍',
  };

  // Inputs
  const keys = new Set();
  let leftHeld = false;
  let rightHeld = false;

  // Poops
  const poops = [];
  const poopEmoji = '💩';
  let spawnEvery = 900; // ms, decreases over time
  let spawnTimer = 0;
  let time = 0;
  let lastSpawnAt = 0; // seconds since round start (MP deterministic spawn)
  let score = 0;
  let best = Number(localStorage.getItem('unchi-best') || 0);
  // Multiplayer state
  const net = {
    ws: null,
    roomId: null,
    hostId: null,
    meId: null,
    status: 'disconnected',
    options: { difficulty: 'normal', playerCollision: false },
    others: new Map(), // id -> { x, alive }
    clockSkew: 0,
  };
  let isMultiplayer = false;
  let iAmAlive = true;
  let roundSeed = null;
  let roundStartAt = null; // server epoch ms adjusted by skew
  let rng = null; // seeded RNG for deterministic spawns

  // Audio (tiny beep using WebAudio)
  const audio = (() => {
    let ac;
    try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
    const beep = (freq=600, dur=0.08, type='sine', vol=0.1) => {
      if (!ac) return;
      const t = ac.currentTime;
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ac.destination);
      o.start(t);
      o.stop(t + dur);
    };
    return { beep };
  })();

  function resetGame() {
    poops.length = 0;
    player.x = W/2;
    player.vx = 0;
    spawnEvery = 900;
    spawnTimer = 0;
    time = 0;
    score = 0;
    iAmAlive = true;
    lastSpawnAt = 0;
  }

  function setMessage(lines) {
    msgEl.innerHTML = Array.isArray(lines) ? lines.join('<br>') : lines;
  }

  function startPlaying() {
    if (state === State.Playing) return;
    if (state === State.Title || state === State.GameOver) resetGame();
    state = State.Playing;
    setMessage('');
    audio.beep(880, 0.06, 'triangle', 0.08);
  }

  function gameOver() {
    state = State.GameOver;
    best = Math.max(best, Math.floor(score));
    localStorage.setItem('unchi-best', String(best));
    setMessage([`ゲームオーバー！`, `スコア: ${Math.floor(score)} ／ ベスト: ${best}`, `スペース or ▶ で再開`]);
    audio.beep(180, 0.14, 'sawtooth', 0.12);
  }

  // Input handlers
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys.add(e.key.toLowerCase());
    if (e.code === 'Space') {
      e.preventDefault();
      if (state === State.Playing) {
        state = State.Paused; setMessage('一時停止中 (P/スペースで再開)');
      } else if (state === State.Paused) {
        startPlaying();
      } else {
        startPlaying();
      }
    }
    if (e.key === 'p') {
      if (state === State.Playing) { state = State.Paused; setMessage('一時停止中 (P/スペースで再開)'); }
      else if (state === State.Paused) { startPlaying(); }
    }
  });
  window.addEventListener('keyup', (e) => {
    keys.delete(e.key.toLowerCase());
  });

  // Touch buttons
  const pressLeft = (on) => { leftHeld = on; };
  const pressRight = (on) => { rightHeld = on; };
  leftBtn.addEventListener('pointerdown', () => pressLeft(true));
  leftBtn.addEventListener('pointerup', () => pressLeft(false));
  leftBtn.addEventListener('pointerleave', () => pressLeft(false));
  rightBtn.addEventListener('pointerdown', () => pressRight(true));
  rightBtn.addEventListener('pointerup', () => pressRight(false));
  rightBtn.addEventListener('pointerleave', () => pressRight(false));
  startBtn.addEventListener('click', () => {
    if (state === State.Playing) { state = State.Paused; setMessage('一時停止中'); }
    else { startPlaying(); }
  });

  function titleMessage() {
    const info = `ベスト: ${best}`;
    setMessage([`💩 うんちをよけろ！`, `左右で移動・当たると即終了`, info, `スペース or ▶ で開始`]);
  }

  titleMessage();

  function spawnPoop() {
    const size = rand(26, 44);
    const x = rand(size/2, W - size/2);
    const speed = rand(130, 220) + time * 6;
    poops.push({ x, y: -size, w: size, h: size, vy: speed, rot: rand(-0.8, 0.8) });
  }

  function update(dt) {
    if (state !== State.Playing) return;

    if (isMultiplayer && roundStartAt != null) {
      const nowMs = Date.now() - net.clockSkew;
      time = Math.max(0, (nowMs - roundStartAt) / 1000);
    } else {
      time += dt;
    }
    score += dt * 10; // 10pts per second
    scoreEl.textContent = `${Math.floor(score)}`;

    // Increase difficulty gradually
    spawnEvery = Math.max(280, 900 - time * 25);
    if (isMultiplayer) {
      while ((time - lastSpawnAt) * 1000 >= spawnEvery) {
        spawnPoop();
        lastSpawnAt += spawnEvery / 1000;
      }
    } else {
      spawnTimer -= dt * 1000;
      if (spawnTimer <= 0) {
        spawnPoop();
        spawnTimer = spawnEvery;
      }
    }

    // Horizontal input
    const left = keys.has('arrowleft') || keys.has('a') || leftHeld;
    const right = keys.has('arrowright') || keys.has('d') || rightHeld;
    let vx = 0;
    if (left && !right) vx = -player.speed;
    if (right && !left) vx = player.speed;
    player.vx = vx;
    if (iAmAlive) player.x += player.vx * dt;
    const margin = 10;
    player.x = clamp(player.x, margin + player.w/2, W - margin - player.w/2);

    // Move poops
    for (let p of poops) {
      p.y += p.vy * dt;
    }
    // Remove off-screen
    for (let i = poops.length - 1; i >= 0; i--) {
      if (poops[i].y - poops[i].h/2 > H + 60) poops.splice(i, 1);
    }

    // Collisions
    if (iAmAlive) {
      const pb = bounds(player);
      for (let p of poops) {
        const b = { x: p.x - p.w/2, y: p.y - p.h/2, w: p.w, h: p.h };
        if (intersect(pb, b)) {
          if (isMultiplayer) {
            iAmAlive = false;
            state = State.Spectating;
            safeSend({ type: 'dead', t: Date.now() });
          } else {
            gameOver();
          }
          break;
        }
      }
      if (isMultiplayer && net.options.playerCollision) {
        for (const [, op] of net.others) {
          if (!op || !op.alive) continue;
          const ob = { x: (op.x || W/2) - player.w/2, y: player.y - player.h/2, w: player.w, h: player.h };
          const meb = bounds(player);
          if (intersect(meb, ob)) { iAmAlive = false; state = State.Spectating; safeSend({ type: 'dead', t: Date.now() }); break; }
        }
      }
    }
  }

  function draw() {
    // Clear
    ctx.clearRect(0, 0, W, H);

    // Subtle grid background
    drawGrid();

    // Player and others
    if (iAmAlive) drawPlayer(); else drawPlayerGhost();
    for (let [id, op] of net.others) {
      drawOther(op);
    }

    // Poops
    for (let p of poops) drawPoop(p);
  }

  function drawGrid() {
    const s = 24;
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += s) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y <= H; y += s) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.restore();
  }

  function drawPlayer() {
    const c = { x: player.x, y: player.y };
    // Base
    ctx.save();
    ctx.fillStyle = '#6cf';
    roundRect(ctx, c.x - player.w/2, c.y - player.h/2, player.w, player.h, 8);
    ctx.fill();
    // Eyes
    ctx.fillStyle = '#012';
    ctx.beginPath();
    ctx.arc(c.x - 10, c.y - 6, 4, 0, Math.PI*2);
    ctx.arc(c.x + 10, c.y - 6, 4, 0, Math.PI*2);
    ctx.fill();
    // Mouth
    ctx.strokeStyle = '#012';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(c.x, c.y + 8, 10, 0, Math.PI, false); ctx.stroke();
    ctx.restore();
  }

  function drawPlayerGhost() {
    const c = { x: player.x, y: player.y };
    ctx.save();
    ctx.fillStyle = 'rgba(160,200,255,0.35)';
    roundRect(ctx, c.x - player.w/2, c.y - player.h/2, player.w, player.h, 8);
    ctx.fill();
    ctx.restore();
  }

  function drawOther(op) {
    const x = op && typeof op.x === 'number' ? op.x : W/2;
    const c = { x, y: player.y };
    ctx.save();
    ctx.fillStyle = op && op.alive ? '#fc6' : 'rgba(255,200,120,0.35)';
    roundRect(ctx, c.x - player.w/2, c.y - player.h/2, player.w, player.h, 8);
    ctx.fill();
    ctx.restore();
  }

  function drawPoop(p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    // Draw emoji with shadow
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.floor(p.h)}px "Noto Color Emoji", Emoji, system-ui, sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 10;
    ctx.fillText(poopEmoji, 0, 0);
    ctx.restore();
  }

  // Helpers
  function bounds(obj) {
    return { x: obj.x - obj.w/2, y: obj.y - obj.h/2, w: obj.w, h: obj.h };
  }
  function intersect(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function rand(a, b) { const r = rng ? rng() : Math.random(); return r * (b - a) + a; }
  function mulberry32(a) {
    return function() {
      let t = a += 0x6D2B79F5;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  // Main loop
  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.033, (now - last) / 1000); // clamp dt
    last = now;
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  
  // Multiplayer networking
  const WS_URL = (window.UNCHI_WS_URL) || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.hostname + ':8080');
  function connectIfNeeded(cb) {
    if (net.ws && net.ws.readyState === WebSocket.OPEN) { cb(); return; }
    if (net.ws && net.ws.readyState === WebSocket.CONNECTING) { setTimeout(() => connectIfNeeded(cb), 100); return; }
    try {
      const ws = new WebSocket(WS_URL);
      net.ws = ws;
      ws.addEventListener('open', () => cb());
      ws.addEventListener('message', onMessage);
      ws.addEventListener('close', () => { net.status = 'disconnected'; if (roomPanel) roomPanel.style.display = 'none'; });
      ws.addEventListener('error', () => { setMessage('サーバーに接続できません'); });
    } catch {}
  }
  function safeSend(obj) { if (net.ws && net.ws.readyState === WebSocket.OPEN) net.ws.send(JSON.stringify(obj)); }
  function onMessage(ev) {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'hello') {
      net.meId = m.id;
    } else if (m.type === 'room_state') {
      net.roomId = m.roomId; net.hostId = m.hostId; net.status = m.status; net.options = m.options || net.options;
      updateRoomUI(m);
    } else if (m.type === 'round_start') {
      isMultiplayer = true; resetGame();
      roundSeed = m.seed >>> 0; rng = mulberry32(roundSeed);
      net.options = m.options || net.options;
      net.clockSkew = Date.now() - (m.serverTime || Date.now());
      roundStartAt = m.startTime;
      state = State.Playing; iAmAlive = true; setMessage('開始！');
      startPosLoop();
    } else if (m.type === 'positions') {
      for (const p of m.positions || []) {
        if (p.id === net.meId) continue;
        let op = net.others.get(p.id);
        if (!op) { op = { x: p.x, alive: true }; net.others.set(p.id, op); }
        op.x = typeof op.x === 'number' ? (op.x + (p.x - op.x) * 0.4) : p.x;
      }
    } else if (m.type === 'player_dead') {
      const op = net.others.get(m.id); if (op) op.alive = false;
    } else if (m.type === 'round_end') {
      const winnerId = m.winnerId;
      setMessage(`ラウンド終了！ 勝者: ${winnerId === net.meId ? 'あなた' : (winnerId ? '相手' : 'なし')}`);
      state = State.GameOver; rng = null; roundStartAt = null;
    } else if (m.type === 'error') {
      setMessage(`エラー: ${m.msg || m.code}`);
    }
  }
  function updateRoomUI(rs) {
    if (!lobbyEl || !roomPanel) return;
    lobbyEl.style.display = '';
    roomPanel.style.display = 'block';
    if (roomCodeEl) roomCodeEl.textContent = rs.roomId || '-';
    const amHost = rs.hostId === net.meId;
    if (startRoundBtn) startRoundBtn.style.display = amHost ? '' : 'none';
    if (difficultySel) difficultySel.disabled = !amHost;
    if (collisionOpt) collisionOpt.disabled = !amHost;
    if (playersEl) {
      playersEl.innerHTML = '';
      (rs.players || []).forEach(p => {
        if (p.id && p.id !== net.meId && !net.others.has(p.id)) net.others.set(p.id, { x: W/2, alive: true });
        const li = document.createElement('li');
        li.textContent = `${p.name}${p.id === rs.hostId ? ' 👑' : ''} ${p.ready ? '✅' : '⏳'} ${rs.status === 'playing' ? (p.alive ? '🟢' : '⚪') : ''}`;
        playersEl.appendChild(li);
      });
    }
  }
  function startPosLoop() {
    if (startPosLoop._t) return;
    const tick = () => {
      if (net.ws && net.ws.readyState === WebSocket.OPEN && state === State.Playing && iAmAlive) {
        safeSend({ type: 'pos', x: player.x, t: Date.now() });
      }
      startPosLoop._t = setTimeout(tick, 66);
    };
    tick();
  }
  if (hostBtn) hostBtn.addEventListener('click', () => {
    const name = (nameInput?.value || '').trim() || 'Player';
    connectIfNeeded(() => safeSend({ type: 'create_room', name }));
  });
  if (joinBtn) joinBtn.addEventListener('click', () => {
    const name = (nameInput?.value || '').trim() || 'Player';
    const roomId = (roomInput?.value || '').trim().toUpperCase();
    if (!roomId) { setMessage('ルームIDを入力'); return; }
    connectIfNeeded(() => safeSend({ type: 'join_room', roomId, name }));
  });
  if (readyToggle) readyToggle.addEventListener('change', () => {
    safeSend({ type: 'set_ready', ready: !!readyToggle.checked });
  });
  if (difficultySel) difficultySel.addEventListener('change', () => {
    safeSend({ type: 'set_options', difficulty: difficultySel.value });
  });
  if (collisionOpt) collisionOpt.addEventListener('change', () => {
    safeSend({ type: 'set_options', playerCollision: !!collisionOpt.checked });
  });
  if (startRoundBtn) startRoundBtn.addEventListener('click', () => safeSend({ type: 'start_round' }));
})();
