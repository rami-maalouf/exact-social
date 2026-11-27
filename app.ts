import type { Answer, Result, Sources, Storage } from './app.contract.d.ts';
import { listChannels } from './channels.ts';

const FILE = 'app:/data/drafts.json';
export const grants = [`fs.read ${FILE}`, `fs.write ${FILE}`].join('\n');

// what the file keeps. a draft is local: nothing here says it was scheduled or sent.
type Stored = { id: string; text: string; channels: string[]; day: string; time: string; updatedAt: number };
type Section = Result<'loadQueue'>[number];
let drafts: Stored[] | null = null; // memory; the file is what survives a launch

async function load(storage: Storage): Promise<Stored[]> {
  if (!drafts) drafts = await storage.fs.readFile(FILE).then(
    (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as Stored[],
    (e) => { if (e.code === 'ENOENT') return []; throw e; }); // no file yet; 'bake' (the build) passes through
  return drafts;
}
async function save(storage: Storage, next: Stored[]): Promise<Result<'saveDraft'>> {
  await storage.fs.atomicWriteFile(FILE, new TextEncoder().encode(JSON.stringify(next)));
  drafts = next;
  return { ok: true, error: '' };
}

// a day key and a time as one instant, read as utc so the view formats it with offset 0.
const dayAt = (day: string): number => {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const planAt = (day: string, time: string): number => {
  if (day === '') return 0;
  const [h, min] = time === '' ? [0, 0] : time.split(':').map(Number);
  return dayAt(day) + h * 3600000 + min * 60000;
};

// the queue's order: drafts with no day first, newest edit first; then each planned day
// in turn, its untimed drafts before its timed ones.
async function queue(storage: Storage): Promise<Section[]> {
  const names = new Map((await listChannels()).map((c) => [c.id, c.name]));
  const all = await load(storage);
  const row = (d: Stored) => ({
    ...d,
    channelNames: d.channels.map((id) => names.get(id)).filter(Boolean).join(', '),
    planAt: planAt(d.day, d.time),
  });
  const undated = all.filter((d) => d.day === '').sort((a, b) => b.updatedAt - a.updatedAt);
  const days = [...new Set(all.filter((d) => d.day !== '').map((d) => d.day))].sort();
  const sections: Section[] = days.map((day) => ({
    key: day,
    dayAt: dayAt(day),
    drafts: all.filter((d) => d.day === day)
      .sort((a, b) => a.time.localeCompare(b.time) || a.updatedAt - b.updatedAt).map(row),
  }));
  if (undated.length > 0) sections.unshift({ key: '', dayAt: 0, drafts: undated.map(row) });
  return sections;
}

const sources: Sources = {
  loadQueue: (_args, _store, storage) => queue(storage),
  loadChannels: () => listChannels(),
  saveDraft: async ([id, text, channels, day, time, at], _store, storage) => {
    if (text.trim() === '') return { ok: false, error: 'A draft needs some text.' };
    const all = await load(storage);
    const next: Stored = { id, text: text.trim(), channels, day, time: day === '' ? '' : time, updatedAt: at };
    if (id === '') {
      next.id = String(Math.max(0, ...all.map((d) => Number(d.id))) + 1);
      return save(storage, [...all, next]);
    }
    if (!all.some((d) => d.id === id)) return { ok: false, error: 'This draft was deleted.' };
    return save(storage, all.map((d) => (d.id === id ? next : d)));
  },
  removeDraft: async ([id], _store, storage) => save(storage, (await load(storage)).filter((d) => d.id !== id)),
};
export const answer: Answer = (source, args, store, storage, native) => sources[source](args, store, storage, native);
