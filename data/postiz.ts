import type { Args, Result, Sources, NativeModule, Storage, Store } from '../app.contract.d.ts';
import {
  API_PATH, isMedia, assetUrl, instanceAddress, DEMO_KEY, invalidResponse, isObject, nonempty, PostizError, postizClient,
} from './postiz-client';
import type { Client, CreatePost, RemoteMedia, RemotePost } from './postiz-client';
import { channelFor, followUpKind, followUpText, fromSettings, isLinkedIn, isVideo, networkOf, supportsImageAlt, toSettings } from './postiz-settings';
import { decodeLinkedInContent, encodeLinkedInContent, linkedInMentionSettings, linkedinToken, linkedinVanity, visiblePostContent } from './postiz-content';

type Post = Result<'loadPosts'>['posts'][number];
type Sent = Result<'submitPost'>;
type Outcome = Sent['outcomes'][number];
type Media = Args<'submitPost'>[4][number];
type Reply = Result<'connect'>;

const KEY = 'postiz-key';
const CONNECTION = 'app:/data/postiz-connection.json';
const GROUPS = 'app:/data/postiz-groups.json';
const DAY = 86400000;
const ok: Reply = { ok: true, error: '' };
const fail = (error: unknown, fallback: string): Reply =>
  ({ ok: false, error: error instanceof PostizError ? error.message : fallback });

type Address = { instance: string; workspace: string; principal: string };
type Session = Address & { key: string };
type Composition = { instance: string; principal: string; group: string; ids: string[] };

const missingFile = (error: unknown) => isObject(error) && error.code === 'ENOENT';

async function readFile(storage: Storage, path: string): Promise<unknown> {
  let bytes: ArrayBuffer;
  try { bytes = await storage.fs.readFile(path); } catch (error) {
    if (missingFile(error)) return undefined;
    throw error;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function writeFile(storage: Storage, path: string, value: unknown) {
  return storage.fs.atomicWriteFile(path, new TextEncoder().encode(JSON.stringify(value)));
}

async function listGroups(storage: Storage): Promise<Composition[]> {
  const value = await readFile(storage, GROUPS);
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(row => isObject(row) && nonempty(row.instance) &&
      typeof row.principal === 'string' && nonempty(row.group) && Array.isArray(row.ids) && row.ids.every(nonempty))) {
    throw new PostizError('The saved post groups could not be read on this device.');
  }
  return value;
}

const belongsTo = (row: Composition, session: Session) =>
  row.instance === session.instance && row.principal === session.principal;

function asAddress(value: unknown): Address | null {
  if (!isObject(value) || !nonempty(value.instance) || typeof value.workspace !== 'string' ||
      typeof value.principal !== 'string') return null;
  return { instance: value.instance, workspace: value.workspace, principal: value.principal };
}

async function boundedMap<T, U>(list: T[], map: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = [];
  for (let i = 0; i < list.length; i += 6) results.push(...await Promise.all(list.slice(i, i + 6).map(map)));
  return results;
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4',
};

async function upload(client: Client, storage: Storage, media: Media, key: string, native?: NativeModule | null): Promise<RemoteMedia> {
  if (!media.path) {
    if (!media.id || !assetUrl(client.instance, media.url)) throw new PostizError('Choose the attachment again. Its Postiz URL is missing or invalid.');
    return { id: media.id, path: media.url };
  }
  const name = (media.name || media.path.split('/').at(-1) || 'attachment').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const type = MIME[name.split('.').at(-1)?.toLowerCase() ?? ''];
  if (!type) throw new PostizError('Choose a PNG, JPEG, GIF, WebP, or MP4 attachment that Postiz accepts.');
  try {
    const file = await storage.fs.stat(media.path);
    if (!file.isFile || file.size === 0) throw new PostizError(`Choose ${name} again. Its attachment file is missing or empty.`);
    if (file.size > 2 * 1024 ** 3) throw new PostizError('Choose an attachment of 2 GiB or smaller.');
    if (native?.available) {
      const { status, data } = await native.later({ op: 'upload', url: client.instance + API_PATH + '/upload',
        key, path: media.path, name, type, size: file.size });
      if (status === 413 || status === 400) throw new PostizError('Postiz rejected the attachment. Check the file format and the upload limits on your server.');
      if (status === 401 || status === 403) throw new PostizError('Postiz rejected this API key. Reconnect your workspace.');
      if (typeof status !== 'number' || status < 200 || status >= 300) throw new PostizError('The attachment upload failed. Check the Postiz connection and try again.');
      if (!isMedia(data) || !assetUrl(client.instance, data.path)) throw invalidResponse();
      return { id: data.id, path: data.path };
    }
    if (file.size > 16 * 1024 ** 2) throw new PostizError('Rebuild or update Exact Social to enable large attachment uploads.');
    const bytes = new Uint8Array(await storage.fs.readFile(media.path));
    if (bytes.length !== file.size) throw new PostizError(`Choose ${name} again. The attachment changed while reading it.`);
    // the web host has no fs.digest; the attachment's id and size name a boundary no image line starts with.
    const boundary = 'ExactSocial' + media.id.replace(/[^a-zA-Z0-9]/g, '') + 'x' + file.size;
    const encode = new TextEncoder();
    const start = encode.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`);
    const end = encode.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(start.length + bytes.length + end.length);
    body.set(start);
    body.set(bytes, start.length);
    body.set(end, start.length + bytes.length);
    return await client.upload('multipart/form-data; boundary=' + boundary, body);
  } catch (error) {
    if (error instanceof PostizError) throw error;
    throw new PostizError(`Choose ${name} again. The app could not read or upload the attachment.`);
  }
}

function asPost(instance: string, row: RemotePost, [root, ...replies]: RemotePost[], group: string): Post {
  const image = row.image ?? root.image ?? [];
  const media = image.map(item => {
    const url = assetUrl(instance, item.path);
    if (!url) throw invalidResponse();
    return { id: item.id, kind: isVideo(url) ? 'video' : 'image', name: new URL(url).pathname.split('/').at(-1) ?? '',
      path: '', url, alt: item.alt ?? '' };
  });
  const kind = followUpKind(row.provider);
  const linkedIn = isLinkedIn(networkOf(row.provider));
  const text = linkedIn ? decodeLinkedInContent(row.text) : row.text;
  const settings = fromSettings(row.settings, row.provider, image);
  return {
    id: row.id, group, channelId: row.channelId, text: linkedIn ? visiblePostContent(text) : text,
    at: row.at, status: row.status, media,
    settings: linkedIn ? [...settings, ...linkedInMentionSettings(text)] : settings,
    link: assetUrl(instance, row.link, true), error: row.status === 'error' ? row.error || 'Postiz could not publish this post.' : '',
    thread: kind === 'thread' ? replies.map(reply => reply.text) : [],
    comment: kind === 'comment' && replies[0] ? (linkedIn ? decodeLinkedInContent(replies[0].text) : replies[0].text) : '',
  };
}

type PostizSources = Pick<Sources, 'loadConnection' | 'connect' | 'disconnect' | 'loadChannels' | 'loadPosts' | 'submitPost' | 'deletePost' | 'findMentions'>;

export function createSources(demoAddress = '', network?: typeof fetch, timeout?: number): PostizSources {
  let mutating: Promise<unknown> = Promise.resolve();
  let connectionGeneration = 0;
  const recent = new Map<string, Map<string, RemotePost>>();
  const source = (session: Session) => postizClient(session.instance, session.key, network, timeout);
  const sessionKey = (session: Session) => JSON.stringify([session.instance, session.principal]);

  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const answer = mutating.then(operation);
    mutating = answer.then(() => {}, () => {});
    return answer;
  }

  async function address(storage: Storage): Promise<Address | null | undefined> {
    const saved = await readFile(storage, CONNECTION);
    if (saved === undefined || saved === null) return saved;
    const info = asAddress(saved);
    if (!info) throw new PostizError('The saved Postiz address could not be read. Connect the workspace again.');
    return info;
  }

  function session(store: Store, saved: Address | null | undefined): Session | null {
    if (saved) {
      const secret = store.get(KEY);
      if (!secret) throw new PostizError('The saved API key is missing. Connect this Postiz workspace again.');
      const parsed: unknown = JSON.parse(secret);
      if (!isObject(parsed) || parsed.instance !== saved.instance || parsed.principal !== saved.principal || !nonempty(parsed.key)) {
        throw new PostizError('The saved API key does not match this workspace. Connect Postiz again.');
      }
      return { ...saved, key: parsed.key };
    }
    if (!demoAddress || saved === null) return null;
    return { instance: demoAddress, workspace: 'Demo', principal: 'demo', key: DEMO_KEY };
  }

  async function requireSession(store: Store, storage: Storage, instance?: string): Promise<Session> {
    const current = session(store, await address(storage));
    if (!current || (instance !== undefined && instance !== current.instance)) {
      throw new PostizError('Connect this Postiz workspace again.');
    }
    return current;
  }

  async function oldPosts(client: Client, current: Session, groups: Composition[], group: string, now: number, at: number) {
    if (!group) return [];
    const saved = groups.find(row => row.group === group && belongsTo(row, current));
    let ids = saved?.ids;
    if (!ids) {
      const known = [...(recent.get(sessionKey(current))?.values() ?? [])].filter(post => post.group === group);
      const rows = known.length ? known : (await client.calendar(Math.min(now, at) - 366 * DAY, Math.max(now, at) + 366 * DAY))
        .filter(post => post.group === group);
      ids = [...new Set(rows.map(row => row.id))];
    }
    const threads = await boundedMap(ids, id => client.preview(id));
    const live = threads.filter(thread => thread.length);
    if (!live.length || (!saved && live.some(thread => thread[0].group !== group))) {
      throw new PostizError('This post group changed in Postiz. Refresh the queue and reopen it.');
    }
    if (live.some(thread => thread[0].status === 'sent')) {
      throw new PostizError('A post in this group was already published. Start a new post to publish again.');
    }
    if (new Set(live.map(thread => thread[0].channelId)).size !== live.length) {
      throw new PostizError('This group has more than one post on a destination. Edit it in Postiz.');
    }
    return live;
  }

  return {
    loadConnection: async (_args, store, storage) => {
      await mutating;
      let instance = '';
      let workspace = '';
      try {
        const saved = await address(storage);
        instance = saved?.instance ?? '';
        workspace = saved?.workspace ?? '';
        const current = session(store, saved);
        if (!current) return { state: 'none', instance, workspace, error: '' };
        instance = current.instance;
        workspace = current.workspace;
        const live = await source(current).workspace();
        if (current.principal && current.principal !== 'demo' && live.id && live.id !== current.principal) {
          throw new PostizError('This address now serves a different Postiz workspace. Reconnect with its API key.');
        }
        return { state: 'ready', instance, workspace: live.name, error: '' };
      } catch (error) {
        if (isObject(error) && error.code === 'bake') throw error;
        return { state: 'error', instance, workspace, error: fail(error, 'Could not read the saved Postiz connection. Connect again.').error };
      }
    },
    connect: ([input, key], store, storage) => mutate(async () => {
      try {
        const client = postizClient(input, key, network, timeout);
        const workspace = await client.workspace();
        const info = { instance: client.instance, workspace: workspace.name, principal: workspace.id };
        const previous = store.get(KEY);
        store.set(KEY, JSON.stringify({ instance: info.instance, principal: info.principal, key: key.trim() }));
        try { await writeFile(storage, CONNECTION, info); } catch (error) {
          if (previous === null) store.forget(KEY);
          else store.set(KEY, previous);
          throw error;
        }
        connectionGeneration++;
        recent.clear();
        return ok;
      } catch (error) { return fail(error, 'Could not save the Postiz connection. Check the device storage and try again.'); }
    }),
    disconnect: (_args, store, storage) => mutate(async () => {
      try {
        const previous = await address(storage).catch(() => null);
        // a null marker records that the person also disconnected the development workspace.
        await writeFile(storage, CONNECTION, null);
        store.forget(KEY);
        connectionGeneration++;
        recent.clear();
        if (previous) {
          const groups = await listGroups(storage);
          const retained = groups.filter(row => row.instance !== previous.instance);
          if (retained.length !== groups.length) await writeFile(storage, GROUPS, retained);
        }
        return ok;
      } catch (error) { return fail(error, 'Could not clear the Postiz connection. Try disconnecting again.'); }
    }),
    loadChannels: async ([instance], store, storage) => {
      if (!instance) return [];
      await mutating;
      const generation = connectionGeneration;
      const current = await requireSession(store, storage, instance);
      const client = source(current);
      const channels = await boundedMap(await client.integrations(), async integration =>
        channelFor(client.instance, integration, await client.schema(integration.id)));
      if (generation !== connectionGeneration) throw new PostizError('The Postiz connection changed. Refresh the channels.');
      return channels;
    },
    findMentions: async ([instance, channelId, query], store, storage) => {
      const vanity = linkedinVanity(query);
      if (!instance || !channelId || !vanity) return [];
      await mutating;
      const generation = connectionGeneration;
      const current = await requireSession(store, storage, instance);
      const client = source(current);
      const channel = (await client.integrations()).find(row => row.id === channelId);
      if (!channel || !isLinkedIn(networkOf(channel.identifier)) || !(await client.schema(channelId)).mentionTool) return [];
      let matches: Awaited<ReturnType<Client['mentions']>>;
      try { matches = await client.mentions(channelId, vanity); }
      catch (error) {
        if (error instanceof PostizError && error.status === 404) return [];
        throw error;
      }
      if (generation !== connectionGeneration) throw new PostizError('The Postiz connection changed. Search again.');
      return matches.filter(row => /^\d+$/.test(row.id)).map(row => ({
        id: row.id, name: row.label, handle: vanity, avatar: assetUrl(instance, row.image ?? ''),
        token: linkedinToken(row.id, row.label),
      }));
    },
    loadPosts: async ([instance, from, to], store, storage) => {
      if (!instance) return { owner: instance, posts: [] };
      await mutating;
      const generation = connectionGeneration;
      const current = await requireSession(store, storage, instance);
      const client = source(current);
      const [rows, groups] = await Promise.all([client.calendar(from, to), listGroups(storage)]);
      const byId = new Map<string, string>();
      for (const group of groups.filter(row => belongsTo(row, current))) {
        for (const id of group.ids) byId.set(id, group.group);
      }
      const details = new Map(await boundedMap([...new Set(rows.map(row => row.id))], async id => {
        const chain = await client.preview(id);
        const [root] = chain;
        if (!root) throw new PostizError('A post changed while loading the calendar. Refresh to try again.');
        return [id, chain] as const;
      }));
      const posts = rows.map(row => {
        const chain = details.get(row.id)!;
        if (chain[0].group !== row.group || chain[0].channelId !== row.channelId || chain[0].parentId) {
          throw new PostizError('A post changed while loading the calendar. Refresh to try again.');
        }
        return asPost(instance, row, chain, byId.get(row.id) ?? row.group);
      }).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
      if (generation !== connectionGeneration) throw new PostizError('The Postiz connection changed. Refresh the calendar.');
      recent.set(sessionKey(current), new Map(rows.map(row => [row.id, row])));
      return { owner: instance, posts };
    },
    submitPost: ([mode, at, group, targets, media, now], store, storage, native) => mutate(async (): Promise<Sent> => {
      const outcomes: Outcome[] = targets.map(target => ({ channelId: target.channelId, ok: false, error: '' }));
      const refuse = (error: string) => ({ ok: false, error, outcomes: outcomes.map(row => ({ ...row, error: row.error || error })) });
      let writing = false;
      let selected: { id: string; name: string; identifier: string }[] = [];
      try {
        if (!targets.length) return refuse('Choose at least one destination.');
        if (new Set(targets.map(target => target.channelId)).size !== targets.length) return refuse('Choose each destination once.');
        if (mode !== 'draft' && mode !== 'schedule' && mode !== 'now') return refuse('Choose draft, schedule, or publish now.');
        const when = mode === 'now' || (mode === 'draft' && at === 0) ? now : at;
        if (!Number.isFinite(when) || !Number.isFinite(now) || (mode === 'schedule' && when <= now)) {
          return refuse('Choose a valid date and time in the future.');
        }
        const date = new Date(when).toISOString();
        const current = await requireSession(store, storage);
        const client = source(current);
        const [accounts, groups] = await Promise.all([client.integrations(), listGroups(storage)]);
        selected = accounts.filter(account => targets.some(target => target.channelId === account.id));
        const previous = await oldPosts(client, current, groups, group, now, when);
        const firstTags = previous[0]?.[0].tags ?? [];
        if (previous.some(thread => JSON.stringify(thread[0].tags) !== JSON.stringify(firstTags))) {
          return refuse('These posts use different tags. Edit them individually in Postiz.');
        }
        const body: CreatePost = { type: mode, date, tags: firstTags, shortLink: false, posts: [] };
        const includeAlt = new Set<string>();

        for (const [index, target] of targets.entries()) {
          const account = accounts.find(row => row.id === target.channelId);
          try {
            if (!account) throw new PostizError('This destination is disconnected or disabled in Postiz.');
            const schema = await client.schema(account.id);
            const channel = channelFor(current.instance, account, schema);
            const [root, ...replies] = previous.find(thread => thread[0].channelId === target.channelId) ?? [];
            const followUps = followUpText(channel, target);
            const settings = toSettings(channel, schema, account.identifier, target, media, mode === 'draft', root?.settings);
            if (supportsImageAlt(channel.network, settings)) {
              if (channel.network === 'instagram' && media.some(item => item.kind === 'image' && (item.alt?.length ?? 0) > 1000)) {
                throw new PostizError('Instagram image alt text allows up to 1000 characters.');
              }
              includeAlt.add(account.id);
            }
            const canRotateGroup = root && previous.filter(thread => thread[0].group === root.group).length === 1;
            const encode = isLinkedIn(channel.network) ? encodeLinkedInContent : (value: string) => value;
            const keep = channel.threads ? [] : channel.comments ? replies.slice(1) : replies;
            if (channel.comments && keep.length && !followUps.length) {
              throw new PostizError('This post has more than one comment. To remove the first comment, edit it in Postiz.');
            }
            if (root && !canRotateGroup && followUps.length + keep.length < replies.length) {
              throw new PostizError('This post shares its Postiz group with another destination. Remove follow-ups in Postiz.');
            }
            const children = followUps.map((text, index) => {
              const old = replies[index];
              if (!text.trim() && !old?.image?.length) throw new PostizError(`Add text to ${channel.networkName} ${channel.threads ? `thread post ${index + 2}` : 'first comment'}.`);
              const visible = visiblePostContent(text);
              const length = channel.network === 'threads' ? Array.from(visible).length : visible.length;
              if (mode !== 'draft' && channel.limit && length > channel.limit) {
                throw new PostizError(`${channel.networkName} allows up to ${channel.limit} characters per ${channel.threads ? 'thread post' : 'comment'}.`);
              }
              return { content: encode(text), image: old?.image ?? [], id: old?.id, delay: old?.delay };
            });
            body.posts.push({
              integration: { id: account.id },
              ...(canRotateGroup ? { group: root.group } : {}),
              value: [
                { content: encode(target.text), image: [], ...(root ? { id: root.id, delay: root.delay } : {}) },
                ...children,
                ...keep.map(row => ({ id: row.id, delay: row.delay, content: row.text, image: row.image ?? [] })),
              ],
              settings,
            });
          } catch (error) { outcomes[index].error = fail(error, 'Could not prepare this destination.').error; }
        }
        // a group edit keeps every old row if any destination fails local validation.
        if (outcomes.some(row => row.error)) return refuse('Fix the destination settings before sending.');

        const files = new Map<string, RemoteMedia>();
        const image: RemoteMedia[] = [];
        for (const item of media) {
          const key = item.path || item.url;
          if (!files.has(key)) files.set(key, await upload(client, storage, item, current.key, native));
          image.push(files.get(key)!);
        }
        for (const post of body.posts) post.value[0].image = includeAlt.has(post.integration.id) ? image.map((file, index) => {
          const item = media[index];
          return item.kind === 'image' && !isVideo(file.path) && item.alt?.trim() ? { ...file, alt: item.alt } : file;
        }) : image;

        writing = true;
        const acknowledgements = await client.create(body);
        for (const outcome of outcomes) {
          const matches = acknowledgements.filter(ack => ack.integration === outcome.channelId);
          const id = matches[0]?.postId;
          const old = previous.find(thread => thread[0].channelId === outcome.channelId)?.[0];
          if (matches.length === 1 && (!old || id === old.id) &&
              acknowledgements.filter(ack => ack.postId === id).length === 1) outcome.ok = true;
          else outcome.error = 'Postiz did not confirm this destination. Check the queue before trying again.';
        }

        const ids = new Set(previous.map(thread => thread[0].id));
        for (const ack of acknowledgements) {
          if (outcomes.some(row => row.channelId === ack.integration && row.ok)) ids.add(ack.postId);
        }
        let cleanupError = '';
        const removed = previous.filter(thread => !targets.some(target => target.channelId === thread[0].channelId));
        if (outcomes.every(row => row.ok)) {
          for (const [root] of removed) {
            if (!ids.has(root.id)) continue;
            try {
              await client.remove(root.id);
              for (const [other] of removed.filter(thread => thread[0].group === root.group)) ids.delete(other.id);
            } catch {
              cleanupError = 'Postiz saved the selected destinations but did not confirm removal of an old destination. Refresh and check the group.';
            }
          }
        }

        // public post rows expose per-destination groups. keep the confirmed ids for compositions made on this device.
        const wasIndexed = groups.some(row => row.group === group && belongsTo(row, current));
        if (ids.size > 1 || wasIndexed) {
          const alias = wasIndexed ? group : 'exact:' + [...ids][0];
          const entries = groups.filter(row => row.group !== alias || !belongsTo(row, current));
          if (ids.size) entries.push({ instance: current.instance, principal: current.principal, group: alias, ids: [...ids] });
          try { await writeFile(storage, GROUPS, entries); } catch {
            cleanupError ||= 'Postiz saved confirmed destinations, but this device could not save their group. Refresh and check the queue.';
          }
        }
        const all = outcomes.every(row => row.ok);
        return { ok: all && !cleanupError, error: cleanupError || (all ? '' : 'Postiz confirmed only the destinations marked successful. Check the queue before retrying.'), outcomes };
      } catch (error) {
        const message = fail(error, 'Could not send the post. Check the connection, settings, and attachments.').error;
        if (writing && error instanceof PostizError && error.destination) {
          const destination = error.destination;
          const ids = 'index' in destination ? [targets[destination.index]?.channelId] :
            selected.filter(account => account.identifier === destination.provider &&
              [account.name, networkOf(account.identifier)].some(name => name.toLowerCase() === destination.name.toLowerCase()))
              .map(account => account.id);
          if (ids.some(id => id !== undefined)) {
            for (const outcome of outcomes) if (ids.includes(outcome.channelId)) outcome.error = message;
            return refuse('Postiz rejected a destination before saving. Review its settings and try again.');
          }
        }
        const uncertain = writing && (!(error instanceof PostizError) || ![400, 401, 403, 404, 413, 422, 429].includes(error.status));
        return refuse(uncertain ? message + ' Check each destination in the queue before retrying.' : message);
      }
    }),
    deletePost: ([id], store, storage) => mutate(async () => {
      try {
        const current = await requireSession(store, storage);
        await source(current).remove(id);
        return ok;
      } catch (error) { return fail(error, 'Postiz could not confirm deletion. Refresh the queue before trying again.'); }
    }),
  };
}

export let sources = createSources();

export const findMentions: Sources['findMentions'] = (args, store, storage, native) =>
  sources.findMentions(args, store, storage, native);

export function configureDemo(address: string): void {
  sources = createSources(address && address !== 'off' ? instanceAddress(address) : '');
}
