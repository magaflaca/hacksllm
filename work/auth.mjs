// Claves de la API: el dueno de una clave es un hash corto (nunca se guarda la clave) y una clave es valida si la
// pasarela la acepta. Lo comparten bichi work y bichi agy.
import { createHash } from 'node:crypto';

export const ownerOf = (key) => createHash('sha256').update(key).digest('hex').slice(0, 24);

// Devuelve authorize(req) -> owner | null. Una clave buena se recuerda 10 minutos para no preguntar cada vez.
export function authorizer(gateway) {
  const valid = new Map();
  return async (req) => {
    const key = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!key) return null;
    const owner = ownerOf(key);
    if ((valid.get(owner) ?? 0) > Date.now()) return owner;
    const response = await fetch(`${gateway}/v1/models`, { headers: { authorization: `Bearer ${key}` } }).catch(() => null);
    if (!response?.ok) return null;
    valid.set(owner, Date.now() + 10 * 60_000);
    return owner;
  };
}
