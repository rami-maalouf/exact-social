import type { Answer, Sources } from './app.contract.d.ts';
import * as local from './data/local.ts';
import * as postiz from './data/postiz.ts';

// the build reads grants without running the module, so every half's lines are written here.
export const grants = [
  'secret.keep postiz-key',
  'net.fetch https:',
  'development net.fetch http://127.0.0.1:4786',
  'development net.fetch http://localhost:4786',
  'fs.read app:/data', 'fs.write app:/data',
  'fs.read app:/tmp/picked',
].join('\n');
const POSTIZ_DEV_URL: string = import.meta.env.POSTIZ_DEV_URL ?? 'http://127.0.0.1:4786';
postiz.configureDemo(grants.split('\n').includes('net.fetch http://127.0.0.1:4786') && POSTIZ_DEV_URL !== 'off' ? POSTIZ_DEV_URL : '');
const sources: Sources = { ...postiz.sources, ...local.sources };
export const answer: Answer = (source, args, store, storage, native) => sources[source](args as never, store, storage, native);
