const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');
const unescapeHtml = (text: string) => text.replace(/&quot;/g, '"').replace(/&#(?:39|x27);/gi, "'")
  .replace(/&nbsp;/g, '\u00a0').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const mentionSpans = (text: string) => [...text.matchAll(/<span\b([^<>]*)>(@[^<>]*)<\/span>/gi)].flatMap(match => {
  const [, attributes, label] = match;
  if (!/\sdata-mention-id="\d+"(?:\s|$)/i.test(attributes)) return [];
  const name = /\sdata-mention-label="([^"]*)"(?:\s|$)/i.exec(attributes)?.[1];
  return [{ start: match.index, token: match[0], label: unescapeHtml(name ? '@' + name : label) }];
});
export const MENTION_SETTING = '@mention:';

export function linkedinVanity(input: string): string {
  let query = input.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(query) || /^(?:[\w-]+\.)?linkedin\.com\//i.test(query)) {
    try {
      const url = new URL(query.includes('://') ? query : 'https://' + query);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
          !/(^|\.)linkedin\.com$/i.test(url.hostname)) return '';
      const path = /^\/company\/([^/]+)\/?$/i.exec(url.pathname);
      if (!path) return '';
      query = decodeURIComponent(path[1]);
    } catch { return ''; }
  } else if (query.startsWith('@')) {
    query = query.slice(1);
  } else {
    query = query.normalize('NFKD').replace(/\p{M}/gu, '')
      .replace(/[^a-z\d_-]+/gi, '-').replace(/^-+|-+$/g, '');
  }
  return /^[a-z\d][a-z\d_-]*$/i.test(query) ? query.toLowerCase() : '';
}

export function linkedinToken(id: string, name: string): string {
  const label = escapeHtml(name);
  return `<span data-mention-id="${id}" data-mention-label="${label.replace(/"/g, '&quot;')}">@${label}</span>`;
}

export function visiblePostContent(text: string): string {
  return splitMentions(text, part => part, (_token, label) => label);
}

function splitMentions(text: string, plain: (part: string) => string, mention: (token: string, label: string) => string): string {
  let content = '';
  let start = 0;
  for (const span of mentionSpans(text)) {
    content += plain(text.slice(start, span.start)) + mention(span.token, span.label);
    start = span.start + span.token.length;
  }
  return content + plain(text.slice(start));
}

export function encodeLinkedInContent(text: string): string {
  // postiz's normal editor only converts mention spans inside paragraph html.
  if (!mentionSpans(text).length || /^<p[\s>]/i.test(text)) return text;
  const encode = (part: string) => escapeHtml(part).replace(/\r\n|\r|\n/g, '<br>');
  return '<p>' + splitMentions(text, encode, token => token) + '</p>';
}

export function decodeLinkedInContent(text: string): string {
  if (!text.startsWith('<p>') || !text.endsWith('</p>') || !mentionSpans(text).length) return text;
  const decode = (part: string) => unescapeHtml(part.replace(/<br>/g, '\n'));
  const content = splitMentions(text.slice(3, -4), decode, token => token);
  return encodeLinkedInContent(content) === text ? content : text;
}

export function linkedInMentionSettings(text: string): { key: string; value: string }[] {
  return mentionSpans(text).map(({ label, token }) => ({ key: MENTION_SETTING + label, value: token }));
}
