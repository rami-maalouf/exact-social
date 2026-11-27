export const DEMO_KEY = 'exact-social-dev';
export const API_PATH = '/api/public/v1';
export const PREVIEW_PATH = '/api/public/posts';

export type JsonObject = Record<string, unknown>;
export const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
export const optionalText = (value: unknown): value is string | null | undefined =>
  value == null || typeof value === 'string';

export class PostizError extends Error {
  constructor(message: string, readonly status = 0,
    readonly destination?: { provider: string; name: string } | { index: number }) { super(message); }
}

export const invalidResponse = () =>
  new PostizError('The address returned an unexpected response. Check that it serves the Postiz public API.');

export function instanceAddress(value: string): string {
  const invalid = () => new PostizError('Enter the HTTPS address of your Postiz instance, such as https://postiz.example.com.');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw invalid(); }
  const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash || url.href.includes('?') || url.href.includes('#')) {
    throw invalid();
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/public\/v1$/, '');
  return url.origin + path;
}

export function assetUrl(instance: string, value: string, httpsOnly = false): string {
  if (!value) return '';
  try {
    const url = new URL(value, instance + '/');
    if (url.username || url.password) return '';
    if (url.protocol === 'https:' || (!httpsOnly && url.protocol === 'http:' &&
      url.origin === new URL(instance).origin && ['127.0.0.1', 'localhost'].includes(url.hostname))) return url.href;
  } catch { /* an invalid URL cannot be displayed or sent */ }
  return '';
}

export type Integration = {
  id: string;
  name: string;
  identifier: string;
  profile?: string | null;
  picture?: string | null;
  disabled?: boolean;
};

function isIntegration(value: unknown): value is Integration {
  return isObject(value) && nonempty(value.id) && nonempty(value.name) && nonempty(value.identifier)
    && optionalText(value.profile) && optionalText(value.picture)
    && (value.disabled === undefined || typeof value.disabled === 'boolean');
}

export type RemoteMedia = { id: string; path: string; alt?: string; thumbnail?: string };
export const isMedia = (value: unknown): value is RemoteMedia =>
  isObject(value) && nonempty(value.id) && nonempty(value.path) &&
  optionalText(value.alt) && optionalText(value.thumbnail);

const STATUS = { QUEUE: 'queue', DRAFT: 'draft', PUBLISHED: 'sent', ERROR: 'error' } as const;

export type RemotePost = {
  id: string;
  group: string;
  channelId: string;
  text: string;
  at: number;
  status: string;
  link: string;
  error: string;
  settings: JsonObject;
  image: RemoteMedia[] | undefined;
  delay: number | undefined;
  tags: { label: string; value: string }[];
};

function jsonField(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { throw invalidResponse(); }
}

function parsePost(raw: unknown): RemotePost {
  if (!isObject(raw) || !nonempty(raw.id) || !nonempty(raw.group) || typeof raw.content !== 'string' ||
      !nonempty(raw.publishDate) || typeof raw.state !== 'string' || !Object.hasOwn(STATUS, raw.state) ||
      !optionalText(raw.releaseURL) || !optionalText(raw.error) ||
      (raw.delay !== undefined && typeof raw.delay !== 'number')) throw invalidResponse();
  const channelId = isObject(raw.integration) ? raw.integration.id : raw.integrationId;
  const at = Date.parse(raw.publishDate);
  const settings = jsonField(raw.settings ?? {});
  const image = jsonField(raw.image);
  if (!nonempty(channelId) || !Number.isFinite(at) || !isObject(settings) ||
      (image != null && (!Array.isArray(image) || !image.every(isMedia)))) throw invalidResponse();
  const tags: RemotePost['tags'] = [];
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags)) throw invalidResponse();
    for (const entry of raw.tags) {
      if (!isObject(entry) || !isObject(entry.tag) || !nonempty(entry.tag.id) || !nonempty(entry.tag.name)) {
        throw invalidResponse();
      }
      tags.push({ value: entry.tag.id, label: entry.tag.name });
    }
  }
  return {
    id: raw.id, group: raw.group, channelId, text: raw.content, at, status: STATUS[raw.state as keyof typeof STATUS],
    link: raw.releaseURL ?? '', error: raw.error ?? '', settings, image: image === undefined ? undefined : image ?? [],
    delay: raw.delay, tags,
  };
}

export type SettingsSchema = { maxLength: number; properties: JsonObject; required: string[] };

export type CreatePost = {
  type: 'draft' | 'schedule' | 'now';
  date: string;
  tags: RemotePost['tags'];
  shortLink: boolean;
  posts: {
    integration: { id: string };
    group?: string;
    value: { id?: string; delay?: number; content: string; image: RemoteMedia[] }[];
    settings: JsonObject;
  }[];
};

export type Acknowledgement = { postId: string; integration: string };

export function postizClient(address: string, apiKey: string, network: typeof fetch = fetch, timeout = 15000) {
  const instance = instanceAddress(address);
  const key = apiKey.trim();
  if (!key || /[\r\n]/.test(key)) throw new PostizError('Enter a Postiz workspace API key from Settings.');

  async function request(path: string, options: RequestInit = {}, deadline = timeout): Promise<unknown> {
    const headers = new Headers(options.headers);
    if (path.startsWith(API_PATH + '/')) headers.set('Authorization', key);
    let response: Response;
    try {
      response = await network(instance + path, { ...options, headers, redirect: 'error', exactTimeout: deadline });
    } catch (error) {
      if (isObject(error) && (error.kind === 'Timeout' || error.name === 'TimeoutError')) {
        throw new PostizError('Postiz took too long to answer. Check the connection and try again.');
      }
      throw new PostizError('Could not reach Postiz. Check the address, connection, and browser access.');
    }
    if (!response.ok) {
      const status = response.status;
      if (status === 401 || status === 403) throw new PostizError('Postiz rejected this API key. Copy the workspace API key from Settings and reconnect.', status);
      if (status === 404) throw new PostizError('Postiz could not find this item or API route. Check the instance address and version.', status);
      if (status === 429) throw new PostizError('Postiz is rate limiting requests. Wait before trying again.', status);
      if (status === 400 || status === 422) {
        const error: unknown = await response.json().catch(() => null);
        let destination: PostizError['destination'];
        if (isObject(error) && nonempty(error.provider) && nonempty(error.name)) {
          destination = { provider: error.provider, name: error.name };
        } else if (isObject(error) && Array.isArray(error.message)) {
          const index = error.message.filter(nonempty).map(message => /^posts\.(\d+)\./.exec(message)?.[1]).find(Boolean);
          if (index !== undefined) destination = { index: Number(index) };
        }
        throw new PostizError('Postiz rejected the request. Check the destination settings and attachments.', status, destination);
      }
      if (status === 413) throw new PostizError('The attachment exceeds the upload limit on this server.', status);
      throw new PostizError(`Postiz returned HTTP ${status}. Check the server and try again.`, status);
    }
    try { return await response.json(); } catch { throw invalidResponse(); }
  }

  async function integrations(): Promise<Integration[]> {
    const data = await request(API_PATH + '/integrations');
    if (!Array.isArray(data) || !data.every(isIntegration) || new Set(data.map(row => row.id)).size !== data.length) {
      throw invalidResponse();
    }
    return data.filter(channel => !channel.disabled);
  }

  return {
    instance,
    integrations,
    async workspace(): Promise<{ id: string; name: string }> {
      const data = await request(API_PATH + '/me').catch(async error => {
        if (!(error instanceof PostizError) || error.status !== 404) throw error;
        await integrations();
        return { organization: { id: '', name: new URL(instance).hostname } };
      });
      if (!isObject(data) || !isObject(data.organization) ||
          typeof data.organization.id !== 'string' || typeof data.organization.name !== 'string') throw invalidResponse();
      return { id: data.organization.id, name: data.organization.name || new URL(instance).hostname };
    },
    async schema(id: string): Promise<SettingsSchema> {
      const data = await request(API_PATH + '/integration-settings/' + encodeURIComponent(id));
      if (!isObject(data) || !isObject(data.output) || typeof data.output.maxLength !== 'number' ||
          !Number.isFinite(data.output.maxLength) || data.output.maxLength < 0) throw invalidResponse();
      const settings = data.output.settings;
      if (settings === 'No additional settings required') return { maxLength: data.output.maxLength, properties: {}, required: [] };
      if (!isObject(settings) || (settings.properties !== undefined &&
          (!isObject(settings.properties) || !Object.values(settings.properties).every(isObject))) ||
          (settings.required !== undefined && (!Array.isArray(settings.required) || !settings.required.every(nonempty)))) {
        throw invalidResponse();
      }
      return { maxLength: data.output.maxLength, properties: (settings.properties as JsonObject | undefined) ?? {},
        required: (settings.required as string[] | undefined) ?? [] };
    },
    async calendar(from: number, to: number): Promise<RemotePost[]> {
      if (!Number.isFinite(from) || !Number.isFinite(to) || !(from < to)) {
        throw new PostizError('Choose a valid calendar date range.');
      }
      const query = new URLSearchParams({ startDate: new Date(from).toISOString(), endDate: new Date(to).toISOString() });
      const data = await request(API_PATH + '/posts?' + query);
      if (!isObject(data) || !Array.isArray(data.posts)) throw invalidResponse();
      return data.posts.map(parsePost).filter(post => post.at >= from && post.at < to);
    },
    async preview(id: string): Promise<RemotePost[]> {
      const data = await request(PREVIEW_PATH + '/' + encodeURIComponent(id));
      if (!Array.isArray(data)) throw invalidResponse();
      if (data.length === 0) return [];
      const posts = data.map(parsePost);
      if (posts[0].id !== id || posts.some(post => post.image === undefined ||
          post.group !== posts[0].group || post.channelId !== posts[0].channelId)) throw invalidResponse();
      return posts;
    },
    async create(body: CreatePost): Promise<Acknowledgement[]> {
      const data = await request(API_PATH + '/posts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const valid = (row: unknown): row is Acknowledgement =>
        isObject(row) && nonempty(row.postId) && nonempty(row.integration);
      if (!Array.isArray(data)) throw invalidResponse();
      // a partial response can still acknowledge individual destinations
      return data.filter(valid);
    },
    async upload(contentType: string, body: Uint8Array): Promise<RemoteMedia> {
      const data = await request(API_PATH + '/upload', {
        method: 'POST', headers: { 'Content-Type': contentType }, body: body as Uint8Array<ArrayBuffer>,
      }, 120000);
      if (!isMedia(data) || !assetUrl(instance, data.path)) throw invalidResponse();
      return { id: data.id, path: data.path };
    },
    async remove(id: string): Promise<void> {
      if (!nonempty(id)) throw new PostizError('Choose the post you want to delete.');
      const data = await request(API_PATH + '/posts/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!isObject(data) || !nonempty(data.id)) throw invalidResponse();
    },
  };
}

export type Client = ReturnType<typeof postizClient>;
