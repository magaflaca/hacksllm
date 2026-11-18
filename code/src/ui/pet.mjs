// La mascota de la barra de abajo: muy de vez en cuando un bichito cruza caminando por la linea de la entrada, y si
// la consola se queda quieta un buen rato, el bichi se echa a dormir encima soltando zetas. Se van si los tocas.
import { BEETLE_PALETTES } from '../../../web/js/art/beetle.js';
import { pixels } from './art.mjs';
import { c, dim } from './term.mjs';

// Sprites de 10x4 pixeles (2 lineas de terminal) mirando a la derecha. o borde, b cuerpo, l brillo, w ojo, k pupila.
const WALK = [
  ['..a...a...', '.obbbbbbo.', 'obblbbbwko', '.o.o..o.o.'],
  ['...a...a..', '.obbbbbbo.', 'obblbbbwko', '..o.o..o.o'],
];
const SLEEP = [
  ['..........', '.obbbbbbo.', 'obblbbbkko', '.oooooooo.'],
  ['..........', '.obbbbbbo.', 'obblbbbbko', '.oooooooo.'],
];
const ZZZ = ['z', 'z z', 'z z Z', ' z Z', '  Z'];

const palette = BEETLE_PALETTES.light;
const paint = (rows) => pixels(rows, (key) => (key && key !== '.' ? palette[key] : null));
const WALK_LINES = WALK.map(paint);
const SLEEP_LINES = SLEEP.map(paint);

export const PET_WIDTH = 10;
const IDLE_SLEEP = 10 * 60 * 1000; // diez minutos sin tocar nada
const WALK_CHANCE = 0.03; // por cada medio minuto quieto: un paseo cada quince minutos, mas o menos

export class Pet {
  constructor(onChange) {
    this.onChange = onChange;
    this.state = null; // null | {kind: 'walk', x} | {kind: 'sleep', x}
    this.lastInput = Date.now();
    this.frame = 0;
    this.timer = setInterval(() => this.tick(), 140);
    this.timer.unref?.();
    this.roll = setInterval(() => {
      if (!this.state && !this.busy() && Math.random() < WALK_CHANCE) this.walk();
    }, 30_000);
    this.roll.unref?.();
    this.busy = () => false;
  }

  // Cualquier tecla despierta al que duerme (y cuenta como actividad).
  input() {
    this.lastInput = Date.now();
    if (this.state?.kind === 'sleep') this.leave();
  }

  walk() {
    this.state = { kind: 'walk', x: 0, speed: 1 };
    this.onChange();
  }

  sleep() {
    this.state = { kind: 'sleep', x: 4 };
    this.onChange();
  }

  // Tocado: el que camina sale corriendo; el que duerme se despierta y se va.
  leave() {
    if (!this.state) return;
    if (this.state.kind === 'walk') this.state.speed = 4;
    else this.state = null;
    this.lastInput = Date.now();
    this.onChange();
  }

  tick() {
    this.frame++;
    const limit = this.limit ?? 80;
    if (!this.state && !this.busy() && Date.now() - this.lastInput > IDLE_SLEEP) return this.sleep();
    if (!this.state) return;
    if (this.state.kind === 'walk') {
      this.state.x += this.state.speed;
      if (this.state.x > limit) this.state = null;
      this.onChange();
    } else if (this.frame % 5 === 0) this.onChange();
  }

  // Columna de inicio y las dos lineas del sprite, o null. `limit`: hasta donde puede llegar sin tapar nada.
  sprite(limit) {
    this.limit = limit;
    if (!this.state) return null;
    const { kind, x } = this.state;
    if (kind === 'walk') {
      const lines = WALK_LINES[Math.floor(this.frame / 2) % 2];
      return { x, lines, extra: '' };
    }
    const lines = SLEEP_LINES[Math.floor(this.frame / 10) % 2];
    return { x, lines, extra: c.plum(dim(ZZZ[Math.floor(this.frame / 5) % ZZZ.length])) };
  }

  hit(col) {
    const x = this.state?.x;
    return x !== undefined && col >= x && col < x + PET_WIDTH + 6;
  }
}
