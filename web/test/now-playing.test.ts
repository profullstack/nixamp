import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the car gets title, artist, album and the cover at every size, as a full address', async () => {
  const session: { metadata: unknown; positions: unknown[]; setPositionState: (state?: unknown) => void } = {
    metadata: null, positions: [], setPositionState(state?: unknown) { this.positions.push(state ?? null); },
  };
  const saved = ['navigator', 'MediaMetadata', 'location'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.defineProperty(globalThis, 'navigator', { value: { mediaSession: session }, configurable: true });
  Object.defineProperty(globalThis, 'MediaMetadata', { value: class { constructor(init: object) { Object.assign(this, init); } }, configurable: true });
  Object.defineProperty(globalThis, 'location', { value: new URL('https://nixamp.com/music'), configurable: true });
  try {
    const { setNowPlaying, setNowPosition } = await import('../src/now-playing.ts');
    setNowPlaying({ title: 'Song', artist: 'Band', album: 'Record', art: 'https://server1.example/api/v1/stations/x/art/cover.jpg?t=1' });
    const meta = session.metadata as { title: string; artist: string; album: string; artwork: Array<{ src: string; sizes: string; type?: string }> };
    assert.equal(meta.title, 'Song'); assert.equal(meta.artist, 'Band'); assert.equal(meta.album, 'Record');
    assert.ok(meta.artwork.some((one) => one.sizes === '512x512') && meta.artwork.some((one) => one.sizes === '96x96'));
    assert.ok(meta.artwork.every((one) => one.type === 'image/jpeg' && one.src.startsWith('https://server1.example/')));
    // No cover: the mark, still a full address, never an empty list.
    setNowPlaying({ title: 'Other', art: '' });
    const bare = session.metadata as { artwork: Array<{ src: string }> };
    assert.equal(bare.artwork[0]!.src, 'https://nixamp.com/icons/icon-512.png');
    // The song's bar, not a write every tick; no duration clears it.
    setNowPosition(200, 10.02); setNowPosition(200, 10.1); setNowPosition(200, 11);
    assert.equal(session.positions.length, 2);
    setNowPosition(0, 0);
    assert.equal(session.positions.at(-1), null);
  } finally {
    for (const [name, value] of saved) {
      if (value) Object.defineProperty(globalThis, name, value); else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});
