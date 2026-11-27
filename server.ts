import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { receiveMedia, temporaryMediaDirectory } from './server/media';
import { Database } from 'bun:sqlite';
import { API_PATH, DEMO_KEY, isMedia, isObject, nonempty, PREVIEW_PATH } from './data/postiz-client';
import type { CreatePost, JsonObject } from './data/postiz-client';
import { accounts, fixturePosts, linkedinMentions, schemas, seedAssets } from './server/fixtures';
import type { Asset, FixturePost } from './server/fixtures';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};
const send = (value: unknown, status = 200) => Response.json(value, { status, headers: CORS });
const bad = (message: string) => send({ message: [message], error: 'Bad Request', statusCode: 400 }, 400);
const missing = () => send({ msg: 'Not found' }, 404);
const methods = new Set(['draft', 'schedule', 'now']);
const isDate = (value: unknown): value is string => nonempty(value) && Number.isFinite(Date.parse(value));

type Fault = { kind: 'fail' | 'timeout' | 'partial' | 'invalid'; path?: string; delayMs?: number };

function validCreate(value: unknown): value is CreatePost {
  return isObject(value) && typeof value.type === 'string' && methods.has(value.type) && isDate(value.date) &&
    typeof value.shortLink === 'boolean' && Array.isArray(value.tags) &&
    value.tags.every(tag => isObject(tag) && nonempty(tag.label) && nonempty(tag.value)) &&
    Array.isArray(value.posts) && value.posts.length > 0 && value.posts.every(post =>
      isObject(post) && isObject(post.integration) && nonempty(post.integration.id) &&
      (post.group === undefined || nonempty(post.group)) && isObject(post.settings) &&
      Array.isArray(post.value) && post.value.length > 0 && post.value.every(row =>
        isObject(row) && typeof row.content === 'string' && (row.id === undefined || nonempty(row.id)) &&
        Array.isArray(row.image) && row.image.every(isMedia)));
}

function validateSettings(identifier: string, settings: JsonObject): boolean {
  const schema = schemas[identifier]?.settings;
  if (!isObject(schema) || !isObject(schema.properties)) return true;
  const required = Array.isArray(schema.required) ? [...schema.required] : [];
  if (identifier === 'x') required.push(...(settings.post_type === 'article' ?
    ['article_title', 'article_status'] : ['who_can_reply_post']));
  return Object.entries(schema.properties).every(([key, property]) => {
    const value = settings[key];
    if (value === undefined) return !required.includes(key);
    if (!isObject(property)) return true;
    if (Array.isArray(property.enum)) return property.enum.includes(value);
    if (property.type === 'array') return Array.isArray(value);
    if (property.type === 'object') return isObject(value);
    if (property.type !== undefined && typeof value !== property.type) return false;
    return typeof value !== 'string' || typeof property.maxLength !== 'number' || value.length <= property.maxLength;
  });
}

export function startPostizFixture({
  port = 0, database = ':memory:', now = Date.now,
}: { port?: number; database?: string; now?: () => number } = {}) {
  const directory = database === ':memory:' ? temporaryMediaDirectory() : Promise.resolve(database + '.media');
  const db = new Database(database);
  db.exec(`
    create table if not exists posts (id text primary key, data text not null);
    create table if not exists fixture (seeded integer not null);
    create table if not exists uploads (path text primary key, type text not null, bytes blob not null);
  `);
  const put = db.query('insert into posts values ($id, $data) on conflict(id) do update set data = excluded.data');
  const setPost = (row: FixturePost) => put.run({ $id: row.id, $data: JSON.stringify(row) });
  const allPosts = () => db.query<{ data: string }, []>('select data from posts').all().map(row => JSON.parse(row.data) as FixturePost);
  const asset = (pathname: string): Asset | undefined => seedAssets.get(pathname) ??
    db.query<Asset, [string]>('select type, bytes from uploads where path = ?').get(pathname) ?? undefined;
  const seed = db.transaction(() => {
    for (const row of fixturePosts(now())) setPost(row);
    db.run('insert into fixture values (1)');
  });
  let seeded = Boolean(db.query('select seeded from fixture').get());
  let fault: Fault | undefined;

  function remove(group: string) {
    const posts = allPosts().filter(row => row.group === group);
    const root = posts.find(row => !row.parentPostId);
    if (!root) return missing();
    db.transaction(() => {
      for (const post of posts) db.run('delete from posts where id = ?', [post.id]);
    })();
    return send({ id: root.id });
  }

  async function saveAsset(origin: string, name: string, type: string, bytes: Uint8Array | Blob | ((target: string) => Promise<void>)) {
    const id = crypto.randomUUID();
    const ext = name.split('.').at(-1)?.toLowerCase();
    if (!ext || !['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4'].includes(ext)) return bad('File must have a valid extension');
    const path = '/uploads/' + id + '.' + ext;
    if (typeof bytes === 'function') {
      const file = join(await directory, id + '.' + ext);
      try { await bytes(file); } catch (error) { await rm(file, { force: true }); throw error; }
    } else if (bytes instanceof Blob) {
      await Bun.write(join(await directory, id + '.' + ext), bytes);
    } else db.run('insert into uploads values (?, ?, ?)', [path, type, bytes]);
    return send({ id, name: id + '.' + ext, path: origin + path, originalName: null, thumbnail: null, alt: null, status: 'ready' }, 201);
  }

  async function diskAsset(path: string) {
    if (!/^\/uploads\/[a-f0-9-]{36}\.(png|jpe?g|webp|gif|mp4)$/.test(path)) return undefined;
    const file = Bun.file(join(await directory, path.slice('/uploads/'.length)));
    return await file.exists() ? file : undefined;
  }

  const server = Bun.serve({
    port, hostname: '127.0.0.1', idleTimeout: 0, maxRequestBodySize: 1024 ** 3 + 1024 ** 2,
    async fetch(req) {
      const { origin, pathname, searchParams } = new URL(req.url);
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (pathname === '/health') return new Response('ok');
      if (pathname === '/__postiz/fault' && req.method === 'POST') {
        if (req.headers.has('origin')) return missing();
        const value = await req.json().catch(() => null);
        if (!isObject(value) || !['fail', 'timeout', 'partial', 'invalid'].includes(String(value.kind)) ||
            (value.path !== undefined && typeof value.path !== 'string') ||
            (value.delayMs !== undefined && (typeof value.delayMs !== 'number' || value.delayMs < 1 || value.delayMs > 120000))) {
          return bad('Choose a supported fixture fault');
        }
        fault = value as Fault;
        return send({ ok: true });
      }
      if (pathname.startsWith('/uploads/') && req.method === 'GET') {
        const file = await diskAsset(pathname);
        if (file) return new Response(file, { headers: { ...CORS, 'Content-Type': file.type } });
        const image = asset(pathname);
        return image ? new Response(image.bytes as Uint8Array<ArrayBuffer>, { headers: { ...CORS, 'Content-Type': image.type } }) : missing();
      }
      const preview = pathname.startsWith(PREVIEW_PATH + '/');
      if (!preview && !pathname.startsWith(API_PATH + '/')) return missing();
      if (!preview && req.headers.get('authorization') !== DEMO_KEY) return send({ msg: 'Invalid API key' }, 401);
      if (!seeded) {
        seed();
        seeded = true;
      }

      const resource = preview ? pathname : pathname.slice(API_PATH.length);
      const currentFault = fault && (fault.kind !== 'partial' || (resource === '/posts' && req.method === 'POST')) &&
        (!fault.path || fault.path === resource) ? fault : undefined;
      if (currentFault) {
        fault = undefined;
        if (currentFault.kind === 'fail') return send({ msg: 'Fixture failure' }, 503);
        if (currentFault.kind === 'invalid') return send({ unexpected: true });
        if (currentFault.kind === 'timeout') await Bun.sleep(currentFault.delayMs ?? 16000);
      }

      if (preview && req.method === 'GET') {
        const id = decodeURIComponent(pathname.slice(PREVIEW_PATH.length + 1));
        const all = allPosts();
        const root = all.find(row => row.id === id);
        if (!root) return send([]);
        const thread = [root];
        let last = root;
        while (true) {
          const child = all.find(row => row.parentPostId === last.id);
          if (!child) break;
          thread.push(child);
          last = child;
        }
        return send(thread.map(({ integration, ...row }, index) => ({ ...row, parentPostId: row.parentPostId ?? null,
          integrationId: integration.id, delay: row.delay ?? 0, ...(index === 0 ? { integration } : {}) })));
      }
      if (resource === '/me' && req.method === 'GET') return send({ organization: { id: 'demo', name: 'Demo' }, user: null });
      if (resource === '/is-connected' && req.method === 'GET') return send({ connected: true });
      if (resource === '/integrations' && req.method === 'GET') return send(accounts);
      if (resource.startsWith('/integration-settings/') && req.method === 'GET') {
        const found = accounts.find(account => account.id === decodeURIComponent(resource.slice('/integration-settings/'.length)));
        return found ? send({ output: schemas[found.identifier] }) : missing();
      }
      if (resource.startsWith('/integration-trigger/') && req.method === 'POST') {
        const found = accounts.find(account => account.id === decodeURIComponent(resource.slice('/integration-trigger/'.length)));
        if (!found) return missing();
        const body: unknown = await req.json().catch(() => null);
        if (found.identifier !== 'linkedin' || !isObject(body) || body.methodName !== 'mention') {
          return send({ msg: 'Tool not found' }, 404);
        }
        const query = isObject(body.data) && typeof body.data.query === 'string' ? body.data.query : '';
        const mention = linkedinMentions.get(query);
        return send({ output: mention ? [mention] : [] }, 201);
      }
      if (resource.startsWith('/find-slot/') && req.method === 'GET') {
        const id = decodeURIComponent(resource.slice('/find-slot/'.length));
        if (!accounts.some(account => account.id === id)) return missing();
        const hour = 3600000;
        const taken = new Set(allPosts().filter(row => row.state === 'QUEUE' && row.integration.id === id)
          .map(row => Date.parse(row.publishDate)));
        let slot = Math.ceil(now() / hour) * hour;
        while (taken.has(slot)) slot += hour;
        return send({ date: new Date(slot).toISOString() });
      }
      if (resource === '/posts' && req.method === 'GET') {
        const from = searchParams.get('startDate');
        const to = searchParams.get('endDate');
        if (!isDate(from) || !isDate(to)) return bad('Provide startDate and endDate');
        const posts = allPosts().filter(row => !row.parentPostId && Date.parse(row.publishDate) >= Date.parse(from) &&
          Date.parse(row.publishDate) <= Date.parse(to));
        return send({ posts: posts.map(({ image: _image, parentPostId: _parent, delay: _delay, ...row }) => row) });
      }
      if (resource === '/posts' && req.method === 'POST') {
        const body = await req.json().catch(() => null);
        if (!validCreate(body)) return bad('Invalid create post body');
        for (const post of body.posts) {
          const channel = accounts.find(account => account.id === post.integration.id);
          if (!channel) return bad('Integration not found');
          if (post.settings.__type !== channel.identifier || !validateSettings(channel.identifier, post.settings)) {
            return bad('Invalid provider settings');
          }
          if (post.value.some(row => !row.content.trim() && !row.image.length)) {
            return send({ provider: channel.identifier, name: channel.name, error: 'Add text or an image.' }, 400);
          }
          if (body.type !== 'draft' && ['instagram-standalone', 'tiktok'].includes(channel.identifier) && !post.value[0].image.length) {
            return send({ provider: channel.identifier, name: channel.name, error: 'Add an attachment.' }, 400);
          }
        }
        const posts = currentFault?.kind === 'partial' ? body.posts.slice(0, 1) : body.posts;
        const save = db.transaction(() => posts.map(post => {
          const channel = accounts.find(account => account.id === post.integration.id)!;
          const group = crypto.randomUUID();
          const ids = post.value.map(row => row.id || crypto.randomUUID());
          const old = allPosts().filter(row => row.group === post.group && !ids.includes(row.id));
          for (const row of old) db.run('delete from posts where id = ?', [row.id]);
          for (const [i, row] of post.value.entries()) {
            setPost({
              id: ids[i], group, parentPostId: ids[i - 1], delay: row.delay, content: row.content,
              publishDate: body.type === 'now' ? new Date(Math.floor(now() / 60000) * 60000).toISOString() : body.date,
              state: body.type === 'draft' ? 'DRAFT' : 'QUEUE', releaseURL: null, releaseId: null, error: null, intervalInDays: null,
              integration: { id: channel.id, name: channel.name, providerIdentifier: channel.identifier, picture: channel.picture },
              creationMethod: 'API', tags: body.tags.map(tag => ({ tag: { id: tag.value, name: tag.label } })),
              settings: JSON.stringify(post.settings), image: JSON.stringify(row.image),
            });
          }
          return { integration: channel.id, postId: ids[0] };
        }));
        return send(save(), 201);
      }
      if (resource.startsWith('/posts/group/') && req.method === 'DELETE') {
        return remove(decodeURIComponent(resource.slice('/posts/group/'.length)));
      }
      if (resource.startsWith('/posts/') && req.method === 'DELETE') {
        const id = decodeURIComponent(resource.slice('/posts/'.length));
        const row = allPosts().find(post => post.id === id);
        return row ? remove(row.group) : missing();
      }
      if (resource === '/upload' && req.method === 'POST') {
        const media = await receiveMedia(req, await directory).catch(() => null);
        if (!media) return bad('Invalid attachment or file exceeds the Postiz size limit');
        try { return await saveAsset(origin, media.name, media.type, media.write); }
        finally { await media.discard(); }
      }
      if (resource === '/upload-from-url' && req.method === 'POST') {
        const body = await req.json().catch(() => null);
        if (!isObject(body) || !nonempty(body.url)) return send({ msg: 'Provide a media URL' }, 400);
        let url: URL;
        try { url = new URL(body.url); } catch { return send({ msg: 'Provide a media URL' }, 400); }
        const file = url.origin === origin ? await diskAsset(url.pathname) : undefined;
        if (file) return saveAsset(origin, url.pathname, file.type, file);
        const image = url.origin === origin ? asset(url.pathname) : undefined;
        return image ? saveAsset(origin, url.pathname, image.type, image.bytes) : send({ msg: 'Use a fixture media URL' }, 400);
      }
      return missing();
    },
  });
  return { origin: server.url.origin, stop: async () => { await server.stop(true); db.close(); if (database === ':memory:') await rm(await directory, { recursive: true, force: true }); } };
}

if (import.meta.main) {
  const fixture = startPostizFixture({ port: Number(process.env.PORT ?? 4786), database: process.env.DB ?? ':memory:' });
  console.log('Postiz development fixture listening at ' + fixture.origin);
}
