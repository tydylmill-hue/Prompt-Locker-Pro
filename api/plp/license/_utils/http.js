// api/plp/license/_utils/http.js
export function json(res, status, payload) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

export function badMethod(res) {
  return json(res, 405, { valid: false, status: 'error', error: 'method_not_allowed' });
}

export function requireJson(req) {
  if (req.method !== 'POST') return null;
  // Vercel/Next parses JSON body automatically in API routes unless disabled.
  return req.body || {};
}

export function safeString(v) {
  return (typeof v === 'string') ? v.trim() : '';
}
