// Paginas propias del worker (portada y 404) y el favicon, en el pixel art de hacksllm con el bichi.
import { BEETLE_FRAMES, BEETLE_PALETTES } from '../web/js/art/beetle.js';

const PANEL = 'https://llm.hacks.win/#/paginas';
const WORK = 'https://llm.hacks.win/#/work';

function sprite(rows, palette, attrs = '') {
  const rects = rows.flatMap((row, y) => [...row].map((key, x) => (key === '.' ? '' : `<rect x="${x}" y="${y}" width="1" height="1" fill="${palette[key]}"/>`)));
  return `<svg ${attrs} viewBox="0 0 ${rows[0].length} ${rows.length}" shape-rendering="crispEdges">${rects.join('')}</svg>`;
}

export const favicon = `<svg xmlns="http://www.w3.org/2000/svg"${sprite(BEETLE_FRAMES.idle, BEETLE_PALETTES.light).slice(4)}`;

const beetle = (scale) =>
  sprite(BEETLE_FRAMES.idle, BEETLE_PALETTES.light, `class="bichi" width="${16 * scale}" height="${14 * scale}" aria-hidden="true"`);

const STYLE = `
:root{--bg:#f3eefb;--surface:#fdfbff;--surface-2:#eaf2fd;--ink:#34395e;--soft:#7f86aa;--sky:#a9d4f7;--deep:#5f9be0;--mint:#c4ebd9;--butter:#fbe9ab;--blush:#f6c3d6;--shadow:#d6d8f0;--on:#262a4d;--px:3px;--dot:#e2dcf3}
@media (prefers-color-scheme:dark){:root{--bg:#12132b;--surface:#1c1e3c;--surface-2:#252a4f;--ink:#e6e9ff;--soft:#9aa1cc;--sky:#7fb8f0;--deep:#a6d2ff;--mint:#7fd1b0;--butter:#f3dd8f;--blush:#f39ac0;--shadow:#090a1d;--on:#12132b;--dot:#1f2246}}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:28px 16px;color:var(--ink);font-family:'Pixelify Sans',ui-monospace,monospace;
background:radial-gradient(var(--dot) 1.5px,transparent 1.6px) 0 0/24px 24px,var(--bg)}
.px{box-shadow:0 calc(var(--px)*-1) 0 var(--ink),0 var(--px) 0 var(--ink),calc(var(--px)*-1) 0 0 var(--ink),var(--px) 0 0 var(--ink),0 calc(var(--px)*3) 0 var(--shadow)}
main{width:min(100%,640px);display:grid;gap:22px}
.hero{background:var(--surface);padding:clamp(24px,5vw,40px);display:grid;gap:16px;justify-items:start;position:relative;overflow:hidden}
.hero::after{content:'';position:absolute;right:-30px;top:-30px;width:150px;height:150px;background:radial-gradient(var(--butter) 3px,transparent 3.5px) 0 0/18px 18px;opacity:.7}
h1{margin:0;font-size:clamp(34px,7vw,46px);line-height:1}h1 b{color:var(--deep)}
p{margin:0;color:var(--soft);line-height:1.55}
code{font-family:ui-monospace,Consolas,monospace;font-size:.86em;background:var(--bg);padding:1px 6px;color:var(--ink)}
.actions{display:flex;flex-wrap:wrap;gap:16px;margin-top:6px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 18px;color:var(--on);text-decoration:none;font-weight:600;background:var(--sky);transition:background-color .15s steps(3),transform .08s steps(2)}
.btn.alt{background:var(--surface);color:var(--ink)}
.btn:hover{background:var(--butter);color:var(--on)}
.btn:active{transform:translateY(calc(var(--px)*2))}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:22px}
.feature{background:var(--surface);padding:18px;display:grid;gap:6px}
.feature b{font-size:17px}
.feature span{font-size:14px;color:var(--soft);line-height:1.45}
.feature i{display:block;width:12px;height:12px;margin-bottom:4px;box-shadow:6px 6px 0 var(--blush)}
.feature:nth-child(1) i{background:var(--sky)}.feature:nth-child(2) i{background:var(--mint)}.feature:nth-child(3) i{background:var(--butter)}
.bichi{image-rendering:pixelated;animation:breathe 2.4s steps(2) infinite}
@keyframes breathe{50%{transform:translateY(4px)}}
footer{text-align:center;font-size:13px;color:var(--soft)}
footer a{color:var(--deep)}
`;

export const shell = (title, body) => `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<meta name="description" content="Webs estaticas hechas con bichi, en linea para siempre." />
<meta name="theme-color" content="#a9d4f7" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="Webs estaticas hechas con bichi, en linea para siempre." />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Pixelify+Sans:wght@400;600;700&display=swap" rel="stylesheet" />
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;

export const home = () =>
  shell(
    'bichi paginas',
    `<section class="hero px">
  ${beetle(6)}
  <h1>bichi <b>paginas</b></h1>
  <p>webs estaticas hechas con bichi o subidas por ti, en linea para siempre en <code>bichi.hacks.win/&lt;nombre&gt;</code>.</p>
  <div class="actions">
    <a class="btn px" href="${PANEL}">mis paginas</a>
    <a class="btn alt px" href="${WORK}">hacer una con bichi</a>
  </div>
</section>
<section class="features">
  <div class="feature px"><i></i><b>publica</b><span>pidesela a bichi en work o sube una carpeta con index.html.</span></div>
  <div class="feature px"><i></i><b>cambiala</b><span>edita archivos, cambia la direccion o descargala en zip cuando quieras.</span></div>
  <div class="feature px"><i></i><b>para siempre</b><span>no caduca y se sirve desde el borde de Cloudflare, rapida en todas partes.</span></div>
</section>
<footer>hecho con cariño en <a href="https://llm.hacks.win">hacksllm</a></footer>`,
  );

export const missing = (slug) =>
  shell(
    'no existe',
    `<section class="hero px">
  ${beetle(5)}
  <h1>esta pagina <b>no existe</b></h1>
  <p>${slug ? `nadie ha publicado <code>${slug}</code> todavia, o ya la quitaron.` : 'esa direccion no lleva a ninguna parte.'}</p>
  <div class="actions"><a class="btn px" href="/">ir al inicio</a><a class="btn alt px" href="${WORK}">hacer una con bichi</a></div>
</section>`,
  );
