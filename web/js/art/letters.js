// Letras pixel de 4x5 (la I de 3) para el logo de bichi code; las usan la terminal y la web.

const GLYPHS = {
  B: ['###.', '#..#', '###.', '#..#', '###.'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  C: ['.###', '#...', '#...', '#...', '.###'],
  H: ['#..#', '#..#', '####', '#..#', '#..#'],
  O: ['.##.', '#..#', '#..#', '#..#', '.##.'],
  D: ['###.', '#..#', '#..#', '#..#', '###.'],
  E: ['####', '#...', '###.', '#...', '####'],
  ' ': ['..', '..', '..', '..', '..'],
};

// Filas del logo: '0'..'4' es la fila de la letra (para degradar el color), 's' la sombra y '.' vacio.
export function logoRows(text) {
  const shape = ['', '', '', '', ''];
  [...text].forEach((letter, index) => {
    for (let y = 0; y < 5; y++) shape[y] += (index ? '.' : '') + GLYPHS[letter][y];
  });
  const wide = shape[0].length + 1;
  return Array.from({ length: 6 }, (_, y) =>
    Array.from({ length: wide }, (_, x) => (shape[y]?.[x] === '#' ? String(y) : shape[y - 1]?.[x - 1] === '#' ? 's' : '.')).join(''),
  );
}

// Colores por fila: del celeste claro arriba al azul profundo abajo.
export const LOGO_PALETTE = { 0: '#bfe0fb', 1: '#8cc4f2', 2: '#8cc4f2', 3: '#5f9be0', 4: '#5f9be0', s: '#232a52' };
