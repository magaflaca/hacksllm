// Reintentos con espera creciente (como Claude Code cuando falla la api): 1s, 2s, 4s, 8s... hasta 30s, con algo de
// azar para que varios clientes no reintenten a la vez.
export const RETRIES = 6;

export const backoff = (attempt) => Math.min(30_000, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.4);

// Espera ms, o menos si se interrumpe.
export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('interrumpido'), { name: 'AbortError' }));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(Object.assign(new Error('interrumpido'), { name: 'AbortError' }))), { once: true });
  });

// Fallos que vale la pena reintentar: red caida, servidor ocupado o con problemas.
export const transient = (status) => !status || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
