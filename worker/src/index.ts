// copal-api — central config API for the Aura VPN.
// GET /healthz            → public liveness
// GET /v1/config          → server list + credentials (requires X-Copal-Secret header)

export interface Env {
  SERVERS: KVNamespace;
  API_SECRET: string;
}

const HDRS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: HDRS });
    if (url.pathname === '/healthz') return new Response('ok');
    if (url.pathname !== '/v1/config') return json({ error: 'not found' }, 404);

    if (!env.API_SECRET) return json({ error: 'not configured' }, 500);
    const supplied = req.headers.get('x-copal-secret') ?? '';
    if (!supplied) return json({ error: 'forbidden' }, 403);
    if (!(await safeEqual(supplied, env.API_SECRET))) return json({ error: 'forbidden' }, 403);

    const raw = await env.SERVERS.get('v1');
    if (!raw) return json({ error: 'not initialized' }, 500);
    return new Response(raw, { headers: HDRS });
  },
};

function json(o: unknown, s: number) {
  return new Response(JSON.stringify(o), { status: s, headers: HDRS });
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const da = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(a)));
  const db = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}
