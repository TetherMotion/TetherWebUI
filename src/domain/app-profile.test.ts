import { describe, expect, it } from 'vitest';
import { parseAppProfileDocument, widgetSignalBindings } from './app-profile';
import { decodeRecipeInfo, encodeTagged, fieldScalar, fieldString } from './machine-control';

describe('application profile document', () => {
  it('parses a valid panels document', () => {
    const profile = parseAppProfileDocument(
      JSON.stringify({
        format: 'tether.app.profile.v1',
        panels: [
          {
            id: 'cooling',
            title: 'Cooling',
            widgets: [
              {
                kind: 'bar',
                label: 'Zone temp',
                entry: 'zone.temp',
                unit: '°C',
                min: 0,
                max: 100,
                warnAbove: 80,
              },
              {
                kind: 'state',
                label: 'Fan',
                entry: 'fan.state',
                states: { '0': 'off', '1': 'on' },
              },
            ],
          },
        ],
      }),
    );
    expect(profile?.panels).toHaveLength(1);
    expect(profile?.panels[0]!.widgets).toHaveLength(2);
    expect(profile?.panels[0]!.widgets[0]).toMatchObject({
      kind: 'bar',
      entry: 'zone.temp',
      min: 0,
      max: 100,
      warnAbove: 80,
    });
    expect(profile?.panels[0]!.widgets[1]!.states).toEqual({ '0': 'off', '1': 'on' });
  });

  it('rejects wrong format and malformed widgets', () => {
    expect(parseAppProfileDocument('{}')).toBeUndefined();
    expect(parseAppProfileDocument('{"format":"other"}')).toBeUndefined();
    expect(parseAppProfileDocument('not json')).toBeUndefined();
    const profile = parseAppProfileDocument(
      JSON.stringify({
        format: 'tether.app.profile.v1',
        panels: [
          {
            id: 'p',
            title: 'P',
            widgets: [
              { kind: 'bar', label: 'ok', entry: 'a.b' },
              { kind: 'exec', label: 'nope', entry: 'a.c' }, // unknown kind dropped
              { kind: 'bar', entry: 'a.d' }, // missing label dropped
            ],
          },
        ],
      }),
    );
    expect(profile?.panels[0]!.widgets).toHaveLength(1);
    expect(profile?.panels[0]!.widgets[0]!.entry).toBe('a.b');
  });

  it('parses control widgets and validates their bindings', () => {
    const profile = parseAppProfileDocument(
      JSON.stringify({
        format: 'tether.app.profile.v1',
        panels: [
          {
            id: 'axes',
            title: 'Axes',
            widgets: [
              {
                kind: 'dro',
                label: 'X pos',
                entry: 'drive.x.snapshot',
                field: 'actual_position',
                decimals: 0,
              },
              { kind: 'jog', label: 'Jog X', axis: 'sim-axis-x' },
              { kind: 'command', label: 'Enable X', axis: 'sim-axis-x', action: 0 },
              { kind: 'button', label: 'Report', fn: 'machine.checklist.report' },
              { kind: 'lamp', label: 'Hot', entry: 'temp', critAbove: 90 },
              { kind: 'jog', label: 'no axis' }, // dropped: axis required
              { kind: 'command', label: 'no action', axis: 'x' }, // dropped: action required
              { kind: 'button', label: 'no fn' }, // dropped: fn required
              { kind: 'dro', label: 'no entry' }, // dropped: entry required
            ],
          },
        ],
      }),
    );
    const widgets = profile?.panels[0]!.widgets ?? [];
    expect(widgets.map((w) => w.kind)).toEqual(['dro', 'jog', 'command', 'button', 'lamp']);
    expect(widgets[0]).toMatchObject({ field: 'actual_position', decimals: 0 });
    expect(widgets[1]!.axis).toBe('sim-axis-x');
    expect(widgets[2]!.action).toBe(0);
    expect(widgets[3]!.fn).toBe('machine.checklist.report');
    expect(widgets[4]!.critAbove).toBe(90);
  });

  it('parses scene widgets and exposes every signal binding', () => {
    const profile = parseAppProfileDocument(
      JSON.stringify({
        format: 'tether.app.profile.v1',
        panels: [
          {
            id: 'gantry',
            title: 'Machine view',
            widgets: [
              {
                kind: 'scene',
                label: 'XY',
                axes: [
                  {
                    name: 'x',
                    entry: 'drive.x.snapshot',
                    field: 'actual_position',
                    targetField: 'target_position',
                    min: -100,
                    max: 100,
                  },
                  { entry: 'drive.y.snapshot', field: 'actual_position' },
                ],
              },
              { kind: 'scene', label: 'no axes' }, // dropped
              { kind: 'scene', label: 'bad axis', axes: [{ entry: 'e' }] }, // missing field
            ],
          },
        ],
      }),
    );
    const widgets = profile?.panels[0]!.widgets ?? [];
    expect(widgets).toHaveLength(1);
    const scene = widgets[0]!;
    expect(scene.kind).toBe('scene');
    expect(scene.axes).toHaveLength(2);
    expect(scene.axes![0]).toMatchObject({
      name: 'x',
      entry: 'drive.x.snapshot',
      field: 'actual_position',
      targetField: 'target_position',
      min: -100,
      max: 100,
    });
    const bindings = [...widgetSignalBindings(scene)].map((b) => b.key);
    expect(bindings).toEqual([
      'drive.x.snapshot.actual_position',
      'drive.x.snapshot.target_position',
      'drive.y.snapshot.actual_position',
    ]);
  });
});

describe('recipe decoding', () => {
  it('decodes RecipeInfoV1', () => {
    const info = decodeRecipeInfo(
      encodeTagged([
        [1, fieldString('warmup')],
        [2, fieldString('Warm-up presets')],
        [3, fieldScalar(5, 4)],
      ]),
    );
    expect(info).toEqual({ name: 'warmup', description: 'Warm-up presets', entryCount: 5 });
  });
});
