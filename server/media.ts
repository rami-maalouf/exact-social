import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// the fixture accepts the single file part sent by the app and the postiz cli.
// spool the request to disk and inspect only its header and closing boundary.
export async function receiveMedia(request: Request, directory: string) {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(request.headers.get('content-type') ?? '');
  const marker = boundary?.[1] ?? boundary?.[2];
  if (!request.body || !marker || marker.length > 200) throw new Error('Invalid multipart upload');
  await mkdir(directory, { recursive: true });
  const stage = join(directory, crypto.randomUUID());
  try {
    await pipeline(request.body, createWriteStream(stage));
    const body = Bun.file(stage);
    const header = Buffer.from(await body.slice(0, 8192).arrayBuffer());
    const split = header.indexOf('\r\n\r\n');
    const fields = header.toString('utf8', 0, split);
    const name = /content-disposition: form-data; name="file"; filename="([^"\r\n]+)"/i.exec(fields)?.[1];
    const type = /content-type: ([^\r\n]+)/i.exec(fields)?.[1];
    if (!name || !type || split < 0 || !fields.startsWith('--' + marker + '\r\n')) throw new Error('No file provided');
    const footer = Buffer.from('\r\n--' + marker + '--');
    const end = Buffer.from(await body.slice(Math.max(0, body.size - footer.length - 2)).arrayBuffer());
    const suffix = end.subarray(-2).equals(Buffer.from('\r\n')) ? 2 : 0;
    if (!end.subarray(end.length - footer.length - suffix, end.length - suffix).equals(footer)) throw new Error('Incomplete multipart upload');
    const start = split + 4;
    const endOffset = body.size - suffix - footer.length;
    const size = endOffset - start;
    const maximum = type === 'video/mp4' ? 1024 ** 3 : 10 * 1024 ** 2;
    if (size <= 0 || size > maximum) throw new Error('File size exceeds the Postiz limit or the attachment is empty');
    return { name, type, write: (target: string) => pipeline(createReadStream(stage, { start, end: endOffset - 1 }), createWriteStream(target)), discard: () => rm(stage, { force: true }) };
  } catch (error) { await rm(stage, { force: true }); throw error; }
}

export const temporaryMediaDirectory = () => mkdtemp(join(tmpdir(), 'exact-social-media-'));
