// Escarabajo azul de 16x14. Cada caracter es una clave de paleta; el punto es transparente.

export const BEETLE_PALETTES = {
  light: {
    o: '#2f3b6b',
    b: '#8cc4f2',
    l: '#d6edff',
    d: '#5f9be0',
    w: '#ffffff',
    k: '#232848',
    c: '#f6b2cc',
    a: '#ffd36e',
    v: '#bfe0fb',
  },
  dark: {
    o: '#12142e',
    b: '#7fb8f0',
    l: '#c9e6ff',
    d: '#4f86cf',
    w: '#ffffff',
    k: '#151833',
    c: '#f39ac0',
    a: '#fff3a0',
    v: '#b9d9f7',
  },
};

const BASE = [
  '...a........a...',
  '....o......o....',
  '.....o....o.....',
  '....oooooooo....',
  '..oollllbbbboo..',
  '.olllbbbbbbbbdo.',
  '.olbbbbbbbbbbdo.',
  'olbbwkbbbbwkbbdo',
  'obbbkkbbbbkkbbdo',
  'obccbbobbobbccdo',
  '.obbbbboobbbbdo.',
  '..oddbbbbbbddo..',
  '...oooooooooo...',
  '...o.o....o.o...',
];

const patch = (rows, ...changes) => rows.map((row, index) => changes.find((change) => change[index])?.[index] ?? row);

const EYES = {
  left: { 7: 'olbwkbbbbwkbbbdo', 8: 'obbkkbbbbkkbbbdo' },
  right: { 7: 'olbbbwkbbbbwkbdo', 8: 'obbbbkkbbbbkkbdo' },
  up: { 7: 'olbbkkbbbbkkbbdo', 8: 'obbbwkbbbbwkbbdo' },
  closed: { 7: 'olbbbbbbbbbbbbdo', 8: 'obbbkkbbbbkkbbdo' },
  happy: { 7: 'olbbbkbbbbkbbbdo', 8: 'obbbkbkbbkbkbbdo' },
};
const MOUTH = {
  open: { 9: 'obccbboooobbccdo', 10: '.obbbbboobbbbdo.' },
  sad: { 9: 'obccbbboobbbccdo', 10: '.obbbbobbobbbdo.' },
};
const ANTENNA_UP = { 0: '..a..........a..', 1: '...o........o...', 2: '....o......o....' };
const WINGS_UP = { 3: 'vv..oooooooo..vv', 4: 'vvoollllbbbboovv' };
const WINGS_DOWN = { 5: 'volllbbbbbbbbdov', 6: 'volbbbbbbbbbbdov' };
const STEP = { 13: '..o..o....o..o..' };

export const BEETLE_FRAMES = {
  idle: BASE,
  blink: patch(BASE, EYES.closed),
  left: patch(BASE, EYES.left),
  right: patch(BASE, EYES.right),
  wiggle: patch(BASE, ANTENNA_UP),
  flapA: patch(BASE, EYES.up, WINGS_UP, ANTENNA_UP),
  flapB: patch(BASE, EYES.up, WINGS_DOWN),
  walkA: patch(BASE, EYES.right),
  walkB: patch(BASE, EYES.right, STEP, ANTENNA_UP),
  happy: patch(BASE, EYES.happy, MOUTH.open, ANTENNA_UP, WINGS_UP),
  sad: patch(BASE, EYES.closed, MOUTH.sad),
};
