import type { Args, Result } from '../app.contract.d.ts';
import { assetUrl, isObject, nonempty, PostizError } from './postiz-client';
import type { Integration, JsonObject, RemoteMedia, SettingsSchema } from './postiz-client';

type Channel = Result<'loadChannels'>[number];
type Field = Channel['fields'][number];
type Media = Args<'submitPost'>[4][number];
type Target = Args<'submitPost'>[3][number];

export const networkOf = (provider: string) => {
  const name = provider.toLowerCase();
  if (name === 'instagram-standalone') return 'instagram';
  if (name === 'tiktok-business') return 'tiktok';
  if (name === 'twitter') return 'x';
  return name;
};

const NETWORK_NAMES: Record<string, string> = {
  x: 'X', instagram: 'Instagram', linkedin: 'LinkedIn', 'linkedin-page': 'LinkedIn Page', facebook: 'Facebook',
  threads: 'Threads', bluesky: 'Bluesky', tiktok: 'TikTok', youtube: 'YouTube', mastodon: 'Mastodon',
  pinterest: 'Pinterest', reddit: 'Reddit', discord: 'Discord', slack: 'Slack', telegram: 'Telegram',
};

const TITLE: Record<string, string> = {
  who_can_reply_post: 'Who can reply', post_type: 'Format', post_as_images_carousel: 'Publish images as a carousel',
  carousel_name: 'Carousel name', privacy_level: 'Who can see this', comment: 'Allow comments', duet: 'Allow duets',
  stitch: 'Allow stitches', autoAddMusic: 'Automatically add music', video_made_with_ai: 'AI-generated video',
  made_with_ai: 'AI-generated content', brand_content_toggle: 'Paid partnership', brand_organic_toggle: 'Promotes your brand',
  content_posting_method: 'Delivery', article_status: 'Article delivery', article_cover: 'Article cover',
  graduation_strategy: 'Trial Reel delivery', is_trial_reel: 'Trial Reel', selfDeclaredMadeForKids: 'Made for kids',
  music: 'Music', audio: 'Audio', thumbnail: 'Thumbnail', url: 'Link', board: 'Board ID', channel: 'Channel ID',
};

const CHOICES: Record<string, string> = {
  PUBLIC_TO_EVERYONE: 'Everyone', MUTUAL_FOLLOW_FRIENDS: 'Mutual followers', FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me', DIRECT_POST: 'Publish to TikTok', UPLOAD: 'Send to TikTok inbox',
  following: 'Accounts you follow', mentionedUsers: 'Mentioned accounts', MANUAL: 'Decide later',
  SS_PERFORMANCE: 'Share automatically based on performance', post: 'Post', story: 'Story', reel: 'Reel',
  draft: 'Save as an article draft', published: 'Publish the article',
};

const DEFAULTS: Record<string, string> = {
  who_can_reply_post: 'everyone', post_type: 'post', comment: 'true', autoAddMusic: 'no',
  content_posting_method: 'DIRECT_POST', article_status: 'published', selfDeclaredMadeForKids: 'no',
};

const label = (value: string) => {
  const words = value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
  return words.slice(0, 1).toUpperCase() + words.slice(1);
};

function fieldFor(provider: string, key: string, schema: JsonObject, required: boolean): Field {
  const network = networkOf(provider);
  const values = Array.isArray(schema.enum) ? schema.enum.filter(nonempty) : [];
  if (network === 'instagram' && key === 'post_type' && values.includes('post') && !values.includes('reel')) {
    values.splice(values.indexOf('post') + 1, 0, 'reel');
  }
  const kind = values.length ? 'choice' : schema.type === 'array' || key === 'tags' ? 'list' :
    schema.type === 'boolean' || key === 'is_trial_reel' ? 'bool' : 'text';
  let hint = typeof schema.description === 'string' ? schema.description : '';
  if (schema.type === 'object') hint = 'Enter the Postiz setting as a JSON object.';
  if (key === 'collaborators') hint = 'Enter up to three Instagram usernames.';
  if (key === 'post_type' && network === 'instagram') hint = 'A Reel uses one MP4 video. Use a single attachment for a Story.';
  if (key === 'content_posting_method') hint = 'Posts sent to your TikTok inbox require you to finish publishing in TikTok.';
  if (key === 'article_title' || key === 'article_status') hint ||= 'Used for X articles.';
  if (key === 'thumbnail' || key === 'article_cover') hint = 'Enter a JSON object with the uploaded media id and path.';
  return {
    key, label: key === 'type' && network === 'youtube' ? 'Visibility' : TITLE[key] ?? label(key), kind,
    options: values.map(value => ({ value, label: CHOICES[value] ?? label(value) })),
    required: required || key === 'who_can_reply_post',
    initial: DEFAULTS[key] ?? (kind === 'bool' ? 'false' : kind === 'list' ? '[]' : ''),
    hint, max: typeof schema.maxLength === 'number' ? schema.maxLength : key === 'collaborators' ? 3 : 0,
  };
}

export function channelFor(instance: string, integration: Integration, schema: SettingsSchema): Channel {
  const network = networkOf(integration.identifier);
  const needsMedia = ['instagram', 'tiktok', 'youtube', 'pinterest'].includes(network);
  const fields = Object.entries(schema.properties).flatMap(([key, value]) =>
    isObject(value) && key !== '__type' ? [fieldFor(integration.identifier, key, value, schema.required.includes(key))] : []);
  return {
    id: integration.id, name: integration.name, handle: integration.profile ?? '', network,
    networkName: NETWORK_NAMES[network] ?? label(network),
    avatar: assetUrl(instance, integration.picture ?? '', true), limit: schema.maxLength, needsMedia, fields,
    threads: false, comments: false, mentions: 'none', // seam: not answered yet
  };
}

function listValue(value: string, field: Field): unknown[] {
  let list: unknown;
  try { list = JSON.parse(value); } catch {
    if ((field.key === 'collaborators' || field.key === 'tags') && !value.trimStart().startsWith('[')) {
      list = value.split(',').map(item => item.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(list)) throw new PostizError(`${field.label} needs a JSON list.`);
  if (field.key === 'collaborators') {
    if (list.length > 3) throw new PostizError('Instagram allows up to three collaborators.');
    return list.map(item => {
      const name = typeof item === 'string' ? item : isObject(item) ? item.label : '';
      if (typeof name !== 'string' || !name.trim().replace(/^@/, '')) throw new PostizError('Enter a username for each Instagram collaborator.');
      return { label: name.trim().replace(/^@/, '') };
    });
  }
  if (field.key === 'tags') {
    return list.map(item => typeof item === 'string' ? { value: item, label: item } : item);
  }
  if (field.key === 'subreddit') {
    return list.map(item => isObject(item) && !Object.hasOwn(item, 'value') ? { value: item } : item);
  }
  return list;
}

const VIDEO_EXTENSION = /\.(mp4|mov|m4v|webm)$/i;
export function isVideo(path: string): boolean {
  return VIDEO_EXTENSION.test(path.split(/[?#]/)[0]);
}

export function toSettings(channel: Channel, schema: SettingsSchema, provider: string, target: Target,
  media: Media[], draft: boolean, old: JsonObject = {}): JsonObject {
  const values = new Map(target.settings.map(setting => [setting.key, setting.value]));
  const settings: JsonObject = { ...old, __type: provider };
  const article = channel.network === 'x' && (values.get('post_type') ?? old.post_type) === 'article';
  for (const field of channel.fields) {
    let value = values.get(field.key);
    const required = field.required && (!article || field.key !== 'who_can_reply_post') ||
      article && ['article_title', 'article_status'].includes(field.key);
    if (value === undefined && Object.hasOwn(settings, field.key)) continue;
    if ((value === undefined || value === '') && required) value = field.initial;
    if (!value?.trim()) {
      delete settings[field.key];
      if (!required) continue;
      throw new PostizError(`Choose or enter ${field.label.toLowerCase()} for ${channel.networkName}.`);
    }
    if (field.kind === 'choice' && !field.options.some(option => option.value === value)) {
      throw new PostizError(`Choose a valid value for ${field.label.toLowerCase()}.`);
    }
    if (field.kind === 'bool') {
      if (value !== 'true' && value !== 'false') throw new PostizError(`Turn ${field.label.toLowerCase()} on or off.`);
      settings[field.key] = value === 'true';
    } else if (field.kind === 'list') {
      settings[field.key] = listValue(value, field);
      if (required && Array.isArray(settings[field.key]) && (settings[field.key] as unknown[]).length === 0) {
        throw new PostizError(`Add at least one value for ${field.label.toLowerCase()}.`);
      }
    } else {
      if (field.max > 0 && value.length > field.max) {
        throw new PostizError(`${field.label} must be ${field.max} characters or fewer.`);
      }
      const property = schema.properties[field.key];
      if (isObject(property) && property.type === 'object') {
        let object: unknown;
        try { object = JSON.parse(value); } catch { /* the user-facing error below names the setting */ }
        if (!isObject(object)) throw new PostizError(`${field.label} needs a JSON object.`);
        settings[field.key] = object;
      } else if (isObject(property) && ['integer', 'number'].includes(String(property.type))) {
        const number = Number(value);
        if (!Number.isFinite(number)) throw new PostizError(`${field.label} needs a number.`);
        settings[field.key] = number;
      } else settings[field.key] = value;
    }
  }

  if (!target.text.trim() && !media.length) throw new PostizError('Add some text or an attachment.');
  if (!draft && channel.needsMedia && !media.length) throw new PostizError(`Add an attachment for ${channel.networkName}.`);
  if (!draft && channel.limit && !article && Array.from(target.text).length > channel.limit) {
    throw new PostizError(`${channel.networkName} allows up to ${channel.limit} characters.`);
  }
  const video = media.filter(item => item.kind === 'video' || isVideo(item.url || item.name || item.path)).length;
  if (channel.network === 'instagram') {
    if ((settings.post_type === 'reel' || settings.is_trial_reel === true) && (!draft || media.length) &&
        (media.length !== 1 || video !== 1)) throw new PostizError('An Instagram Reel needs one MP4 video.');
    if (settings.post_type === 'story' && media.length > 1) throw new PostizError('Use one attachment for an Instagram Story.');
    if (settings.post_type === 'reel') settings.post_type = 'post';
  }
  if (!draft && channel.network === 'youtube' && (media.length !== 1 || video !== 1)) {
    throw new PostizError('YouTube needs one MP4 video.');
  }
  if (!draft && channel.network === 'tiktok' && video && media.length !== 1) {
    throw new PostizError('TikTok accepts one video or a set of photos.');
  }
  if (!draft && channel.network.startsWith('linkedin') && settings.post_as_images_carousel &&
      (media.length < 2 || video)) throw new PostizError('A LinkedIn image carousel needs two or more images.');
  return settings;
}

export function fromSettings(settings: JsonObject, provider: string, media: RemoteMedia[]): Result<'loadPosts'>['posts'][number]['settings'] {
  return Object.entries(settings).flatMap(([key, value]) => {
    if (key === '__type' || value == null) return [];
    if (key === 'post_type' && value === 'post' && networkOf(provider) === 'instagram' &&
        media.length === 1 && isVideo(media[0].path)) value = 'reel';
    return [{ key, value: typeof value === 'string' ? value : JSON.stringify(value) }];
  });
}
