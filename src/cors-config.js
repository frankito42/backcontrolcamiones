import './config.js';

export function parseCorsOrigins(value = process.env.CORS_ORIGIN) {
  const configured = value?.trim();
  if (!configured || configured === '*') return null;

  const origins = configured.split(',').map((entry) => {
    const candidate = entry.trim();
    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error(`Origen CORS inválido: ${entry.trim()}`);
    }

    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) {
      throw new Error(
        `CORS_ORIGIN debe contener solo orígenes (protocolo y dominio), sin rutas: ${entry.trim()}`,
      );
    }
    return parsed.origin;
  });

  return new Set(origins);
}

export function createCorsOriginCallback(value = process.env.CORS_ORIGIN) {
  const allowedOrigins = parseCorsOrigins(value);
  return (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins === null) return callback(null, '*');
    return callback(null, allowedOrigins.has(origin) ? origin : false);
  };
}

export const corsOriginCallback = createCorsOriginCallback();
