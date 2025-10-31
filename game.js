(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const scoreEl = document.getElementById('score');
  const msgEl = document.getElementById('message');
  const helpEl = document.getElementById('help');
  const leftBtn = document.getElementById('leftBtn');
  const rightBtn = document.getElementById('rightBtn');
  const startBtn = document.getElementById('startBtn');

  // World size (logical pixels)
  const W = canvas.width;   // 480
  const H = canvas.height;  // 720

  // Game state
  const State = {
    Title: 'title',
    Playing: 'playing',
    Paused: 'paused',
    GameOver: 'gameover',
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
  let score = 0;
  let best = Number(localStorage.getItem('unchi-best') || 0);

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

    time += dt;
    score += dt * 10; // 10pts per second
    scoreEl.textContent = `${Math.floor(score)}`;

    // Increase difficulty gradually
    spawnEvery = Math.max(280, 900 - time * 25);
    spawnTimer -= dt * 1000;
    if (spawnTimer <= 0) {
      spawnPoop();
      spawnTimer = spawnEvery;
    }

    // Horizontal input
    const left = keys.has('arrowleft') || keys.has('a') || leftHeld;
    const right = keys.has('arrowright') || keys.has('d') || rightHeld;
    let vx = 0;
    if (left && !right) vx = -player.speed;
    if (right && !left) vx = player.speed;
    player.vx = vx;
    player.x += player.vx * dt;
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
    const pb = bounds(player);
    for (let p of poops) {
      const b = { x: p.x - p.w/2, y: p.y - p.h/2, w: p.w, h: p.h };
      if (intersect(pb, b)) {
        gameOver();
        break;
      }
    }
  }

  function draw() {
    // Clear
    ctx.clearRect(0, 0, W, H);

    // Subtle grid background
    drawGrid();

    // Player
    drawPlayer();

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
  function rand(a, b) { return Math.random() * (b - a) + a; }
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
})();

