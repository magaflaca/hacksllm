import { drawSprite } from '../art/pixels.js';
import { BEETLE_FRAMES, BEETLE_PALETTES } from '../art/beetle.js';

const TICK_MS = 170;
const GAZE_DISTANCE = 80;
const MOOD_CLASS = { happy: 'is-hopping', sad: 'is-drooping', thinking: 'is-hovering' };

export function createMascot({ canvas, bubble, getTheme }) {
  const ctx = canvas.getContext('2d');
  let mood = 'idle';
  let gaze = 'idle';
  let tick = 0;
  let moodTimer;
  let bubbleTimer;

  const frameName = () => {
    if (mood === 'thinking') return tick % 2 ? 'flapA' : 'flapB';
    if (mood !== 'idle') return mood;
    if (tick % 23 === 0) return 'blink';
    if (tick % 47 > 44) return 'wiggle';
    return gaze;
  };

  const draw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawSprite(ctx, BEETLE_FRAMES[frameName()], BEETLE_PALETTES[getTheme()]);
  };

  setInterval(() => {
    tick++;
    draw();
  }, TICK_MS);
  draw();

  addEventListener('pointermove', ({ clientX }) => {
    const { left, width } = canvas.getBoundingClientRect();
    const offset = clientX - (left + width / 2);
    gaze = offset < -GAZE_DISTANCE ? 'left' : offset > GAZE_DISTANCE ? 'right' : 'idle';
  });

  const mascot = {
    redraw: draw,
    setMood(next, forMs) {
      clearTimeout(moodTimer);
      mood = next;
      canvas.classList.remove(...Object.values(MOOD_CLASS));
      void canvas.offsetWidth;
      if (MOOD_CLASS[next]) canvas.classList.add(MOOD_CLASS[next]);
      if (forMs) moodTimer = setTimeout(() => mascot.setMood('idle'), forMs);
      draw();
    },
    say(text, forMs = 4200) {
      clearTimeout(bubbleTimer);
      bubble.textContent = text;
      bubble.hidden = false;
      bubble.classList.remove('is-popping');
      void bubble.offsetWidth;
      bubble.classList.add('is-popping');
      bubbleTimer = setTimeout(() => (bubble.hidden = true), forMs);
    },
  };
  return mascot;
}
