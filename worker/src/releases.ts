// Release hosting: admin upload → R2, public download with range support.
// Bucket stays private; the worker is the only reader. 'latest' is the stable key.

import { json, safeEqual } from './util';
import type { Env } from './util';

// POST /v1/release/upload — CI-only release upload. GitHub Actions receives a
// narrowly scoped bearer secret rather than Cloudflare account credentials.
export async function handleCiRelease(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!env.RELEASE_UPLOAD_TOKEN) return json({ error: 'not_configured' }, 503);

  const auth = req.headers.get('authorization') ?? '';
  const prefix = 'Bearer ';
  const supplied = auth.startsWith(prefix) ? auth.slice(prefix.length) : '';
  if (!supplied || !(await safeEqual(supplied, env.RELEASE_UPLOAD_TOKEN))) {
    return json({ error: 'forbidden' }, 401);
  }
  return handleRelease(req, env);
}

// POST /v1/admin/release — multipart: form field "file", optional "key"
// (default "latest", e.g. "latest-macos" for other platforms), optional
// "version" (e.g. "v0.2.6", sanitized; defaults to a timestamp stamp).
// cookie-gated in admin.ts. Stores meta:<key> for the auto-updater.
export async function handleRelease(req: Request, env: Env): Promise<Response> {
  const cl = Number(req.headers.get('content-length') ?? '0');
  if (cl > 95 * 1024 * 1024) return json({ error: 'too_large' }, 413); // free-plan body cap ~100MB
  let fd: FormData;
  try {
    fd = await req.formData();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const file = fd.get('file');
  if (!(file instanceof File)) return json({ error: 'bad_request' }, 400);
  let key = String(fd.get('key') ?? 'latest');
  if (!/^[a-z0-9-]{1,32}$/.test(key)) key = 'latest';
  const rawVersion = String(fd.get('version') ?? '');
  const version = /^[A-Za-z0-9._-]{1,32}$/.test(rawVersion) ? rawVersion : stampNow();

  await env.RELEASES.put(key, file);
  await env.RELEASES.put(key === 'latest' ? 'aura-' + stampNow() + '.zip' : `aura-${stampNow()}-${key}.zip`, file);

  // sha256 computed here (once per upload) so the app can verify downloads.
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const sha256 = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.RELEASES.put(
    'meta:' + key,
    JSON.stringify({ version, sha256, size: file.size, uploaded: Date.now() })
  );

  // keep only the newest 5 versioned copies
  const listed = await env.RELEASES.list({ prefix: 'aura-' });
  const stale = listed.objects.sort((a, b) => b.uploaded - a.uploaded).slice(5);
  for (const o of stale) await env.RELEASES.delete(o.key);

  return json({ key, url: `https://api.copal.run/dl/${key}`, size: file.size, version, sha256 }, 200);
}

// GET /v1/release/meta?key=latest|latest-macos|source — version + sha256 for
// the app's auto-updater. Public (downloads are public too).
export async function serveReleaseMeta(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const key = url.searchParams.get('key') ?? 'latest';
  if (!/^[a-z0-9-]{1,32}$/.test(key)) return json({ error: 'not found' }, 404);
  const obj = await env.RELEASES.get('meta:' + key);
  if (!obj) return json({ error: 'not found' }, 404);
  try {
    return json(JSON.parse(await obj.text()), 200);
  } catch {
    return json({ error: 'not found' }, 404);
  }
}

// GET /dl/{key} — public
export async function serveDownload(req: Request, env: Env, key: string): Promise<Response> {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(key)) return json({ error: 'not found' }, 404);
  const range = parseRange(req.headers.get('range'));
  const obj = range ? await env.RELEASES.get(key, { range }) : await env.RELEASES.get(key);
  if (!obj) return json({ error: 'not found' }, 404);

  const headers: Record<string, string> = {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${dlName(key)}"`,
    etag: obj.etag,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=3600',
  };
  if (range && obj.range) {
    const end = obj.range.offset + obj.range.length - 1;
    return new Response(obj.body, {
      status: 206,
      headers: {
        ...headers,
        'content-length': String(obj.range.length),
        'content-range': `bytes ${obj.range.offset}-${end}/${obj.size}`,
      },
    });
  }
  return new Response(obj.body, {
    status: 200,
    headers: { ...headers, 'content-length': String(obj.size) },
  });
}

function dlName(key: string): string {
  if (key === 'latest') return 'aura-windows-amd64.zip';
  if (key === 'latest-macos') return 'aura-macos-arm64.zip';
  if (key === 'source') return 'aura-source.zip';
  return 'aura-release.zip';
}

// bytes=start-end | bytes=start-  (single range only; others ignored → full 200)
function parseRange(h: string | null): { offset: number; length: number } | { offset: number } | null {
  if (!h) return null;
  const m = h.match(/^bytes=(\d+)-(\d*)$/);
  if (!m) return null;
  const start = Number(m[1]);
  if (m[2] === '') return { offset: start };
  const end = Number(m[2]);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}

function stampNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
