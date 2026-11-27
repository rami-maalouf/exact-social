export type Integration = {
  id: string;
  name: string;
  identifier: string;
  profile?: string | null;
  disabled?: boolean;
};

function isIntegration(value: unknown): value is Integration {
  if (!value || typeof value !== 'object') return false;
  return 'id' in value && typeof value.id === 'string'
    && 'name' in value && typeof value.name === 'string'
    && 'identifier' in value && typeof value.identifier === 'string'
    && (!('disabled' in value) || typeof value.disabled === 'boolean')
    && (!('profile' in value) || value.profile == null || typeof value.profile === 'string');
}

export function postizClient(instance: string, apiKey: string) {
  const base = new URL(instance);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('Enter the HTTPS address of your Postiz instance.');
  }
  if (!apiKey.trim()) throw new Error('Enter a Postiz workspace API key.');
  base.pathname = base.pathname.replace(/\/$/, '') + '/api/public/v1/';

  async function read(path: string): Promise<unknown> {
    const response = await fetch(new URL(path, base).href, {
      headers: { Authorization: apiKey.trim() },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Postiz request failed (HTTP ${response.status}).`);
    return response.json();
  }

  return {
    async channels(): Promise<Integration[]> {
      const data = await read('integrations');
      if (!Array.isArray(data) || !data.every(isIntegration)) {
        throw new Error('Unexpected Postiz integrations response.');
      }
      return data.filter(channel => !channel.disabled);
    },
    async posts(start: Date, end: Date): Promise<unknown[]> {
      if (!(start < end)) throw new Error('Choose a valid calendar window.');
      const query = new URLSearchParams({ startDate: start.toISOString(), endDate: end.toISOString() });
      const data = await read(`posts?${query}`);
      if (!data || typeof data !== 'object' || !('posts' in data) || !Array.isArray(data.posts)) {
        throw new Error('Unexpected Postiz calendar response.');
      }
      return data.posts;
    },
  };
}
