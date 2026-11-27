export const abi = 1;
export const roster = {};

export async function later({ op, path, url, key, name, type, size }) {
  const endpoint = new URL(url);
  const loopback = endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname) && endpoint.port === '4786';
  if (op !== 'upload' || !(endpoint.protocol === 'https:' || loopback) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || !endpoint.pathname.endsWith('/api/public/v1/upload') ||
      !/^app:\/(data\/media|tmp\/picked)\/[^\\\0]+$/.test(path) ||
      path.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid upload.');

  // use the same file store and agent scratch namespace as the picker.
  const [{ storageKey }, { createFileStore }] = await Promise.all([
    import(new URL('../storage-environment.js', import.meta.url).href),
    import(new URL('../storage-fs.js', import.meta.url).href),
  ]);
  const scope = storageKey('com.rami.exact-social');
  if (!scope) throw new Error('No attachment storage is available.');
  const store = createFileStore(scope);
  try {
    const { blob } = await store.blob(path, type, 2 * 1024 ** 3, 'upload');
    if (!size || blob.size !== size) throw new Error('Attachment changed.');
    const body = new FormData();
    body.append('file', blob.slice(0, size, type), name);
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: key }, body, redirect: 'error', credentials: 'omit' });
    return { status: response.status, data: await response.json().catch(() => null) };
  } finally { store.close(); }
}
