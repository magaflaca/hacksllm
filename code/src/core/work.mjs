// Cliente de la parte "work" de hacksllm (conversaciones de /tp y bichi paginas), con la api key de hacksllm.
import { SITE } from '../config.mjs';
import { providerOf } from '../providers.mjs';

export const hacksKey = (config) => providerOf(config, 'hacksllm')?.key ?? null;

// route: 'tp', 'pages/mi-web/files'... raw: devuelve los bytes en vez de JSON.
export function workApi(config) {
  const key = hacksKey(config);
  if (!key) throw new Error('hace falta tu api key de hacksllm (/key)');
  return async (route, { method = 'GET', body, raw = false, type, timeout = 60000, signal } = {}) => {
    const response = await fetch(`${SITE}/work/${route}`, {
      method,
      body,
      headers: { authorization: `Bearer ${key}`, ...(type && { 'content-type': type }) },
      signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try {
        const error = JSON.parse(text).error;
        message = error?.message ?? error ?? text;
      } catch {
        /* no era json */
      }
      throw new Error(`${response.status} ${String(message).slice(0, 200)}`);
    }
    return raw ? Buffer.from(await response.arrayBuffer()) : response.json();
  };
}
