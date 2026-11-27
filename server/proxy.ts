import { API_PATH, instanceAddress, isObject, PREVIEW_PATH } from '../data/postiz-client';

const ROUTES: Record<string, RegExp> = {
  GET: /^\/(?:me|integrations|posts|integration-settings\/[a-z0-9_-]+)$/i,
  POST: /^\/(?:posts|upload|integration-trigger\/[A-Za-z0-9_-]+)$/,
  DELETE: /^\/posts\/[a-z0-9_-]+$/i,
};
const PREVIEW = new RegExp('^' + PREVIEW_PATH + '/[a-z0-9_-]+$', 'i');

function allowed(method: string, path: string): boolean {
  return method === 'GET' && PREVIEW.test(path) ||
    path.startsWith(API_PATH + '/') && (ROUTES[method]?.test(path.slice(API_PATH.length)) ?? false);
}

function resolveAsset(value: unknown, upstream: string): unknown {
  if (typeof value !== 'string' || !value) return value;
  try { return new URL(value, upstream + '/').href; } catch { return value; }
}

function normalizeAssets(data: unknown, upstream: string): void {
  if (Array.isArray(data)) {
    data.forEach(value => normalizeAssets(value, upstream));
    return;
  }
  if (!isObject(data)) return;
  for (const key of ['path', 'picture', 'thumbnail']) {
    if (Object.hasOwn(data, key)) data[key] = resolveAsset(data[key], upstream);
  }
  if (isObject(data.integration)) normalizeAssets(data.integration, upstream);
  if (Array.isArray(data.posts)) normalizeAssets(data.posts, upstream);
  if (Array.isArray(data.image)) normalizeAssets(data.image, upstream);
  if (typeof data.image === 'string') {
    try {
      const image: unknown = JSON.parse(data.image);
      normalizeAssets(image, upstream);
      data.image = JSON.stringify(image);
    } catch { /* let the app validate the upstream response */ }
  }
}

export function postizProxy(upstreamUrl: string, allowedOrigin: string) {
  const upstream = instanceAddress(upstreamUrl);
  const app = new URL(allowedOrigin);
  if (app.origin !== allowedOrigin || !['https:', 'http:'].includes(app.protocol)) {
    throw new Error('APP_ORIGIN must be the web app origin, without a path or trailing slash.');
  }
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const origin = req.headers.get('origin');
    const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin' });
    const error = (status: number, msg: string) => Response.json({ msg }, { status, headers });
    if (origin && origin !== allowedOrigin) return error(403, 'This origin is not allowed.');
    if (origin) headers.set('Access-Control-Allow-Origin', allowedOrigin);
    if (req.method === 'OPTIONS') {
      const method = req.headers.get('Access-Control-Request-Method') ?? '';
      if (!origin || !allowed(method, url.pathname)) return error(404, 'This Postiz route is not available.');
      headers.set('Access-Control-Allow-Methods', method);
      headers.set('Access-Control-Allow-Headers', 'authorization, content-type');
      return new Response(null, { status: 204, headers });
    }
    if (!allowed(req.method, url.pathname)) return error(404, 'This Postiz route is not available.');
    const forwarded = new Headers({ Accept: 'application/json' });
    const key = req.headers.get('authorization');
    if (url.pathname.startsWith(API_PATH + '/')) {
      if (!key) return error(401, 'Enter a Postiz workspace API key.');
      forwarded.set('Authorization', key);
    }
    const contentType = req.headers.get('content-type');
    const lookup = url.pathname.startsWith(API_PATH + '/integration-trigger/');
    let body: BodyInit | null = req.method === 'POST' ? req.body : null;
    if (req.method === 'POST') {
      const expectedType = url.pathname === API_PATH + '/upload' ? 'multipart/form-data;' : 'application/json';
      if (!contentType?.toLowerCase().startsWith(expectedType)) return error(415, 'This Postiz route requires a different content type.');
      forwarded.set('Content-Type', contentType);
      if (lookup) {
        const input: unknown = await req.json().catch(() => null);
        if (!isObject(input) || input.methodName !== 'mention' || !isObject(input.data) ||
            typeof input.data.query !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(input.data.query)) {
          return error(400, 'This Postiz route only supports mention lookup.');
        }
        body = JSON.stringify({ methodName: 'mention', data: { query: input.data.query } });
      }
    }
    try {
      const result = await fetch(upstream + url.pathname + url.search, {
        method: req.method, headers: forwarded, body,
        redirect: 'error',
        signal: url.pathname === API_PATH + '/upload' ? req.signal : AbortSignal.any([req.signal, AbortSignal.timeout(125000)]),
      });
      const type = result.headers.get('content-type');
      if (type) headers.set('Content-Type', type);
      if ((req.method === 'GET' || lookup || url.pathname === API_PATH + '/upload') && result.ok && type?.includes('application/json')) {
        const value: unknown = await result.json();
        normalizeAssets(value, upstream);
        if (lookup && isObject(value) && Array.isArray(value.output)) {
          for (const item of value.output) if (isObject(item)) item.image = resolveAsset(item.image, upstream);
        }
        return Response.json(value, { status: result.status, headers });
      }
      return new Response(result.body, { status: result.status, headers });
    } catch {
      return error(502, 'The proxy could not reach its configured Postiz instance.');
    }
  };
}

if (import.meta.main) {
  const { POSTIZ_UPSTREAM, APP_ORIGIN, PORT } = process.env;
  if (!POSTIZ_UPSTREAM?.startsWith('https://') || !APP_ORIGIN) {
    throw new Error('Set POSTIZ_UPSTREAM to the HTTPS Postiz base address and APP_ORIGIN to the web app origin.');
  }
  const server = Bun.serve({
    hostname: '127.0.0.1', port: Number(PORT ?? 4787), idleTimeout: 0, maxRequestBodySize: 2 * 1024 ** 3 + 1024 ** 2,
    fetch: postizProxy(POSTIZ_UPSTREAM, APP_ORIGIN),
  });
  console.log('Postiz web proxy listening on loopback port ' + server.port);
}
