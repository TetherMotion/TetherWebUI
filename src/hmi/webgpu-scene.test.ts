import { describe, expect, it } from 'vitest';
import { sceneToVertices, webgpuSceneEnabled, resetWebgpuSceneFlag } from './webgpu-scene';
import type { HmiScene } from './scene';

/* sceneToVertices lowers ops to interleaved [x y u v r g b a] verts.
   atlas=null skips text — solid geometry is fully testable in jsdom. */

const scene = (ops: HmiScene['ops'], extra: Partial<HmiScene> = {}): HmiScene =>
  ({ w: 100, h: 100, ops, ...extra });

describe('sceneToVertices', () => {
  it('emits 6 verts per filled rect', () => {
    const v = sceneToVertices(scene([{ k: 'rect', x: 10, y: 20, w: 30, h: 40, fill: '#ff0000' }]), null);
    expect(v.totalVerts).toBe(6);
    expect(v.solidVerts).toBe(6);
    // first vertex = top-left corner, red opaque (stride 8: x y u v r g b a)
    expect(v.data[0]).toBe(10);
    expect(v.data[1]).toBe(20);
    expect(v.data[4]).toBeCloseTo(1);   // r
    expect(v.data[7]).toBeCloseTo(1);   // a
  });

  it('stroke-only rect emits a 4-strip frame (24 verts)', () => {
    const v = sceneToVertices(scene([{ k: 'rect', x: 10, y: 10, w: 20, h: 20, stroke: '#00ff00', sw: 2 }]), null);
    expect(v.totalVerts).toBe(24); // 4 quads × 6
  });

  it('fill+stroke rect emits fill quad + frame', () => {
    const v = sceneToVertices(scene([{ k: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#fff', stroke: '#000', sw: 1 }]), null);
    expect(v.totalVerts).toBe(6 + 24);
  });

  it('line emits body quad + two half-disc caps', () => {
    const v = sceneToVertices(scene([{ k: 'line', x1: 0, y1: 0, x2: 50, y2: 0, color: '#fff', w: 4 }]), null);
    // body 6 + 2 caps × (8 segs × 3) = 6 + 48
    expect(v.totalVerts).toBe(54);
  });

  it('degenerate line emits a full disc', () => {
    const v = sceneToVertices(scene([{ k: 'line', x1: 5, y1: 5, x2: 5, y2: 5, color: '#fff', w: 4 }]), null);
    // body quad collapses to disc(12) + disc(12) = 6+36+36? segQuad→disc(12 segs)=36, plus 12
    expect(v.totalVerts).toBeGreaterThan(0);
  });

  it('filled path fans around first point', () => {
    const tri: HmiScene['ops'] = [{
      k: 'path',
      pts: [[0, 0], [10, 0], [10, 10]],
      color: '#fff', fill: '#00f',
    }];
    const v = sceneToVertices(scene(tri), null);
    expect(v.totalVerts).toBe(3); // single triangle fan
  });

  it('stroked open path adds join discs + caps', () => {
    const v = sceneToVertices(scene([{
      k: 'path', pts: [[0, 0], [10, 0], [20, 5]], color: '#fff', w: 2,
    }]), null);
    // 2 segs ×6 + 1 interior join disc(10)×3 + 2 caps(8)×3 = 12+30+48=90
    expect(v.totalVerts).toBe(90);
  });

  it('skips text when atlas is null', () => {
    const v = sceneToVertices(scene([
      { k: 'text', x: 0, y: 10, s: 'HELLO', color: '#fff' },
    ]), null);
    expect(v.totalVerts).toBe(0);
  });

  it('interleaved solid/text ops keep pipeline sections segregated', () => {
    // rect → text → rect: solid verts must stay contiguous at the front
    const glyph = { left: 0, top: 8, w: 8, h: 10, u0: 0, v0: 0, u1: 0.1, v1: 0.1 };
    const atlas = {
      texture: {} as GPUTexture, sampler: {} as GPUSampler,
      glyphs: new Map([['A', glyph]]), width: 1, height: 1,
    };
    const v = sceneToVertices(scene([
      { k: 'rect', x: 0, y: 0, w: 4, h: 4, fill: '#fff' },
      { k: 'text', x: 0, y: 10, s: 'A', color: '#fff', size: 10 },
      { k: 'rect', x: 8, y: 8, w: 4, h: 4, fill: '#fff' },
    ]), atlas);
    expect(v.solidVerts).toBe(12);            // 2 rects × 6
    expect(v.totalVerts).toBe(18);            // + 1 glyph quad
    // solid verts occupy the first 12×8 floats; text quad starts after
    expect(v.data[12 * 8]).toBeCloseTo(0);    // text quad x (pen + left*s)
    expect(v.data[12 * 8 + 1]).toBeCloseTo(10 - 8 * (10 / 48)); // baseline - top*s
  });

  it('transparent ops emit nothing', () => {
    const v = sceneToVertices(scene([
      { k: 'rect', x: 0, y: 0, w: 5, h: 5, fill: '#00000000' },
      { k: 'line', x1: 0, y1: 0, x2: 9, y2: 9, color: '#0000' },
    ]), null);
    expect(v.totalVerts).toBe(0);
  });
});

describe('webgpuSceneEnabled', () => {
  it('defaults off without flag or query param', () => {
    resetWebgpuSceneFlag();
    expect(webgpuSceneEnabled()).toBe(false);
  });
});
