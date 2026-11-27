// the postiz half of the data module. this file is a stand-in with sample accounts and
// posts, so the screens have something to draw until the real client replaces it.
import type { Result, Sources } from '../app.contract.d.ts';

type Channel = Result<'loadChannels'>[number];
type Post = Result<'loadPosts'>['posts'][number];
type Field = Channel['fields'][number];


const DEMO = 'https://demo.invalid';
let instance = DEMO;

const field = (key: string, label: string, kind: string, options: [string, string][] = [], initial = '', hint = ''): Field =>
  ({ key, label, kind, options: options.map(([value, text]) => ({ value, label: text })), required: false, initial, hint, max: 0 });

const channels: Channel[] = [
  { id: 'c-x', name: 'expo', handle: '@expo', network: 'x', networkName: 'X', avatar: '', limit: 280, needsMedia: false,
    fields: [field('who_can_reply_post', 'Who Can Reply', 'choice', [['everyone', 'Everyone'], ['following', 'Accounts You Follow'], ['mentionedUsers', 'Mentioned Only']], 'everyone')] },
  { id: 'c-ig', name: 'expo.dev', handle: '@expo.dev', network: 'instagram', networkName: 'Instagram', avatar: '', limit: 2200, needsMedia: true,
    fields: [field('post_type', 'Format', 'choice', [['post', 'Post'], ['reel', 'Reel'], ['story', 'Story']], 'post'),
      field('collaborators', 'Collaborators', 'list', [], '', 'Up to 3 accounts')] },
  { id: 'c-li', name: 'Expo', handle: 'expo-dev', network: 'linkedin', networkName: 'LinkedIn', avatar: '', limit: 3000, needsMedia: false,
    fields: [field('post_as_images_carousel', 'Post Images as a Carousel', 'bool', [], 'false')] },
  { id: 'c-tt', name: 'expo.dev', handle: '@expo.dev', network: 'tiktok', networkName: 'TikTok', avatar: '', limit: 2000, needsMedia: true,
    fields: [field('privacy_level', 'Who Can See This', 'choice', [['PUBLIC_TO_EVERYONE', 'Everyone'], ['MUTUAL_FOLLOW_FRIENDS', 'Friends'], ['SELF_ONLY', 'Only Me']], 'PUBLIC_TO_EVERYONE'),
      field('comment', 'Allow Comments', 'bool', [], 'true')] },
  { id: 'c-bs', name: 'expo.dev', handle: '@expo.dev', network: 'bluesky', networkName: 'Bluesky', avatar: '', limit: 300, needsMedia: false, fields: [] },
  { id: 'c-th', name: 'expo.dev', handle: '@expo.dev', network: 'threads', networkName: 'Threads', avatar: '', limit: 500, needsMedia: false, fields: [] },
];

const HOUR = 3600000, DAY = 24 * HOUR;
let posts: Post[] | null = null;
const seed = (now: number): Post[] => {
  const day = Math.floor(now / DAY) * DAY;
  const p = (id: string, channelId: string, at: number, status: string, text: string, error = ''): Post =>
    ({ id, group: id, channelId, text, at, status, media: [], settings: [], link: status === 'sent' ? 'https://example.com/p/' + id : '', error });
  return [
    p('s1', 'c-x', day - 2 * DAY + 15 * HOUR, 'sent', 'Exact for web is here. One codebase, every platform, and nothing in between.'),
    p('s2', 'c-li', day - DAY + 16 * HOUR, 'sent', 'Coding agents write mobile code faster than any team can review it. Here is how we changed the review loop.'),
    p('s3', 'c-ig', day - DAY + 22 * HOUR, 'sent', 'i can finally touch grass (or snow) #agenticworkflows #mobiledev'),
    p('q1', 'c-x', day + 19 * HOUR, 'queue', 'Shipping a small thing today: cloud simulators you can share with a link.'),
    p('q2', 'c-li', day + 19 * HOUR, 'queue', 'Shipping a small thing today: cloud simulators you can share with a link. A short thread on why we built it.'),
    p('q3', 'c-bs', day + DAY + 14 * HOUR, 'queue', 'What is the smallest change that made your release week calmer?'),
    p('q4', 'c-th', day + 3 * DAY + 17 * HOUR, 'queue', 'Launch week recap, in five posts.'),
    p('q5', 'c-tt', day + 4 * DAY + 20 * HOUR, 'error', 'Behind the scenes of the launch video.', 'TikTok needs a video.'),
    p('d1', 'c-x', day + 5 * DAY + 12 * HOUR, 'draft', 'rami video post'),
    p('d2', 'c-ig', day + 5 * DAY + 12 * HOUR, 'draft', 'rami video post'),
  ];
};

export const sources: Pick<Sources, 'loadConnection' | 'connect' | 'disconnect' | 'loadChannels' | 'loadPosts' | 'submitPost' | 'deletePost'> = {
  loadConnection: () => (instance === '' ? { state: 'none', instance: '', workspace: '', error: '' } : { state: 'ready', instance, workspace: 'Demo', error: '' }),
  connect: ([url, key]) => {
    if (!url.startsWith('https://')) return { ok: false, error: 'Enter the HTTPS address of your Postiz instance.' };
    if (key.trim() === '') return { ok: false, error: 'Enter a Postiz API key.' };
    instance = url;
    return { ok: true, error: '' };
  },
  disconnect: () => { instance = ''; return { ok: true, error: '' }; },
  loadChannels: ([owner]) => (owner === '' ? [] : channels),
  loadPosts: ([owner, from, to]) => {
    if (owner === '') return { owner, posts: [] };
    posts ??= seed((from + to) / 2);
    return { owner, posts: posts.filter((p) => p.at >= from && p.at < to).sort((a, b) => a.at - b.at) };
  },
  submitPost: ([mode, at, group, targets, media, now]) => {
    const all = posts ?? [];
    const kept = group === '' ? all : all.filter((p) => p.group !== group);
    const id = `n${now}`;
    posts = kept.concat(targets.map((t, i) => ({ id: `${id}-${i}`, group: id, channelId: t.channelId, text: t.text,
      at: mode === 'now' ? now : at, status: mode === 'draft' ? 'draft' : mode === 'now' ? 'sent' : 'queue', media, settings: t.settings, link: '', error: '' })));
    return { ok: true, error: '', outcomes: targets.map((t) => ({ channelId: t.channelId, ok: true, error: '' })) };
  },
  deletePost: ([id]) => {
    const hit = (posts ?? []).find((p) => p.id === id);
    posts = (posts ?? []).filter((p) => p.group !== hit?.group);
    return { ok: true, error: '' };
  },
};
