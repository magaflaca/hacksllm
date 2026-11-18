import { store } from './store.js';

const NOTE = { G4: 392, A4: 440, C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880, B5: 987.77, C6: 1046.5, D6: 1174.66, E6: 1318.5 };
const STEP = 0.07;

// Cada sonido es una frase de [nota, pasos]; timbre de marimba suave.
const TUNES = {
  tap: [['D6', 0.8]],
  select: [['A5', 1], ['D6', 1]],
  on: [['G5', 1], ['C6', 1.5]],
  off: [['G5', 1], ['C5', 1.5]],
  send: [['C5', 1], ['E5', 1], ['A5', 1.6]],
  reply: [['E6', 0.7], ['B5', 1.2]],
  done: [['G5', 1], ['B5', 1], ['D6', 1], ['G5', 0.5], ['D6', 2.6]],
  copy: [['B5', 0.8], ['E6', 1.4]],
  remove: [['E5', 1], ['C5', 1], ['G4', 1.8]],
  error: [['A4', 1.5], ['G4', 3]],
  chirp: [['E6', 0.5], ['C6', 0.5], ['E6', 0.5], ['G5', 1.2]],
};

let context = null;
let muted = store.get('muted', false);

function tone(frequency, at, duration) {
  const body = context.createOscillator();
  const shimmer = context.createOscillator();
  const gain = context.createGain();
  body.type = 'sine';
  shimmer.type = 'triangle';
  body.frequency.value = frequency;
  shimmer.frequency.value = frequency * 2;
  const sparkle = context.createGain();
  sparkle.gain.value = 0.18;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.13, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0006, at + duration);
  body.connect(gain);
  shimmer.connect(sparkle).connect(gain);
  gain.connect(context.destination);
  for (const oscillator of [body, shimmer]) {
    oscillator.start(at);
    oscillator.stop(at + duration + 0.02);
  }
}

export const sound = {
  get muted() {
    return muted;
  },
  toggle() {
    muted = !muted;
    store.set('muted', muted);
    if (!muted) this.play('on');
    return muted;
  },
  play(name) {
    if (muted || !navigator.userActivation?.hasBeenActive) return;
    try {
      context ??= new AudioContext();
      if (context.state === 'suspended') context.resume();
      let at = context.currentTime + 0.01;
      for (const [note, steps] of TUNES[name]) {
        tone(NOTE[note], at, steps * STEP * 2.6);
        at += steps * STEP;
      }
    } catch {}
  },
};
