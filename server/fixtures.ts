import { deflateSync } from 'node:zlib';
import type { JsonObject } from '../data/postiz-client';

const manifest = [
  { id: 'c-x', name: 'Northstar Studio', profile: 'northstarstudio', identifier: 'x', color: [53, 92, 164] },
  { id: 'c-ig', name: 'Northstar Field Notes', profile: 'northstar.fieldnotes', identifier: 'instagram-standalone', color: [190, 91, 107] },
  { id: 'c-li', name: 'Jo Rivera', profile: 'jo-rivera', identifier: 'linkedin', color: [35, 133, 133] },
  { id: 'c-tt', name: 'Made at Northstar', profile: 'madeatnorthstar', identifier: 'tiktok', color: [153, 90, 171] },
  { id: 'c-bs', name: 'The Northstar Log', profile: 'northstarlog.example', identifier: 'bluesky', color: [49, 130, 205] },
  { id: 'c-th', name: 'Northstar Workshop', profile: 'northstar.workshop', identifier: 'threads', color: [181, 111, 49] },
  { id: 'c-yt', name: 'Northstar Films', profile: 'northstarfilms', identifier: 'youtube', color: [163, 59, 59] },
];

export const accounts = manifest.map(({ id, name, profile, identifier }) =>
  ({ id, name, profile, identifier, picture: '/uploads/avatar-' + id + '.png', disabled: false }));

const string = { type: 'string' };
const bool = { type: 'boolean' };
const choice = (...values: string[]) => ({ type: 'string', enum: values });
const array = { type: 'array' };
const object = { type: 'object' };

export type FixtureSchema = { maxLength: number; rules: string; settings: string | JsonObject; tools: unknown[] };
export const linkedinMentions = new Map([
  ['example-studio', { id: '101', label: 'Example & Studio', image: '/uploads/avatar-c-li.png' }],
  ['example-works', { id: '102', label: 'Example "<Works>"', image: '' }],
]);

const schema = (maxLength: number, properties?: JsonObject, required: string[] = []): FixtureSchema => ({
  maxLength, rules: '', settings: properties ? { type: 'object', properties, ...(required.length ? { required } : {}) } :
    'No additional settings required', tools: [],
});

export const schemas: Record<string, FixtureSchema> = {
  x: schema(280, { community: string, who_can_reply_post: choice('everyone', 'following', 'mentionedUsers', 'subscribers', 'verified'),
    post_type: choice('post', 'article'), article_title: string, article_status: choice('draft', 'published'), article_cover: object,
    made_with_ai: bool, paid_partnership: bool }),
  'instagram-standalone': schema(2200, { post_type: choice('post', 'story'), is_trial_reel: {},
    graduation_strategy: choice('MANUAL', 'SS_PERFORMANCE'), collaborators: array, audio: object }, ['post_type']),
  linkedin: { ...schema(3000, { post_as_images_carousel: bool, carousel_name: string }),
    tools: [{ methodName: 'mention', description: 'Find a company page by its exact LinkedIn vanity name.',
      dataSchema: [{ key: 'query', type: 'string', description: 'Company page vanity name' }] }] },
  tiktok: schema(2000, {
    title: { type: 'string', maxLength: 90 }, privacy_level: choice('PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'),
    duet: bool, stitch: bool, comment: bool, autoAddMusic: choice('yes', 'no'), brand_content_toggle: bool, video_made_with_ai: bool,
    brand_organic_toggle: bool, music: object, location: object, content_posting_method: choice('DIRECT_POST', 'UPLOAD'),
  }, ['privacy_level', 'duet', 'stitch', 'comment', 'autoAddMusic', 'brand_content_toggle', 'brand_organic_toggle', 'content_posting_method']),
  bluesky: schema(300),
  threads: schema(500),
  youtube: schema(5000, { title: { type: 'string', maxLength: 100 }, type: choice('public', 'unlisted', 'private'),
    tags: array, thumbnail: object, selfDeclaredMadeForKids: choice('yes', 'no') }, ['title', 'type']),
};

export type Asset = { bytes: Uint8Array; type: string };

function png(width: number, height: number, pixel: (x: number, y: number) => number[]): Asset {
  const size = Buffer.alloc(13);
  size.writeUInt32BE(width, 0);
  size.writeUInt32BE(height, 4);
  size[8] = 8;
  size[9] = 2;
  const pixels = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) pixels.set(pixel(x, y), y * (width * 3 + 1) + 1 + x * 3);
  }
  function chunk(name: string, data: Uint8Array) {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length);
    bytes.write(name, 4, 'ascii');
    bytes.set(data, 8);
    bytes.writeUInt32BE(Bun.hash.crc32(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
  }
  return {
    bytes: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', size),
      chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]),
    type: 'image/png',
  };
}

export const seedAssets = new Map<string, Asset>();
for (const { id, color } of manifest) {
  seedAssets.set('/uploads/avatar-' + id + '.png', png(64, 64, (x, y) => {
    const shape = Math.hypot(x - 32, y - 23) < 10 || Math.hypot(x - 32, (y - 52) * 1.4) < 20;
    return color.map(c => Math.min(255, c + (shape ? 73 : Math.floor((x + y) / 5))));
  }));
}
for (const [index, name] of ['field-notes', 'workbench'].entries()) {
  seedAssets.set('/uploads/' + name + '.png', png(180, 140, (x, y) => {
    const ridge = 68 + Math.sin(x / 22 + index) * 22 + Math.cos(x / 13) * 13;
    const sun = Math.hypot(x - (index ? 42 : 122), y - 43) < 17;
    return sun ? [255, 225, 158] : y < ridge ? [115 + Math.floor(y / 3), 163, 188] :
      [61 + index * 44, 93 + Math.floor((y - ridge) / 2), 88];
  }));
}

export type FixturePost = {
  id: string; group: string; content: string; publishDate: string; state: 'QUEUE' | 'DRAFT' | 'PUBLISHED' | 'ERROR';
  releaseURL: string | null; releaseId: string | null; error: string | null; intervalInDays: null;
  integration: { id: string; name: string; providerIdentifier: string; picture: string };
  parentPostId?: string; delay?: number; tags: { tag: { id: string; name: string } }[];
  creationMethod: 'API'; settings: string; image: string;
};

const HOUR = 3600000;
const DAY = 24 * HOUR;

export function fixturePosts(now: number): FixturePost[] {
  const day = Math.floor(now / DAY) * DAY;
  function post(id: string, channel: string, offset: number, state: FixturePost['state'], content: string,
    time: number, asset?: string, group = 'g-' + id): FixturePost {
    const { identifier, name, picture } = accounts.find(account => account.id === channel)!;
    return {
      id, group, state, content, publishDate: new Date(day + DAY * offset + HOUR * time).toISOString(),
      releaseURL: state === 'PUBLISHED' ? 'https://example.com/posts/' + id : null, releaseId: state === 'PUBLISHED' ? id : null,
      error: state === 'ERROR' ? 'TikTok rejected the video. Check the format and try again.' : null,
      intervalInDays: null, creationMethod: 'API', tags: [],
      integration: { id: channel, name, providerIdentifier: identifier, picture },
      settings: JSON.stringify({ __type: identifier, ...(identifier === 'instagram-standalone' ? { post_type: 'post' } : {}) }),
      image: JSON.stringify(asset ? [{ id: asset, path: '/uploads/' + asset + '.png',
        ...(channel === 'c-ig' ? { alt: 'A sun rising above the trail.' } : {}) }] : []),
    };
  }
  return [
    post('s1', 'c-x', -3, 'PUBLISHED', 'Our field guide to a calmer launch week is out today.', 16),
    post('s2', 'c-li', -2, 'PUBLISHED', 'The review that changed how we plan studio releases.', 15, 'workbench'),
    post('s3', 'c-ig', -1, 'PUBLISHED', 'First light on the trail. A few pages from this week’s field notes.', 18, 'field-notes'),
    post('q1', 'c-x', 0, 'QUEUE', 'Shipping a small thing today. A better way to share work in progress.', 21),
    { ...post('q1-reply', 'c-x', 0, 'QUEUE', 'We started by sharing a rough draft with one small team.', 21, undefined, 'g-q1'), parentPostId: 'q1' },
    post('q2', 'c-li', 1, 'QUEUE', 'A look at the prototype and what we learned from the first week.', 19),
    { ...post('q2-comment', 'c-li', 1, 'QUEUE', 'Thanks to the folks who helped us test the prototype.', 19, undefined, 'g-q2'), parentPostId: 'q2' },
    post('q3', 'c-bs', 2, 'QUEUE', 'What is the smallest change that made your release week calmer?', 14),
    post('q4', 'c-th', 4, 'QUEUE', 'Five things we learned in the workshop this week.', 17),
    post('q5', 'c-tt', 5, 'ERROR', 'Behind the scenes at the workshop.', 20),
    post('d1', 'c-x', 5, 'DRAFT', 'A quick preview of the December field guide.', 12, undefined, 'g-drafts'),
    post('d2', 'c-ig', 5, 'DRAFT', 'A first look at the December field guide.', 12, 'field-notes', 'g-drafts'),
  ];
}
