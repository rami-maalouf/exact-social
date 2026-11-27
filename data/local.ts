// the device half of the data module: drafts and templates kept in files, the media a
// person picked copied where it survives a relaunch, and a day and time read as an instant.
import type { Result, Sources, Storage } from '../app.contract.d.ts';

const DRAFTS = 'app:/data/drafts.json';
const TEMPLATES = 'app:/data/templates.json';
const MEDIA = 'app:/data/media';

type Draft = Result<'loadDrafts'>[number];
type Template = Result<'loadTemplates'>[number];
type Media = Result<'keepMedia'>['media'][number];
type Reply = Result<'removeDraft'>;

const done: Reply = { ok: true, error: '' };
const cache: { drafts: Draft[] | null; templates: Template[] | null } = { drafts: null, templates: null };

async function read<T>(storage: Storage, file: string): Promise<T[]> {
  return storage.fs.readFile(file).then(
    (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as T[],
    (e) => { if (e.code === 'ENOENT') return []; throw e; }); // no file yet; 'bake' (the build) passes through
}
const write = (storage: Storage, file: string, rows: unknown[]) =>
  storage.fs.atomicWriteFile(file, new TextEncoder().encode(JSON.stringify(rows)));

const drafts = async (storage: Storage) => (cache.drafts ??= await read<Draft>(storage, DRAFTS));
const templates = async (storage: Storage) => (cache.templates ??= await read<Template>(storage, TEMPLATES));
const nextId = (rows: { id: string }[]) => String(Math.max(0, ...rows.map((r) => Number(r.id) || 0)) + 1);

const extension = (name: string, type: string) => {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && name.length - dot <= 6) return name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
  return type.startsWith('video/') ? 'mp4' : 'jpg';
};

// how far `zone` is ahead of utc at an instant, in milliseconds.
function offsetAt(at: number, zone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(at));
    const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute')) - Math.floor(at / 60000) * 60000;
  } catch { return 0; } // an unknown zone reads as utc
}

export const sources: Pick<Sources, 'loadDrafts' | 'saveDraft' | 'removeDraft' | 'loadTemplates' | 'saveTemplate' | 'removeTemplate' | 'keepMedia' | 'planInstant'> = {
  // newest edit first.
  loadDrafts: async (_args, _store, storage) => [...(await drafts(storage))].sort((a, b) => b.updatedAt - a.updatedAt),
  saveDraft: async ([id, text, channels, media, settings, tailored, timing, day, clock, now], _store, storage): Promise<Result<'saveDraft'>> => {
    const all = await drafts(storage);
    const next: Draft = { id: id === '' ? nextId(all) : id, text, channels, media, settings, tailored, timing, day, clock, updatedAt: now };
    const rows = all.some((d) => d.id === next.id) ? all.map((d) => (d.id === next.id ? next : d)) : [...all, next];
    await write(storage, DRAFTS, rows);
    cache.drafts = rows;
    return done;
  },
  removeDraft: async ([id], _store, storage) => {
    const rows = (await drafts(storage)).filter((d) => d.id !== id);
    await write(storage, DRAFTS, rows);
    cache.drafts = rows;
    return done;
  },
  loadTemplates: async (_args, _store, storage) => [...(await templates(storage))].sort((a, b) => b.updatedAt - a.updatedAt),
  saveTemplate: async ([id, title, text, now], _store, storage): Promise<Result<'saveTemplate'>> => {
    if (text.trim() === '') return { ok: false, error: 'A template needs some text.' };
    const all = await templates(storage);
    const name = title.trim() === '' ? text.trim().split('\n')[0].slice(0, 40) : title.trim();
    const next: Template = { id: id === '' ? nextId(all) : id, title: name, text, updatedAt: now };
    const rows = all.some((t) => t.id === next.id) ? all.map((t) => (t.id === next.id ? next : t)) : [...all, next];
    await write(storage, TEMPLATES, rows);
    cache.templates = rows;
    return done;
  },
  removeTemplate: async ([id], _store, storage) => {
    const rows = (await templates(storage)).filter((t) => t.id !== id);
    await write(storage, TEMPLATES, rows);
    cache.templates = rows;
    return done;
  },
  // a picked file is a copy in scratch space; a draft may outlive it, so it moves under data.
  keepMedia: async ([paths, names, types, now], _store, storage): Promise<Result<'keepMedia'>> => {
    const media: Media[] = [];
    try {
      await storage.fs.mkdir(MEDIA).catch(() => undefined);
      for (let i = 0; i < paths.length; i++) {
        const type = types[i] ?? '', name = names[i] ?? 'file';
        if (!type.startsWith('image/') && !type.startsWith('video/')) return { ok: false, error: `${name} is not a photo or a video.`, media: [] };
        const id = `m${now}-${i}`;
        const path = `${MEDIA}/${id}.${extension(name, type)}`;
        await storage.fs.copyFile(paths[i], path);
        media.push({ id, kind: type.startsWith('video/') ? 'video' : 'image', name, path, url: '', alt: '' });
      }
    } catch (e) {
      if ((e as { code?: string }).code === 'bake') throw e;
      return { ok: false, error: 'Could not add that file. Try again.', media: [] };
    }
    return { ok: true, error: '', media };
  },
  // a day ("2026-03-14") and a time ("09:30") on the wall clock of `zone` (an IANA name),
  // daylight saving included: the zone's offset is read at the instant itself.
  planInstant: ([day, clock, zone]) => {
    const [y, m, d] = day.split('-').map(Number), [h, min] = clock.split(':').map(Number);
    const wall = Date.UTC(y, m - 1, d, h, min);
    if (!Number.isFinite(wall)) return { at: 0, valid: false };
    let at = wall - offsetAt(wall, zone);
    at = wall - offsetAt(at, zone); // the first guess can sit on the far side of a change
    return { at, valid: true };
  },
};
