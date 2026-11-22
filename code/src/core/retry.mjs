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

// Hasta cuando hay que esperar, en la hora local: "a las 21:30 (en 2 h 5 min)".
export function untilLabel(when) {
  const left = Math.max(0, when - Date.now());
  const minutes = Math.ceil(left / 60_000);
  const span = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  const day = new Date(when).toDateString() === new Date().toDateString() ? '' : ` del ${new Date(when).toLocaleDateString('es', { day: 'numeric', month: 'short' })}`;
  return `a las ${new Date(when).toLocaleTimeString('es', { hour: 'numeric', minute: '2-digit' })}${day} (en ${span})`;
}
