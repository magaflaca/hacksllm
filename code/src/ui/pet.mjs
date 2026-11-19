// La mascota de la barra de abajo: muy de vez en cuando un bichi chiquito cruza caminando sobre la linea de la entrada,
// y si la consola se queda quieta un buen rato, se echa a dormir encima soltando zetas. Se van si los tocas.
// Mientras hay mascota, la barra crece una linea para no tapar la conversacion.
import { BEETLE_PALETTES } from '../../../web/js/art/beetle.js';
import { pixels } from './art.mjs';
import { c, dim } from './term.mjs';

// El bichi de la web en chiquito (12x10 pixeles = 5 lineas): antenas con punta amarilla, cabeza redonda con brillo,
// ojos con su reflejo, mejillas, boquita y patitas que se mueven al caminar.
// a antena, o borde, b cuerpo, l brillo, d sombra, w reflejo, k ojo, c mejilla.
const HEAD = ['..oooooooo..', '.olllbbbbdo.'];
const EYES_OPEN = ['olwkbbbbwkdo', 'olkkbbbbkkdo'];
const EYES_SHUT = ['olbbbbbbbbdo', 'olkkbbbbkkdo'];
const SMILE = 'ocbbboobbcdo';
const CALM = 'ocbbbbbbbcdo';
const BOTTOM = ['.oddbbbbddo.', '..oooooooo..'];
const ANTENNA = [
  ['.a........a.', '..o......o..'],
  ['..a......a..', '..o......o..'],
];
const FEET = ['..o.o..o.o..', '...o.oo.o...'];
const bichi = ({ antenna = 0, eyes = EYES_OPEN, mouth = SMILE, feet = FEET[0] }) => [...ANTENNA[antenna], ...HEAD, ...eyes, mouth, ...BOTTOM, feet];
const WALK = [bichi({ antenna: 0, feet: FEET[0] }), bichi({ antenna: 1, feet: FEET[1] }), bichi({ antenna: 0, feet: FEET[0], eyes: EYES_SHUT })];
// Dormido: ojos cerrados, antenas caidas y respirando (la boca se abre y se cierra).
const DROOP = ['............', '.ao......oa.'];
const SLEEP = [
  [...DROOP, ...HEAD, ...EYES_SHUT, CALM, ...BOTTOM, '............'],
  [...DROOP, ...HEAD, ...EYES_SHUT, SMILE, ...BOTTOM, '............'],
];
const ZZZ = ['z', 'z z', 'z z Z', '  z Z', '    Z'];

const palette = BEETLE_PALETTES.light;
const paint = (rows) => pixels(rows, (key) => (key && key !== '.' ? palette[key] : null));
const WALK_LINES = WALK.map(paint);
const SLEEP_LINES = SLEEP.map(paint);

export const PET_WIDTH = 12;
export const PET_ROWS = 5;
const IDLE_SLEEP = 2 * 60 * 1000; // dos minutos sin tocar nada
const WALK_CHANCE = 0.03; // por cada medio minuto quieto: un paseo cada quince minutos, mas o menos

export class Pet {
  constructor(onChange) {
    this.onChange = onChange;
    this.state = null; // null | {kind: 'walk', x, speed} | {kind: 'sleep', x}
    this.lastInput = Date.now();
    this.frame = 0;
    this.busy = () => false;
    this.timer = setInterval(() => this.tick(), 140);
    this.timer.unref?.();
    this.roll = setInterval(() => {
      if (!this.state && !this.busy() && Math.random() < WALK_CHANCE) this.walk();
    }, 30_000);
    this.roll.unref?.();
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
    if (!this.state && !this.busy() && Date.now() - this.lastInput > IDLE_SLEEP) return this.sleep();
    if (!this.state) return;
    if (this.state.kind === 'walk') {
      this.state.x += this.state.speed;
      if (this.state.x > (this.limit ?? 80)) this.state = null;
      this.onChange();
    } else if (this.frame % 5 === 0) this.onChange();
  }

  // {x, lines (PET_ROWS), extra} o null. `limit`: hasta donde puede llegar sin pisar el texto de la derecha.
  sprite(limit) {
    this.limit = limit;
    if (!this.state || limit < 4) return null;
    const { kind } = this.state;
    const x = Math.max(0, Math.min(this.state.x, limit));
    // Camina con dos pasos y parpadea de vez en cuando.
    if (kind === 'walk') return { x, lines: WALK_LINES[this.frame % 23 === 0 ? 2 : Math.floor(this.frame / 2) % 2], extra: '' };
    return { x, lines: SLEEP_LINES[Math.floor(this.frame / 10) % 2], extra: c.plum(dim(ZZZ[Math.floor(this.frame / 5) % ZZZ.length])) };
  }

  hit(col) {
    const x = this.state?.x;
    return x !== undefined && col >= x - 1 && col < x + PET_WIDTH + 6;
  }
}
