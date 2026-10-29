export function respond(res, success, message = '', data = null, status = 200) {
  return res.status(status).json({ success, message, data });
}

export function fail(res, message, status = 500, data = null) {
  return respond(res, false, message, data, status);
}

export function methodNotAllowed(res, allowed) {
  res.set('Allow', allowed.join(', '));
  return fail(res, `Método no permitido. Use ${allowed.join(' o ')}.`, 405);
}

export function positiveInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function publicBaseUrl(req) {
  const protocol = req.get('x-forwarded-proto')?.split(',')[0] || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  if (host) return `${protocol}://${host}`;
  if (process.env.PUBLIC_BASE_URL) return new URL(process.env.PUBLIC_BASE_URL).origin;
  return `${protocol}://${host}`;
}

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function normalizeId(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}

export function logError(error) {
  console.error(error?.stack || error);
}