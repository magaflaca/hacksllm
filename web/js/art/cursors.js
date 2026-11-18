// Cursores de 10 a 11 pixeles de ancho que se dibujan a escala 2.

export const CURSOR_PALETTE = { o: '#2f3b6b', w: '#f4faff', b: '#a9d4f7', y: '#ffd98a' };

const ARROW = [
  'o.........',
  'oo........',
  'owo.......',
  'owbo......',
  'owbbo.....',
  'owbbbo....',
  'owbbbbo...',
  'owbbbbbo..',
  'owbbbbbbo.',
  'owbbbooooo',
  'owoobo....',
  'oo..obo...',
  '.....obo..',
  '......o...',
];

export const CURSORS = {
  arrow: { hotspot: [0, 0], rows: ARROW },
  pointer: { hotspot: [0, 0], rows: ARROW.map((row) => row.replaceAll('b', 'y')) },
  text: {
    hotspot: [3, 7],
    rows: [
      'ooo.ooo',
      'owooowo',
      '.oowoo.',
      '..owo..',
      '..owo..',
      '..owo..',
      '..owo..',
      '..owo..',
      '..owo..',
      '..owo..',
      '..owo..',
      '.oowoo.',
      'owooowo',
      'ooo.ooo',
    ],
  },
};
