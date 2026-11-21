import { beforeEach, describe, expect, it } from 'vitest';
import { deleteSnapshot, diffSummary, getSnapshot, historyIndex, pushSnapshot } from './history';
import { emptyProject } from './model';
import { emptyPlcProject } from './store';

function proj(tag: string) {
  const p = emptyPlcProject();
  p.fbd.project = tag;
  return p;
}

describe('project history', () => {
  beforeEach(() => localStorage.clear());

  it('push/list/get/delete round-trips a project', () => {
    const p = proj('alpha');
    const s = pushSnapshot(p, 'first')!;
    expect(s.label).toBe('first');
    expect(historyIndex()).toHaveLength(1);
    expect(getSnapshot(s.id)?.fbd.project).toBe('alpha');
    deleteSnapshot(s.id);
    expect(historyIndex()).toHaveLength(0);
    expect(getSnapshot(s.id)).toBeNull();
  });

  it('auto snapshots are throttled, manual are not', () => {
    const p = proj('x');
    expect(pushSnapshot(p, 'a', true)).not.toBeNull();
    expect(pushSnapshot(p, 'b', true)).toBeNull(); // within 30s
    expect(pushSnapshot(p, 'c')).not.toBeNull();    // manual bypasses
    expect(historyIndex()).toHaveLength(2);
  });

  it('snapshots are independent copies (later edits do not leak)', () => {
    const p = proj('v1');
    const s = pushSnapshot(p, 'snap')!;
    p.fbd.project = 'v2-mutated';
    expect(getSnapshot(s.id)?.fbd.project).toBe('v1');
  });

  it('diffSummary reports deltas', () => {
    const a = emptyPlcProject();
    const b = emptyPlcProject();
    b.stSources['Main'] = 'PROGRAM Main END_PROGRAM';
    const d = diffSummary(a, b);
    expect(d).toContain('+1 ST sources');
    expect(emptyProject('t').pous).toHaveLength(0);
  });
});
