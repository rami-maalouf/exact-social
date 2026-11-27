// the channels a draft can name. this is the seam for an account connection:
// a postiz module can answer `listChannels` with connected integrations instead,
// keeping the same fields. `limit` is the longest post the channel accepts.
export type Channel = { id: string; name: string; limit: number };

const local: Channel[] = [
  { id: 'x', name: 'X', limit: 280 },
  { id: 'linkedin', name: 'LinkedIn', limit: 3000 },
  { id: 'instagram', name: 'Instagram', limit: 2200 },
  { id: 'threads', name: 'Threads', limit: 500 },
  { id: 'bluesky', name: 'Bluesky', limit: 300 },
];

export const listChannels = async (): Promise<Channel[]> => local;
