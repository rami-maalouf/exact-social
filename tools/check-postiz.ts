import { postizClient } from '../lib/postiz';

const instance = process.env.POSTIZ_INSTANCE;
const key = process.env.POSTIZ_API_KEY;
if (!instance || !key) throw new Error('Set POSTIZ_INSTANCE and POSTIZ_API_KEY.');
const client = postizClient(instance, key);
const start = new Date();
const end = new Date(start.getTime() + 7 * 86400000);
const [channels, posts] = await Promise.all([client.channels(), client.posts(start, end)]);
console.log(`${channels.length} enabled accounts, ${posts.length} calendar entries for the next 7 days.`);
