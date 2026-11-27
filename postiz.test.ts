import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Args, Storage, Store } from './app.contract.d.ts';
import { API_PATH, assetUrl, DEMO_KEY, instanceAddress, postizClient } from './data/postiz-client';
import { createSources } from './data/postiz';
import { channelFor, fromSettings, toSettings } from './data/postiz-settings';
import { startPostizFixture } from './server';
import { seedAssets } from './server/fixtures';
import { postizProxy } from './server/proxy';

const NOW = Date.parse('2027-02-03T12:20:00.000Z');
const AT = Date.parse('2027-02-04T16:47:23.451-05:00');
const DAY = 86400000;
const FILE = 'app:/tmp/picked/field-notes.png';
const picture = seedAssets.get('/uploads/field-notes.png')!.bytes;
const target = (channelId: string, text = 'A test draft for the local fixture.'): Args<'submitPost'>[3][number] =>
  ({ channelId, text, settings: [], thread: [], comment: '' });

function device() {
  const files = new Map<string, Uint8Array>([[FILE, picture]]);
  const secrets = new Map<string, string>();
  const store = {
    get: (key: string) => secrets.get(key) ?? null,
    set: (key: string, value: string) => { secrets.set(key, value); },
    forget: (key: string) => { secrets.delete(key); },
  } as Store;
  const storage = { fs: {
    readFile: async (path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw Object.assign(new Error('missing file'), { code: 'ENOENT' });
      return Uint8Array.from(bytes).buffer;
    },
    stat: async (path: string) => ({ size: files.get(path)?.length ?? 0, isFile: files.has(path) }),
    atomicWriteFile: async (path: string, data: Uint8Array) => { files.set(path, Uint8Array.from(data)); },
    digest: async (path: string) => new Bun.CryptoHasher('sha256').update(files.get(path) ?? '').digest('hex'),
  } } as Storage;
  return { files, secrets, store, storage };
}

let fixture: ReturnType<typeof startPostizFixture>;
const timed = (input: string | URL | Request, init?: RequestInit) =>
  fetch(input, { ...init, signal: init?.exactTimeout ? AbortSignal.timeout(init.exactTimeout) : undefined });
const app = (...args: Parameters<typeof createSources>) => {
  const { files, secrets, store, storage } = device();
  const sources = createSources(...args);
  return { files, secrets, store, storage, sources,
    connect: (address: string, key: string) => sources.connect([address, key], store, storage),
    connection: () => sources.loadConnection([], store, storage),
    channels: () => sources.loadChannels([fixture.origin], store, storage),
    feed: () => sources.loadPosts([fixture.origin, NOW - 10 * DAY, NOW + 10 * DAY], store, storage),
    mentions: (channelId: string, query: string) => sources.findMentions([fixture.origin, channelId, query], store, storage),
    submit: (...values: Args<'submitPost'>) => sources.submitPost(values, store, storage),
  };
};

async function fault(kind: string, path: string, delayMs?: number) {
  const result = await fetch(fixture.origin + '/__postiz/fault', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, path, delayMs }),
  });
  expect(result.status).toBe(200);
}

beforeEach(() => { fixture = startPostizFixture({ now: () => NOW }); });
afterEach(async () => { await fixture.stop(); });

describe('Postiz sources', () => {
  test('only accepts secure instance addresses and loopback HTTP', () => {
    expect(instanceAddress(' https://postiz.example.test/workspace/api/public/v1/ ')).toBe('https://postiz.example.test/workspace');
    expect(instanceAddress('http://localhost:4786')).toBe('http://localhost:4786');
    for (const invalid of ['postiz.example.test', 'http://postiz.example.test', 'https://a:b@example.test/',
      'https://postiz.example.test/#top', 'https://postiz.example.test/?auth=1']) {
      expect(() => instanceAddress(invalid)).toThrow('HTTPS address');
    }
    expect(assetUrl('https://postiz.example.test', '/uploads/an-avatar.png', true)).toBe('https://postiz.example.test/uploads/an-avatar.png');
    expect(assetUrl('https://postiz.example.test', 'javascript:alert(1)', true)).toBe('');
  });

  test('keeps a verified key in the secret store, preserves a good connection on rejection and clears it on disconnect', async () => {
    const d = app();
    expect((await d.connection()).state).toBe('none');
    expect(await d.connect(fixture.origin, 'wrong-key')).toMatchObject({ ok: false, error: expect.stringContaining('API key') });
    expect(d.files.size).toBe(1);
    expect(await d.connect(fixture.origin, DEMO_KEY)).toEqual({ ok: true, error: '' });
    expect((await d.connection())).toMatchObject({ state: 'ready', workspace: 'Demo', instance: fixture.origin });
    const onDisk = [...d.files].filter(([path]) => path !== FILE).map(([, bytes]) => new TextDecoder().decode(bytes)).join('');
    expect(onDisk).not.toContain(DEMO_KEY);
    expect(d.secrets.get('postiz-key')).toContain(DEMO_KEY);
    expect(await d.connect(fixture.origin, 'wrong-key')).toMatchObject({ ok: false });
    expect((await d.connection()).state).toBe('ready');
    await expect(d.sources.loadChannels(['https://other.example.test'], d.store, d.storage)).rejects.toThrow('Connect');
    expect(await d.sources.disconnect([], d.store, d.storage)).toEqual({ ok: true, error: '' });
    expect(d.secrets.size).toBe(0);
    expect((await d.connection()).state).toBe('none');
  });

  test('discovers enabled destinations and maps the live-format calendar, preview media and statuses', async () => {
    const d = app(fixture.origin);
    expect((await d.connection()).workspace).toBe('Demo');
    const channels = await d.channels();
    expect(channels.map(c => c.network)).toEqual(['x', 'instagram', 'linkedin', 'tiktok', 'bluesky', 'threads', 'youtube']);
    const ig = channels[1];
    expect(channels.map(row => [row.threads, row.comments, row.mentions])).toEqual([
      [true, false, 'typed'], [false, true, 'typed'], [false, true, 'search'],
      [false, false, 'typed'], [true, false, 'typed'], [true, false, 'typed'], [false, false, 'none'],
    ]);
    expect(ig).toMatchObject({ handle: 'northstar.fieldnotes', limit: 2200, needsMedia: true });
    expect(ig.fields.find(field => field.key === 'post_type')?.options.map(o => o.value)).toEqual(['post', 'reel', 'story']);
    expect(ig.fields.find(field => field.key === 'collaborators')).toMatchObject({ kind: 'list', max: 3 });
    expect(channels[3].fields.find(field => field.key === 'privacy_level')?.required).toBe(true);
    const feed = await d.feed();
    expect(feed.owner).toBe(fixture.origin);
    expect(feed.posts.map(row => row.at)).toEqual(feed.posts.map(row => row.at).sort((a, b) => a - b));
    expect(feed.posts.filter(row => row.status === 'sent' && row.media.length === 1)).toHaveLength(2);
    const withImage = feed.posts.find(row => row.id === 's3')!;
    expect(withImage.link).toBe('https://example.com/posts/s3');
    expect(withImage.media[0]).toMatchObject({ kind: 'image', path: '', url: fixture.origin + '/uploads/field-notes.png' });
    expect((await fetch(withImage.media[0].url)).headers.get('content-type')).toBe('image/png');
    expect(new Set(feed.posts.filter(row => row.status === 'draft').map(row => row.group)).size).toBe(1);
    expect(feed.posts.find(row => row.status === 'error')?.error).toContain('rejected');
    await fault('invalid', '/posts');
    await expect(d.feed()).rejects.toThrow('unexpected response');
    await fault('fail', '/integrations');
    await expect(d.channels()).rejects.toThrow('HTTP 503');
    expect((await d.channels()).length).toBe(7);
  });

  test('stores ordered thread entries and a first comment, then replaces or clears the entries on edit', async () => {
    const d = app(fixture.origin);
    const x = { ...target('c-x', 'Thread root'), thread: ['Second', 'Third'] };
    const ig = { ...target('c-ig', 'Photo caption'), comment: 'First comment' };
    const image = { id: 'local', kind: 'image', name: 'field-notes.png', path: FILE, url: '', alt: 'A sketch of the trail' };
    expect((await d.submit('draft', AT, '', [x, ig], [image], NOW)).ok).toBe(true);
    const posts = (await d.feed()).posts.filter(row => [x.text, ig.text].includes(row.text));
    const thread = posts.find(row => row.channelId === x.channelId)!;
    const photo = posts.find(row => row.channelId === ig.channelId)!;
    expect(thread).toMatchObject({ thread: x.thread, comment: '', media: [{ alt: '' }] });
    expect(photo).toMatchObject({ thread: [], comment: ig.comment, media: [{ alt: image.alt }] });
    const client = postizClient(fixture.origin, DEMO_KEY);
    const previous = await client.preview(thread.id);
    expect(previous.map(row => row.text)).toEqual([x.text, ...x.thread]);
    expect(previous.map(row => row.parentId)).toEqual(['', previous[0].id, previous[1].id]);
    const edited = await d.submit('draft', AT, thread.group, [{ ...x, thread: ['Changed second'] }, { ...ig, comment: '' }], photo.media, NOW);
    expect(edited.ok).toBe(true);
    const updated = await client.preview(thread.id);
    expect(updated.map(row => [row.id, row.text])).toEqual([[previous[0].id, x.text], [previous[1].id, 'Changed second']]);
    expect(await client.preview(previous[2].id)).toEqual([]);
    expect((await client.preview(photo.id)).length).toBe(1);
    expect((await d.feed()).posts.some(row => row.text === 'Changed second')).toBe(false);
  });

  test('reports unsupported or overlong follow-ups against the affected destination before writing', async () => {
    const d = app(fixture.origin);
    const result = await d.submit('schedule', AT, '', [
      { ...target('c-x'), comment: 'This is not a thread entry' },
      { ...target('c-ig'), thread: ['This is not a first comment'] },
      { ...target('c-li'), comment: 'A valid first comment' },
      { ...target('c-bs'), thread: ['a'.repeat(301)] },
    ], [], NOW);
    expect(result.outcomes.map(row => row.error)).toEqual([
      expect.stringMatching(/X.*first comment/), expect.stringMatching(/Instagram.*thread/),
      expect.stringMatching(/before sending/), expect.stringMatching(/Bluesky.*300/),
    ]);
    expect((await d.feed()).posts.some(row => row.text === target('').text)).toBe(false);
  });

  test('uses the advertised public tool for LinkedIn company vanity names, handles and profile links', async () => {
    const d = app(fixture.origin);
    const [mention] = await d.mentions('c-li', 'https://www.linkedin.com/company/example-studio/?trk=fixture');
    expect(mention).toMatchObject({ id: '101', name: 'Example & Studio', handle: 'example-studio',
      token: '<span data-mention-id="101" data-mention-label="Example &amp; Studio">@Example &amp; Studio</span>' });
    expect(await d.mentions('c-li', '@example-studio')).toEqual([mention]);
    expect(await d.mentions('c-li', 'Example & Studio')).toEqual([mention]);
    expect(mention.avatar).toBe(fixture.origin + '/uploads/avatar-c-li.png');
    expect(await d.mentions('c-li', 'https://linkedin.com/in/example-studio')).toEqual([]);
    expect(await d.mentions('c-x', '@example-studio')).toEqual([]);
    const [punctuation] = await d.mentions('c-li', 'example-works');
    expect(punctuation.name).toBe('Example "<Works>"');
    expect(punctuation.token).toBe('<span data-mention-id="102" data-mention-label="Example &quot;&lt;Works&gt;&quot;">@Example "&lt;Works&gt;"</span>');
    const text = 'New from <our team>:\n' + mention.token + ' and ' + punctuation.token;
    const setting = { key: '@mention:@Example & Studio', value: mention.token };
    expect((await d.submit('draft', AT, '', [{ ...target('c-li', text), settings: [setting] }], [], NOW)).ok).toBe(true);
    const post = (await d.feed()).posts.find(row => row.text === 'New from <our team>:\n@Example & Studio and @Example "<Works>"')!;
    expect(post.settings).toEqual([setting, { key: '@mention:@Example "<Works>"', value: punctuation.token }]);
    const [wire] = await postizClient(fixture.origin, DEMO_KEY).preview(post.id);
    expect(wire.text).toBe('<p>New from &lt;our team&gt;:<br>' + mention.token + ' and ' + punctuation.token + '</p>');
    expect(wire.settings).toEqual({ __type: 'linkedin' });
  });

  test('uploads local media once for a multi-account edit, retains exact UTC time and removes a deselected destination', async () => {
    let uploads = 0;
    const network = ((input, options) => {
      if (String(input).endsWith('/upload')) uploads++;
      return timed(input, options);
    }) as typeof fetch;
    const d = app(fixture.origin, network);
    const attached = [{ id: 'local', kind: 'image', name: 'field-notes.png', path: FILE, url: '' }];
    const created = await d.submit('schedule', AT, '', [target('c-x'), target('c-ig')], attached, NOW);
    expect(created).toEqual({ ok: true, error: '', outcomes: ['c-x', 'c-ig'].map(channelId => ({ channelId, ok: true, error: '' })) });
    expect(uploads).toBe(1);
    const [first, second] = (await d.feed()).posts.filter(row => row.text === target('').text);
    expect(second.group).toBe(first.group);
    expect(first.at).toBe(AT);
    expect(second.media[0].id).toBe(first.media[0].id);
    const retrieved = await fetch(first.media[0].url);
    expect(new Uint8Array(await retrieved.arrayBuffer())).toEqual(picture);

    const fresh = createSources(fixture.origin, network);
    const edited = await fresh.submitPost(['schedule', AT + 999, first.group, [target('c-x', 'An edited fixture post.')], first.media, NOW], d.store, d.storage);
    expect(edited.ok).toBe(true);
    const remaining = (await d.feed()).posts.filter(row => [first.id, second.id].includes(row.id));
    const oldX = [first, second].find(row => row.channelId === 'c-x')!;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ id: oldX.id, group: first.group, at: AT + 999, text: 'An edited fixture post.' });
    expect(uploads).toBe(1);
    expect(await d.sources.deletePost([remaining[0].id], d.store, d.storage)).toEqual({ ok: true, error: '' });
    expect((await d.feed()).posts.some(row => row.id === oldX.id)).toBe(false);
  });

  test('hands large files to the host and preserves a server rejection', async () => {
    const d = app(fixture.origin);
    const size = 1024 ** 3;
    const path = 'app:/data/media/video.mp4';
    const storage = { ...d.storage, fs: { ...d.storage.fs, stat: async () => ({ size, isFile: true }) } } as Storage;
    let status = 201;
    const native = { available: true, call: () => ({}), watch: () => {}, later: async (request: Record<string, unknown>) => {
      expect(request).toMatchObject({ op: 'upload', path, size, type: 'video/mp4', url: fixture.origin + API_PATH + '/upload' });
      return { status, data: { id: 'video', path: '/uploads/video.mp4' } };
    } };
    const args: Args<'submitPost'> = ['draft', AT, '', [target('c-x')], [{ id: 'video', kind: 'video', name: 'video.mp4', path, url: '' }], NOW];
    expect((await d.sources.submitPost(args, d.store, storage, native)).ok).toBe(true);
    status = 413;
    const rejected = await d.sources.submitPost(args, d.store, storage, native);
    expect(rejected.ok).toBe(false);
    expect(rejected.outcomes[0].error).toContain('upload limits');
  });

  test('reopens two old API posts sharing a group and refuses to update published content', async () => {
    const d = app(fixture.origin);
    const rows = (await d.feed()).posts;
    const draft = rows.find(row => row.id === 'd1')!;
    const edited = await d.submit('draft', AT, draft.group, [target('c-x', 'Retained draft')], [], NOW);
    expect(edited.ok).toBe(true);
    expect((await d.feed()).posts.find(row => row.id === 'd1')?.text).toBe('Retained draft');
    expect((await d.feed()).posts.some(row => row.id === 'd2')).toBe(false);
    const sent = rows.find(row => row.id === 's1')!;
    expect((await d.submit('draft', AT, sent.group, [target('c-x')], [], NOW)).error).toContain('already published');
  });

  test('reports only confirmed destinations and treats a timed-out write as uncertain', async () => {
    const d = app(fixture.origin, timed as typeof fetch, 100);
    await fault('partial', '/posts');
    const partial = await d.submit('draft', AT, '', [target('c-x'), target('c-bs')], [], NOW);
    expect(partial.ok).toBe(false);
    expect(partial.outcomes).toEqual([
      { channelId: 'c-x', ok: true, error: '' },
      { channelId: 'c-bs', ok: false, error: expect.stringContaining('did not confirm') },
    ]);
    await fault('timeout', '/posts', 180);
    const timeout = await d.submit('draft', AT, '', [target('c-bs', 'Possibly accepted')], [], NOW);
    expect(timeout).toMatchObject({ ok: false, error: expect.stringContaining('Check each destination'),
      outcomes: [{ channelId: 'c-bs', ok: false, error: expect.stringContaining('too long') }] });
  });

  test('validates required provider values and uses the real Instagram type for a single-video Reel', async () => {
    const d = app(fixture.origin);
    const ig = (await d.channels())[1];
    const client = postizClient(fixture.origin, DEMO_KEY);
    const schema = await client.schema(ig.id);
    const video = [{ id: 'video', url: 'https://example.test/launch.mp4', name: 'launch.mp4', path: '', kind: 'video' }];
    const content = { ...target(ig.id), settings: [{ key: 'post_type', value: 'reel' }, { key: 'collaborators', value: '["@design",{"label":"maker"}]' }] };
    const wire = toSettings(ig, schema, 'instagram-standalone', content, video, false);
    expect(wire).toEqual({ __type: 'instagram-standalone', post_type: 'post', collaborators: [{ label: 'design' }, { label: 'maker' }] });
    expect(fromSettings(wire, 'instagram-standalone', [{ id: 'video', path: video[0].url }])[0]).toEqual({ key: 'post_type', value: 'reel' });
    expect(() => toSettings(ig, schema, 'instagram-standalone', content, [], false)).toThrow('attachment');
    const youtube = { maxLength: 5000, required: ['title', 'type'],
      properties: { title: { type: 'string', maxLength: 100 }, type: { enum: ['public', 'private', 'unlisted'] } } };
    const yt = channelFor(fixture.origin, { id: 'yt', name: 'Video', identifier: 'youtube' }, youtube);
    expect(yt.fields.find(field => field.key === 'title')).toMatchObject({ required: true, max: 100 });
    expect(() => toSettings(yt, youtube, 'youtube', target('yt'), video, false)).toThrow('title');
    const tt = await d.submit('draft', AT, '', [target('c-tt'), target('c-bs')], [], NOW);
    expect(tt.outcomes).toMatchObject([{ channelId: 'c-tt', ok: false, error: expect.stringContaining('who can see') },
      { channelId: 'c-bs', ok: false, error: expect.any(String) }]);
  });
});

test('the web proxy handles the app preflight, relays authorized API calls, and keeps the upstream fixed', async () => {
  const origin = 'https://social.example.test';
  const proxy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: postizProxy(fixture.origin, origin) });
  try {
    const url = proxy.url.origin + API_PATH + '/integrations';
    const preflight = (site: string) => fetch(url, { method: 'OPTIONS',
      headers: { Origin: site, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    expect((await preflight(origin)).headers.get('access-control-allow-origin')).toBe(origin);
    expect((await preflight('https://other.example.test')).status).toBe(403);
    const result = await fetch(url, { headers: { Origin: origin, Authorization: DEMO_KEY } });
    expect(result.status).toBe(200);
    expect((await result.json())[0].picture).toBe(fixture.origin + '/uploads/avatar-c-x.png');
    const unauthorized = await fetch(url, { headers: { Origin: origin } });
    expect(unauthorized.status).toBe(401);
    const form = new FormData();
    form.set('file', new Blob([Uint8Array.from(picture)], { type: 'image/png' }), 'fixture.png');
    expect((await fetch(proxy.url.origin + API_PATH + '/upload', { method: 'POST',
      headers: { Origin: origin, Authorization: DEMO_KEY }, body: form })).status).toBe(201);
    const trigger = (methodName: string, path = '/integration-trigger/c-li') => fetch(proxy.url.origin + API_PATH + path, {
      method: 'POST', headers: { Origin: origin, Authorization: DEMO_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ methodName, data: { query: 'example-studio' } }),
    });
    expect((await (await trigger('mention')).json()).output).toEqual([
      { id: '101', label: 'Example & Studio', image: fixture.origin + '/uploads/avatar-c-li.png' },
    ]);
    expect((await trigger('otherTool')).status).toBe(400);
    expect((await trigger('otherTool', '/integration-TRIGGER/c-li')).status).toBe(404);
    expect((await fetch(proxy.url.origin + '/admin')).status).toBe(404);
  } finally { await proxy.stop(true); }
});
