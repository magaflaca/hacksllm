// Marco pixel de las paginas propias del worker (portada y 404), con el bichi de la web.
import { BEETLE_FRAMES, BEETLE_PALETTES } from '../web/js/art/beetle.js';

function beetle(scale = 6) {
  const rows = BEETLE_FRAMES.idle;
  const rects = rows.flatMap((row, y) =>
    [...row].map((key, x) => (key === '.' ? '' : `<rect x="${x}" y="${y}" width="1" height="1" fill="${BEETLE_PALETTES.light[key]}"/>`)),
  );
  return `<svg class="bichi" viewBox="0 0 ${rows[0].length} ${rows.length}" width="${rows[0].length * scale}" height="${rows.length * scale}" shape-rendering="crispEdges" aria-hidden="true">${rects.join('')}</svg>`;
}

export const shell = (title, body) => `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<meta name="theme-color" content="#a9d4f7" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Pixelify+Sans:wght@400;600;700&display=swap" rel="stylesheet" />
<style>
:root{--bg:#f3eefb;--surface:#fdfbff;--ink:#34395e;--soft:#7f86aa;--sky:#a9d4f7;--deep:#5f9be0;--shadow:#d6d8f0;--px:3px}
@media (prefers-color-scheme:dark){:root{--bg:#12132b;--surface:#1c1e3c;--ink:#e6e9ff;--soft:#9aa1cc;--sky:#7fb8f0;--deep:#a6d2ff;--shadow:#090a1d}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--ink);font-family:'Pixelify Sans',ui-monospace,monospace}
main{width:min(100%,520px);background:var(--surface);padding:32px 28px;display:grid;gap:14px;justify-items:start;
box-shadow:0 calc(var(--px)*-1) 0 var(--ink),0 var(--px) 0 var(--ink),calc(var(--px)*-1) 0 0 var(--ink),var(--px) 0 0 var(--ink),0 calc(var(--px)*3) 0 var(--shadow)}
h1{margin:0;font-size:32px;line-height:1.1}h1 b{color:var(--deep)}
p{margin:0;color:var(--soft);line-height:1.5}
code{background:var(--bg);padding:1px 6px;color:var(--ink)}
.btn{display:inline-block;margin-top:6px;padding:9px 16px;background:var(--sky);color:#262a4d;text-decoration:none;font-weight:600;
box-shadow:0 calc(var(--px)*-1) 0 var(--ink),0 var(--px) 0 var(--ink),calc(var(--px)*-1) 0 0 var(--ink),var(--px) 0 0 var(--ink)}
.btn:hover{background:#fbe9ab}
.bichi{animation:breathe 2.4s steps(2) infinite}
@keyframes breathe{50%{transform:translateY(3px)}}
</style>
</head>
<body><main>${beetle()}${body}</main></body>
</html>`;
