import type { Answer, Sources } from './app.contract.d.ts';
import * as postiz from './data/postiz.ts';

// the build reads grants without running the module, so every half's lines are written here.
export const grants = ['secret.keep postiz-key'].join('\n');
const sources: Sources = { ...postiz.sources };
export const answer: Answer = (source, args, store, storage, native) => sources[source](args as never, store, storage, native);
