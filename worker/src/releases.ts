// Release hosting: admin/CI upload → R2, Discord-gated download with range support.
// Bucket stays private; the worker is the only reader. 'latest' is the stable key.

import { json, safeEqual } from './util';

// POST /v1/admin/release — multipart: form field "file", optional "key"
// (default "latest", e.g. "latest-macos" for other platforms), optional
// "version" (e.g. "v0.2.4", sanitized; defaults to a timestamp stamp).
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
  const stale = listed.objects
    .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
    .slice(5);
  for (const o of stale) await env.RELEASES.delete(o.key);

  return json({ key, url: `https://api.copal.run/dl/${key}`, size: file.size, version, sha256 }, 200);
}

export async function handleCiRelease(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get('authorization') ?? '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!supplied || !(await safeEqual(supplied, env.RELEASE_UPLOAD_TOKEN))) {
    return json({ error: 'forbidden' }, 401);
  }
  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (contentLength > 95 * 1024 * 1024) return json({ error: 'too_large' }, 413);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  const file = form.get('file');
  const version = String(form.get('version') ?? '');
  const artifact = String(form.get('artifact') ?? '');
  const suppliedSha256 = String(form.get('sha256') ?? '').toLowerCase();
  if (
    !(file instanceof File) ||
    file.size > 95 * 1024 * 1024 ||
    !/^v\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/.test(version) ||
    !isArchiveArtifact(artifact)
  ) {
    return json({ error: 'bad_request' }, 400);
  }

  const archiveKey = `archive/${version}/${artifact}.zip`;
  let sha256: string;
  if (/^[a-f0-9]{64}$/.test(suppliedSha256)) {
    await env.RELEASES.put(archiveKey, file.stream(), {
      httpMetadata: {
        contentType: 'application/zip',
        contentDisposition: `attachment; filename="${artifactFileName(artifact, version)}"`,
      },
    });
    sha256 = suppliedSha256;
  } else {
    const digestStream = new crypto.DigestStream('SHA-256');
    const [r2Body, digestBody] = file.stream().tee();
    const [, digest] = await Promise.all([
      env.RELEASES.put(archiveKey, r2Body, {
        httpMetadata: {
          contentType: 'application/zip',
          contentDisposition: `attachment; filename="${artifactFileName(artifact, version)}"`,
        },
      }),
      digestBody.pipeTo(digestStream).then(() => digestStream.digest),
    ]);
    sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const uploaded = Date.now();
  const artifactMeta: ArchiveArtifactMeta = {
    key: archiveKey,
    size: file.size,
    sha256,
    uploaded,
  };
  const manifest = await readArchiveManifest(env.RELEASES, version);
  manifest.artifacts[artifact] = artifactMeta;
  manifest.uploaded = Math.max(manifest.uploaded, uploaded);
  await env.RELEASES.put(`archive/${version}/manifest.json`, JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json' },
  });
  await updateArchiveIndex(env.RELEASES, manifest);

  const canonical = canonicalKey(artifact);
  await env.RELEASES.put(
    `meta:${canonical}`,
    JSON.stringify({ version, sha256, size: file.size, uploaded, target: archiveKey, artifact })
  );
  return json({ version, artifact, key: archiveKey, size: file.size, sha256 }, 200);
}

export async function handleCiReleaseAnnouncement(req: Request, env: Env): Promise<Response> {
  const auth = req.headers.get('authorization') ?? '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!supplied || !(await safeEqual(supplied, env.RELEASE_UPLOAD_TOKEN))) {
    return json({ error: 'forbidden' }, 401);
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  if (!body || typeof body !== 'object') return json({ error: 'bad_request' }, 400);
  const version = 'version' in body && typeof body.version === 'string' ? body.version : '';
  const changelog = 'changelog' in body && typeof body.changelog === 'string' ? body.changelog.trim() : '';
  if (!VERSION_RE.test(version) || !isReleaseChangelog(changelog)) {
    return json({ error: 'bad_request' }, 400);
  }

  const manifest = await readArchiveManifest(env.RELEASES, version);
  if (!manifest.artifacts.windows || !manifest.artifacts.macos || !manifest.artifacts.source) {
    return json({ error: 'release_incomplete' }, 409);
  }
  const markerKey = `archive/${version}/announcement.json`;
  if (await env.RELEASES.head(markerKey)) {
    return json({ announced: false, already_announced: true }, 200);
  }
  if (!env.DISCORD_RELEASE_CHANNEL_ID || !env.DISCORD_BOT_TOKEN) {
    return json({ error: 'not_configured' }, 503);
  }

  const response = await fetch(
    `https://discord.com/api/v10/channels/${env.DISCORD_RELEASE_CHANNEL_ID}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: changelog, allowed_mentions: { roles: [env.DISCORD_REQUIRED_ROLE_ID] } }),
    }
  );
  if (!response.ok) {
    console.error(JSON.stringify({ message: 'Aura release announcement failed', version, status: response.status }));
    return json({ error: 'discord_unavailable' }, 502);
  }
  const discordBody: unknown = await response.json();
  const messageId = discordBody && typeof discordBody === 'object' && 'id' in discordBody &&
      typeof discordBody.id === 'string' ? discordBody.id : '';
  if (!messageId) return json({ error: 'discord_unavailable' }, 502);
  await env.RELEASES.put(markerKey, JSON.stringify({ message_id: messageId, announced_at: Date.now() }), {
    httpMetadata: { contentType: 'application/json' },
  });
  return json({ announced: true, message_id: messageId }, 200);
}

function isReleaseChangelog(value: string): boolean {
  return value.length > 0 &&
    value.length <= 2000 &&
    /^# v\d+\.\d+/m.test(value) &&
    value.includes('```diff') &&
    value.includes('[Windows Download](https://api.copal.run/dl/latest)') &&
    value.includes('[macOS Download](https://api.copal.run/dl/latest-macos)') &&
    value.includes('[Source Download](https://api.copal.run/dl/source)') &&
    value.endsWith('<@&1544233739322789948>');
}

type ArchiveArtifact = 'windows' | 'macos' | 'source';

interface ArchiveArtifactMeta {
  key: string;
  size: number;
  sha256: string;
  uploaded: number;
}

export interface ArchiveManifest {
  version: string;
  uploaded: number;
  artifacts: Partial<Record<ArchiveArtifact, ArchiveArtifactMeta>>;
}

interface ArchiveIndex {
  versions: Array<{ version: string; uploaded: number }>;
}

function isArchiveArtifact(value: string): value is ArchiveArtifact {
  return value === 'windows' || value === 'macos' || value === 'source';
}

function canonicalKey(artifact: ArchiveArtifact): string {
  if (artifact === 'windows') return 'latest';
  if (artifact === 'macos') return 'latest-macos';
  return 'source';
}

function artifactFileName(artifact: ArchiveArtifact, version: string): string {
  if (artifact === 'windows') return `aura-${version}-windows-amd64.zip`;
  if (artifact === 'macos') return `aura-${version}-macos-arm64.zip`;
  return `aura-${version}-source.zip`;
}

async function readArchiveManifest(bucket: R2Bucket, version: string): Promise<ArchiveManifest> {
  const object = await bucket.get(`archive/${version}/manifest.json`);
  if (object) {
    try {
      const body: unknown = await object.json();
      if (
        body &&
        typeof body === 'object' &&
        'version' in body &&
        body.version === version &&
        'uploaded' in body &&
        typeof body.uploaded === 'number' &&
        'artifacts' in body &&
        body.artifacts &&
        typeof body.artifacts === 'object'
      ) {
        const artifacts: Partial<Record<ArchiveArtifact, ArchiveArtifactMeta>> = {};
        const rawArtifacts = body.artifacts as Record<string, unknown>;
        for (const name of ['windows', 'macos', 'source'] as const) {
          if (name in rawArtifacts) {
            const value = rawArtifacts[name];
            if (isArchiveArtifactMeta(value)) artifacts[name] = value;
          }
        }
        return { version, uploaded: body.uploaded, artifacts };
      }
    } catch {
      // Replace a malformed manifest with a valid one below.
    }
  }
  return { version, uploaded: 0, artifacts: {} };
}

function isArchiveArtifactMeta(value: unknown): value is ArchiveArtifactMeta {
  return !!(
    value &&
    typeof value === 'object' &&
    'key' in value &&
    typeof value.key === 'string' &&
    'size' in value &&
    typeof value.size === 'number' &&
    'sha256' in value &&
    typeof value.sha256 === 'string' &&
    'uploaded' in value &&
    typeof value.uploaded === 'number'
  );
}

async function updateArchiveIndex(bucket: R2Bucket, manifest: ArchiveManifest): Promise<void> {
  const object = await bucket.get('archive/index.json');
  let versions: ArchiveIndex['versions'] = [];
  if (object) {
    try {
      const body: unknown = await object.json();
      if (body && typeof body === 'object' && 'versions' in body && Array.isArray(body.versions)) {
        versions = body.versions.filter(
          (item): item is { version: string; uploaded: number } =>
            !!item &&
            typeof item === 'object' &&
            'version' in item &&
            typeof item.version === 'string' &&
            'uploaded' in item &&
            typeof item.uploaded === 'number'
        );
      }
    } catch {
      // Replace a malformed index below.
    }
  }
  const withoutCurrent = versions.filter((entry) => entry.version !== manifest.version);
  withoutCurrent.push({ version: manifest.version, uploaded: manifest.uploaded });
  withoutCurrent.sort((a, b) => b.uploaded - a.uploaded);
  await bucket.put('archive/index.json', JSON.stringify({ versions: withoutCurrent.slice(0, 50) }), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export async function serveDownloadPage(env: Env, canDownloadSource: boolean): Promise<Response> {
  const indexObject = await env.RELEASES.get('archive/index.json');
  let versions: ArchiveIndex['versions'] = [];
  if (indexObject) {
    try {
      const body: unknown = await indexObject.json();
      if (body && typeof body === 'object' && 'versions' in body && Array.isArray(body.versions)) {
        versions = body.versions.filter(
          (entry): entry is { version: string; uploaded: number } =>
            !!entry &&
            typeof entry === 'object' &&
            'version' in entry &&
            typeof entry.version === 'string' &&
            VERSION_RE.test(entry.version) &&
            'uploaded' in entry &&
            typeof entry.uploaded === 'number'
        );
      }
    } catch {
      // A malformed index is presented as an empty archive instead of leaking an error.
    }
  }

  const manifests = await Promise.all(
    versions.slice(0, 50).map((entry) => readArchiveManifest(env.RELEASES, entry.version))
  );
  const cards = manifests
    .map((manifest) => {
      const links = (['windows', 'macos', 'source'] as const)
        .filter((artifact) => artifact !== 'source' || canDownloadSource)
        .filter((artifact) => manifest.artifacts[artifact])
        .map((artifact) => {
          const label = artifact === 'windows' ? 'Windows' : artifact === 'macos' ? 'macOS' : 'Source code';
          return `<a href="/dl/archive/${manifest.version}/${artifact}.zip">${label}</a>`;
        })
        .join('');
      return `<article><h2>${manifest.version}</h2><div class="links">${links}</div></article>`;
    });
  const latest = cards[0] ?? '';
  const older = cards.slice(1).join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aura downloads</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#090b10;color:#f4f5f7}body{margin:0}
main{width:min(760px,calc(100% - 32px));margin:64px auto}header{margin-bottom:32px}h1{font-size:clamp(2rem,7vw,4rem);margin:0}
p{color:#a9afbb}.latest-release{padding:24px;border:1px solid #3b4250;border-radius:18px;margin-bottom:34px}.latest-release>p,.older-releases>p{margin:0 0 10px;text-transform:uppercase;letter-spacing:.12em;font-size:.72rem}.older-releases{border-left:1px solid #3b4250;padding-left:24px}article{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:20px 0;border-top:1px solid #272b35}
h2{margin:0;font-size:1.15rem}.links{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px}a{color:#090b10;background:#d9ff65;padding:10px 14px;border-radius:999px;text-decoration:none;font-weight:700}
.empty{padding:32px 0;border-top:1px solid #272b35}@media(max-width:520px){article{align-items:flex-start;flex-direction:column}.links{justify-content:flex-start}}
</style></head><body><main><header><h1>Aura Downloads</h1><p>Current and archived builds for authorized Aura Discord members.</p></header>
${latest ? `<section class="latest-release"><p>Latest version</p>${latest}</section><section class="older-releases"><p>Older versions</p>${older || '<p class="empty">No older releases yet.</p>'}</section>` : '<p class="empty">No releases have been published yet.</p>'}</main></body></html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
    },
  });
}

// GET /v1/release/meta?key=latest|latest-macos|source — version + sha256 for
// the app's auto-updater. Metadata remains public; artifact bodies are gated.
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

const VERSION_RE = /^v\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/;
const ARCHIVE_KEY_RE = /^archive\/v\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?\/(windows|macos|source)\.zip$/;

// GET /dl/{key} — caller has already passed the Discord session gate.
export async function serveDownload(req: Request, env: Env, key: string): Promise<Response> {
  const canonical = /^(latest|latest-macos|source)$/.test(key);
  if (!canonical && !ARCHIVE_KEY_RE.test(key)) return json({ error: 'not found' }, 404);
  let objectKey = key;
  if (canonical) {
    const metadata = await env.RELEASES.get(`meta:${key}`);
    if (metadata) {
      try {
        const value: unknown = await metadata.json();
        if (
          value &&
          typeof value === 'object' &&
          'target' in value &&
          typeof value.target === 'string' &&
          ARCHIVE_KEY_RE.test(value.target)
        ) {
          objectKey = value.target;
        }
      } catch {
        // Legacy uploads have no target; fall back to the stable object below.
      }
    }
  }
  const range = parseRange(req.headers.get('range'));
  const obj = range ? await env.RELEASES.get(objectKey, { range }) : await env.RELEASES.get(objectKey);
  if (!obj) return json({ error: 'not found' }, 404);

  const headers: Record<string, string> = {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="${dlName(objectKey, key)}"`,
    etag: obj.etag,
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
  };
  if (
    range &&
    obj.range &&
    'offset' in obj.range &&
    typeof obj.range.offset === 'number' &&
    typeof obj.range.length === 'number'
  ) {
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

function dlName(objectKey: string, requestedKey: string): string {
  const match = objectKey.match(/^archive\/(v[^/]+)\/(windows|macos|source)\.zip$/);
  if (match) return artifactFileName(match[2] as ArchiveArtifact, match[1]);
  if (requestedKey === 'latest') return 'aura-windows-amd64.zip';
  if (requestedKey === 'latest-macos') return 'aura-macos-arm64.zip';
  if (requestedKey === 'source') return 'aura-source.zip';
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
