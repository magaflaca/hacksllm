// Fondo: un estanque pixelado. De dia cielo pastel y nenufares; de noche luna, estrellas y luciernagas.

const PIXEL = 4;
const FRAME_MS = 140;
const HORIZON = 0.62;

const PALETTES = {
  light: {
    sky: ['#bcdcf7', '#c9d7f6', '#dccff2', '#efd0e6', '#fbdcd2'],
    ridges: ['#d8cdef', '#bfe3d3'],
    water: ['#bfe6ea', '#acdbe3', '#9ccfdc', '#8fc3d6'],
    glint: ['#effcff', '#d9f4f7'],
    orb: ['#fff7d6', '#ffe9a8'],
    cloud: ['#ffffff', '#ece4f8'],
    pad: ['#9fd6a8', '#7fbf8f', '#5fa575'],
    bloom: ['#f9b8d0', '#fde3ec'],
    reed: ['#7fb28c', '#c99a7a'],
    motes: ['#ffffff', '#fbe7a3', '#f9c6da'],
  },
  dark: {
    sky: ['#0f1029', '#141633', '#191b3d', '#1f2148', '#262651'],
    ridges: ['#1d1f45', '#17193a'],
    water: ['#141838', '#11143a', '#0e1132', '#0b0d2a'],
    glint: ['#7c8fd6', '#4d5aa6'],
    orb: ['#f6efcf', '#d9cf9f'],
    stars: ['#e7e6ff', '#fff3a0', '#9fb6ff'],
    pad: ['#2a5c55', '#214a45', '#183935'],
    bloom: ['#c78db0', '#e8b9d2'],
    reed: ['#24423f', '#5b4636'],
    motes: ['#fff3a0', '#d6ff9c'],
  },
};

const CLOUDS = [
  [[7, 0, 6], [4, 1, 12], [2, 2, 17], [0, 3, 22], [2, 4, 18]],
  [[4, 0, 5], [2, 1, 10], [0, 2, 14], [1, 3, 11]],
  [[8, 0, 5], [5, 1, 11], [16, 1, 4], [3, 2, 18], [0, 3, 23], [3, 4, 17]],
];

const PAD = [
  '..oooooo..',
  '.oooooooo.',
  'oooooo.ooo',
  '.oooo...o.',
  '..oooooo..',
];
const BLOOM = ['.p.p.', 'ppwpp', '.ppp.'];

const random = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

export function startPond(canvas, getTheme) {
  const ctx = canvas.getContext('2d');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let width, height, horizon, backdrop, world, tick = 0;

  const ridgeTop = (x, layer) =>
    Math.round(horizon - 2 + layer * 2 - Math.abs(Math.sin(x * 0.021 + layer * 1.7)) * (7 - layer * 3) - Math.sin(x * 0.07 + layer) * 1.5);

  function paintBackdrop(palette) {
    backdrop = new OffscreenCanvas(width, height);
    const paint = backdrop.getContext('2d');
    const band = Math.ceil(horizon / palette.sky.length);
    palette.sky.forEach((color, index) => {
      paint.fillStyle = color;
      paint.fillRect(0, index * band, width, band + 1);
      if (index) for (let x = 0; x < width; x += 2) paint.fillRect(x + (index % 2), index * band - 1, 1, 1);
    });
    if (palette.stars) {
      const next = random(7);
      for (let i = 0; i < width * 0.18; i++) {
        paint.fillStyle = palette.stars[Math.floor(next() * palette.stars.length)];
        paint.fillRect(Math.floor(next() * width), Math.floor(next() * horizon * 0.85), 1, 1);
      }
    }
    palette.ridges.forEach((color, layer) => {
      paint.fillStyle = color;
      for (let x = 0; x < width; x++) paint.fillRect(x, ridgeTop(x, layer), 1, horizon - ridgeTop(x, layer));
    });
    const deep = Math.ceil((height - horizon) / palette.water.length);
    palette.water.forEach((color, index) => {
      paint.fillStyle = color;
      paint.fillRect(0, horizon + index * deep, width, deep + 1);
      if (index) for (let x = 0; x < width; x += 2) paint.fillRect(x + (index % 2), horizon + index * deep - 1, 1, 1);
    });
    paint.fillStyle = palette.glint[1];
    paint.fillRect(0, horizon, width, 1);
    paintReeds(paint, palette.reed);
  }

  function paintReeds(paint, [stem, head]) {
    const next = random(31);
    for (const side of [0, 1]) {
      for (let i = 0; i < 7; i++) {
        const x = side ? width - 2 - Math.floor(next() * 16) : 1 + Math.floor(next() * 16);
        const tall = 10 + Math.floor(next() * 14);
        paint.fillStyle = stem;
        paint.fillRect(x, height - tall, 1, tall);
        if (next() > 0.4) {
          paint.fillStyle = head;
          paint.fillRect(x - (next() > 0.5 ? 1 : 0), height - tall - 1, 2, 4);
        }
      }
    }
  }

  function buildWorld() {
    const next = random(width * 13 + height);
    const water = height - horizon;
    const orbX = Math.floor(width * 0.74);
    const orbY = Math.floor(horizon * 0.3);
    world = {
      orb: { x: orbX, y: orbY, r: Math.max(5, Math.round(Math.min(width, height) * 0.035)) },
      clouds: Array.from({ length: Math.max(3, Math.round(width / 70)) }, () => ({
        x: next() * width,
        y: 4 + next() * horizon * 0.45,
        shape: CLOUDS[Math.floor(next() * CLOUDS.length)],
        speed: 0.05 + next() * 0.08,
      })),
      glints: Array.from({ length: Math.round(width * water * 0.004) + 6 }, () => ({
        x: next() * width,
        y: horizon + 2 + Math.floor(next() * (water - 4)),
        len: 2 + Math.floor(next() * 5),
        phase: Math.floor(next() * 40),
      })),
      pads: Array.from({ length: Math.max(3, Math.round(width / 90)) }, (_, index) => ({
        x: Math.floor(next() * (width - 12)),
        y: Math.floor(horizon + water * (0.25 + next() * 0.62)),
        bloom: index % 2 === 0,
        phase: next() * 6,
      })),
      motes: Array.from({ length: Math.max(6, Math.round(width / 28)) }, () => ({
        x: next() * width,
        y: horizon * 0.35 + next() * (height - horizon * 0.35),
        vx: (next() - 0.5) * 0.4,
        vy: (next() - 0.5) * 0.25,
        phase: Math.floor(next() * 30),
        color: Math.floor(next() * 3),
      })),
    };
  }

  function drawOrb(palette) {
    const { x, y, r } = world.orb;
    for (let dy = -r; dy <= r; dy++) {
      const span = Math.round(Math.sqrt(r * r - dy * dy));
      ctx.fillStyle = palette.orb[0];
      ctx.fillRect(x - span, y + dy, span * 2 + 1, 1);
      if (getTheme() === 'dark' && dy > -r / 3) {
        ctx.fillStyle = palette.orb[1];
        ctx.fillRect(x + span - Math.round(r * 0.55), y + dy, Math.max(1, Math.round(r * 0.55 - (r - span))), 1);
      }
    }
    const water = height - horizon;
    for (let row = 2; row < water * 0.55; row += 2) {
      const sway = Math.round(Math.sin((row + tick * 0.6) * 0.5) * 2);
      const span = Math.max(1, Math.round(r * (1.1 - row / water) * (0.6 + ((row * 7 + tick) % 5) / 10)));
      ctx.fillStyle = palette.glint[row % 4 === 0 ? 0 : 1];
      ctx.fillRect(x - span + sway, horizon + row, span * 2, 1);
    }
  }

  function drawClouds(palette) {
    for (const cloud of world.clouds) {
      if (!still) cloud.x += cloud.speed;
      if (cloud.x > width + 4) cloud.x = -26;
      const x0 = Math.round(cloud.x);
      const y0 = Math.round(cloud.y);
      cloud.shape.forEach(([x, y, w], index) => {
        ctx.fillStyle = index === cloud.shape.length - 1 ? palette.cloud[1] : palette.cloud[0];
        ctx.fillRect(x0 + x, y0 + y, w, 1);
      });
    }
  }

  function drawGlints(palette) {
    for (const glint of world.glints) {
      const phase = (tick + glint.phase) % 40;
      if (phase > 26) continue;
      const shift = Math.round(Math.sin((tick + glint.phase) * 0.15) * 2);
      ctx.fillStyle = palette.glint[phase < 13 ? 0 : 1];
      ctx.fillRect(Math.round(glint.x) + shift, glint.y, glint.len, 1);
    }
  }

  function drawPads(palette) {
    for (const pad of world.pads) {
      const bob = Math.round(Math.sin(tick * 0.08 + pad.phase));
      PAD.forEach((row, y) => {
        [...row].forEach((key, x) => {
          if (key !== 'o') return;
          ctx.fillStyle = y === 0 || x === 0 ? palette.pad[0] : y === PAD.length - 1 ? palette.pad[2] : palette.pad[1];
          ctx.fillRect(pad.x + x, pad.y + y + bob, 1, 1);
        });
      });
      if (!pad.bloom) continue;
      BLOOM.forEach((row, y) => {
        [...row].forEach((key, x) => {
          if (key === '.') return;
          ctx.fillStyle = key === 'w' ? palette.bloom[1] : palette.bloom[0];
          ctx.fillRect(pad.x + 2 + x, pad.y - 2 + y + bob, 1, 1);
        });
      });
    }
  }

  function drawMotes(palette) {
    const night = getTheme() === 'dark';
    for (const mote of world.motes) {
      if (!still) {
        mote.x = (mote.x + mote.vx + Math.sin((tick + mote.phase) * 0.07) * 0.3 + width) % width;
        mote.y += mote.vy + Math.cos((tick + mote.phase) * 0.05) * 0.2;
        if (mote.y < horizon * 0.3 || mote.y > height - 2) mote.vy *= -1;
      }
      const pulse = (tick + mote.phase) % 30;
      if (night && pulse > 20) continue;
      const x = Math.round(mote.x);
      const y = Math.round(mote.y);
      ctx.fillStyle = palette.motes[mote.color % palette.motes.length];
      ctx.fillRect(x, y, 1, 1);
      if (night && pulse > 4 && pulse < 16) {
        ctx.globalAlpha = 0.35;
        ctx.fillRect(x - 1, y, 3, 1);
        ctx.fillRect(x, y - 1, 1, 3);
        ctx.globalAlpha = 1;
      }
    }
  }

  function frame() {
    const palette = PALETTES[getTheme()];
    ctx.drawImage(backdrop, 0, 0);
    drawOrb(palette);
    if (palette.cloud) drawClouds(palette);
    drawGlints(palette);
    drawPads(palette);
    drawMotes(palette);
    tick++;
  }

  function resize() {
    width = canvas.width = Math.ceil(innerWidth / PIXEL);
    height = canvas.height = Math.ceil(innerHeight / PIXEL);
    horizon = Math.round(height * HORIZON);
    buildWorld();
    paintBackdrop(PALETTES[getTheme()]);
    frame();
  }

  resize();
  addEventListener('resize', resize);
  if (!still) setInterval(() => document.hidden || frame(), FRAME_MS);
  return { repaint: resize };
}
