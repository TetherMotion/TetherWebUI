import { describe, expect, it } from 'vitest';
import { ensureTileTag } from './loaders';
import '../board/tile-frame';

describe('lazy tiles', () => {
  it('loads a tile module on demand and mounts it', async () => {
    expect(customElements.get('tile-value')).toBeUndefined();
    await ensureTileTag('tile-value');
    expect(customElements.get('tile-value')).toBeTruthy();
    expect(customElements.get('tile-gauge')).toBeTruthy();
    expect(customElements.get('tile-scope')).toBeUndefined();

    const frame = document.createElement('tile-frame') as HTMLElement & {
      def?: unknown;
      updateComplete: Promise<unknown>;
    };
    frame.def = { id: 't1', type: 'value', x: 0, y: 0, w: 3, h: 2, bindings: [] };
    document.body.appendChild(frame);
    await frame.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
    expect(frame.querySelector('tile-value')).toBeTruthy();
    frame.remove();
  });
});
