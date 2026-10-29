function errorJson(res, message, status, error) {
  return res.status(status).json({ detail: message, ...(error ? { error } : {}) });
}

async function proxyCall(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.set('Allow', 'GET, POST, OPTIONS');
    return errorJson(res, 'Método no permitido.', 405);
  }
  const payload = req.method === 'GET'
    ? { numero: Number(req.query.numero), patente: String(req.query.patente || '') }
    : req.body;
  if (!payload?.numero || !payload?.patente) {
    return errorJson(res, 'Se requiere numero y patente.', 400);
  }
  try {
    const target = process.env.LLAMADOR_SERVICE_URL || 'http://127.0.0.1:8000/llamar';
    const response = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90_000),
    });
    const contentType = response.headers.get('content-type') || 'application/json; charset=utf-8';
    res.status(response.status).type(contentType).send(await response.text());
  } catch (error) {
    return errorJson(res, 'No se pudo conectar con el servicio de audio.', 502, error.message);
  }
}

export function registerCallBridgeRoutes(app) {
  app.all('/api/llamar', (req, res, next) => proxyCall(req, res).catch(next));
}