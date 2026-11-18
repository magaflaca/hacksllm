// Web: leer una pagina como texto y buscar en DuckDuckGo.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (text) =>
  text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, name) => {
    if (name[0] === '#') return String.fromCodePoint(name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1)));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });

export function htmlToText(html) {
  return decode(
    html
      .replace(/<(script|style|noscript|svg|head|template)[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => `${label.replace(/<[^>]+>/g, '').trim()} (${href})`)
      .replace(/<h([1-6])[^>]*>/gi, (_, level) => `\n\n${'#'.repeat(Number(level))} `)
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<(br|\/p|\/div|\/h\d|\/tr|\/section|\/article|\/header|\/footer|\/ul|\/ol|\/pre|\/table)[^>]*>/gi, '\n')
      .replace(/<(td|th)[^>]*>/gi, ' | ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

const UA = 'Mozilla/5.0 (compatible; bichi-code)';

export const webFetch = {
  name: 'web_fetch',
  kind: 'net',
  description: 'Descarga una pagina web o archivo de texto por URL y devuelve su contenido como texto legible.',
  parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL completa (https://...)' } }, required: ['url'] },
  label: (input) => ({ title: 'Web', arg: input.url }),
  async run(input, ctx) {
    const url = new URL(String(input.url).replace(/^http:\/\//, 'https://'));
    const response = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,text/plain,application/json,*/*' }, signal: AbortSignal.any([AbortSignal.timeout(30000), ...(ctx.signal ? [ctx.signal] : [])]), redirect: 'follow' });
    const type = response.headers.get('content-type') ?? '';
    const raw = (await response.text()).slice(0, 3_000_000);
    const text = /html/.test(type) ? htmlToText(raw) : raw;
    const body = text.length > 60000 ? `${text.slice(0, 60000)}\n(… recortado, ${text.length} caracteres en total)` : text;
    return { content: `${response.status} ${response.url}\n\n${body}`, summary: `${response.status}, ${Math.round(text.length / 1000)}k caracteres` };
  },
};

export const webSearch = {
  name: 'web_search',
  kind: 'net',
  description: 'Busca en la web y devuelve los primeros resultados (titulo, enlace y resumen). Usa web_fetch para leer uno.',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  label: (input) => ({ title: 'Buscar en la web', arg: input.query }),
  async run(input, ctx) {
    const response = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ q: String(input.query) }),
      signal: AbortSignal.any([AbortSignal.timeout(20000), ...(ctx.signal ? [ctx.signal] : [])]),
    });
    const html = await response.text();
    const results = [];
    const blocks = html.split(/class="result\s/).slice(1);
    for (const block of blocks) {
      const link = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
      if (!link) continue;
      let href = decode(link[1]);
      const real = /uddg=([^&]+)/.exec(href);
      if (real) href = decodeURIComponent(real[1]);
      if (href.startsWith('//')) href = `https:${href}`;
      if (/duckduckgo\.com\/y\.js/.test(href)) continue;
      const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
      results.push({ title: htmlToText(link[2]), url: href, snippet: snippet ? htmlToText(snippet[1]) : '' });
      if (results.length >= 8) break;
    }
    return {
      content: results.length ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n') : 'sin resultados',
      summary: `${results.length} resultados`,
    };
  },
};
