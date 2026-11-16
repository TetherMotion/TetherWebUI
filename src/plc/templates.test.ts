import { describe, expect, it } from 'vitest';

import { isFbdProject } from './model';
import {
  instantiateTemplate,
  PROJECT_TEMPLATES,
  tplPickerWanted,
  TPL_PICKER_FOREVER_KEY,
  TPL_PICKER_SESSION_KEY,
} from './templates';

describe('project templates', () => {
  it('catalog is non-empty with unique ids', () => {
    expect(PROJECT_TEMPLATES.length).toBeGreaterThanOrEqual(3);
    const ids = new Set(PROJECT_TEMPLATES.map((t) => t.id));
    expect(ids.size).toBe(PROJECT_TEMPLATES.length);
    for (const t of PROJECT_TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.desc.length).toBeGreaterThan(0);
    }
  });

  it('every template instantiates a valid fbd.v1 project', () => {
    for (const t of PROJECT_TEMPLATES) {
      const p = instantiateTemplate(t);
      expect(isFbdProject(p.fbd)).toBe(true);
      expect(p.fbd.project).toBe(t.project);
      expect(p.fbd.pous.length).toBeGreaterThan(0);
      /* at least one network with content */
      const blocks = p.fbd.pous.flatMap((po) =>
        po.networks.flatMap((n) => n.blocks),
      );
      expect(blocks.length).toBeGreaterThan(0);
    }
  });

  it('instantiation is independent per call (deep copy)', () => {
    const a = instantiateTemplate(PROJECT_TEMPLATES[0]!);
    const b = instantiateTemplate(PROJECT_TEMPLATES[0]!);
    a.fbd.pous[0]!.name = 'MUTATED';
    expect(b.fbd.pous[0]!.name).not.toBe('MUTATED');
  });

  it('picker wanted logic honors session + forever keys', () => {
    const store = (m: Record<string, string>) => ({
      getItem: (k: string) => m[k] ?? null,
    });
    expect(tplPickerWanted(store({}), store({}))).toBe(true);
    expect(
      tplPickerWanted(store({ [TPL_PICKER_SESSION_KEY]: '1' }), store({})),
    ).toBe(false);
    expect(
      tplPickerWanted(store({}), store({ [TPL_PICKER_FOREVER_KEY]: '1' })),
    ).toBe(false);
  });
});
