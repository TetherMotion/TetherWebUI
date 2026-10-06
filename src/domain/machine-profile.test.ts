import { describe, expect, it, vi } from 'vitest';
import {
  discoverMachineProfile,
  MACHINE_DESCRIPTOR_ROOT,
  MACHINE_SNAPSHOT_ROOT,
  DRIVE_SNAPSHOT_ROOT,
  readMachineDescriptor,
  readMachineSnapshot,
} from './machine-profile';
import type { CatalogEntry } from '../protocol';
import type { SchemaCatalogV6, SchemaNodeV6 } from '../schema-v6';
import type { TetherIOClient } from '../client';

function entry(id: bigint, name: string, slot: number, schemaName?: string): CatalogEntry {
  return {
    id,
    name,
    description: '',
    group: 'machine.cia402',
    kind: 'signal',
    flags: 5,
    schemaEpoch: 7n,
    schemaSlot: slot,
    metadata: schemaName ? { 'schema.name': schemaName } : {},
  };
}

function catalog(names: string[]): SchemaCatalogV6 {
  const slotToNode = names.map((name) => ({ name }) as unknown as SchemaNodeV6);
  return {
    epoch: 7,
    manifest: [],
    nodesByKey: new Map(),
    slotToNode,
  };
}

describe('machine.cia402.v1 profile adapter', () => {
  it('requires typed descriptor, aggregate snapshot, and drive snapshot signals', () => {
    const schemaCatalog = catalog([
      MACHINE_DESCRIPTOR_ROOT,
      MACHINE_SNAPSHOT_ROOT,
      DRIVE_SNAPSHOT_ROOT,
    ]);
    const signals = [
      entry(1n, 'machine.descriptor', 0, MACHINE_DESCRIPTOR_ROOT),
      entry(2n, 'machine.snapshot', 1, MACHINE_SNAPSHOT_ROOT),
      entry(3n, 'drive.sim-x.snapshot', 2, DRIVE_SNAPSHOT_ROOT),
    ];
    const profile = discoverMachineProfile(schemaCatalog, signals);
    expect(profile.profile).toBe('machine.cia402.v1');
    expect(profile.descriptorEntry?.id).toBe(1n);
    expect(profile.machineSnapshotEntry?.id).toBe(2n);
    expect(profile.driveSnapshots.map(({ id }) => id)).toEqual([3n]);
    expect(profile.controlsAvailable).toBe(false);
  });

  it('never treats schema-less slot-0 signals as typed entries', () => {
    // Untyped entries arrive with schemaSlot=0; without the schema.name
    // metadata marker they resolve to whatever node owns slot 0.
    const schemaCatalog = catalog([
      DRIVE_SNAPSHOT_ROOT,
      MACHINE_DESCRIPTOR_ROOT,
      MACHINE_SNAPSHOT_ROOT,
    ]);
    const signals = [
      entry(10n, 'sine_wave', 0), // untyped scalar signal, slot 0
      entry(11n, 'machine.events.cursor', 0),
      entry(1n, 'machine.descriptor', 1, MACHINE_DESCRIPTOR_ROOT),
      entry(2n, 'machine.snapshot', 2, MACHINE_SNAPSHOT_ROOT),
      entry(3n, 'drive.sim-x.snapshot', 0, DRIVE_SNAPSHOT_ROOT),
    ];
    const profile = discoverMachineProfile(schemaCatalog, signals);
    expect(profile.profile).toBe('machine.cia402.v1');
    expect(profile.driveSnapshots.map(({ id }) => id)).toEqual([3n]);
  });

  it('does not mark the profile available when schema roots lack signal entries', () => {
    const profile = discoverMachineProfile(
      catalog([MACHINE_DESCRIPTOR_ROOT, MACHINE_SNAPSHOT_ROOT]),
      [],
    );
    expect(profile.profile).toBe('unavailable');
  });

  it('decodes descriptor axes and sorts them by display order', async () => {
    const client = {
      getTyped: vi.fn().mockResolvedValue({
        profile_version: 1,
        machine_id: 'sim-machine',
        display_name: 'Sim machine',
        timezone: 'UTC',
        unit_system: 'metric',
        axes: [
          {
            stable_id: 'axis-y',
            name: 'Y',
            slave_index: 1,
            display_order: 1,
            group_id: 'gantry',
            position_unit: 'mm',
            position_scale: 0.001,
            velocity_unit: 'mm/s',
            velocity_scale: 0.001,
            supports_homing: true,
          },
          {
            stable_id: 'axis-x',
            name: 'X',
            slave_index: 0,
            display_order: 0,
            group_id: 'gantry',
            position_unit: 'mm',
            position_scale: 0.001,
            velocity_unit: 'mm/s',
            velocity_scale: 0.001,
            supports_homing: true,
          },
        ],
      }),
    } as unknown as TetherIOClient;
    const descriptor = await readMachineDescriptor(client, entry(1n, 'machine.descriptor', 0));
    expect(descriptor.machineId).toBe('sim-machine');
    expect(descriptor.axes.map(({ name }) => name)).toEqual(['X', 'Y']);
  });

  it('rejects duplicate stable resource identifiers', async () => {
    const axis = {
      stable_id: 'axis-x',
      name: 'X',
      slave_index: 0,
      display_order: 0,
      group_id: 'gantry',
      position_unit: 'mm',
      position_scale: 1,
      velocity_unit: 'mm/s',
      velocity_scale: 1,
      supports_homing: true,
    };
    const client = {
      getTyped: vi
        .fn()
        .mockResolvedValue({
          profile_version: 1,
          machine_id: 'sim',
          display_name: 'Sim',
          timezone: 'UTC',
          unit_system: 'metric',
          axes: [axis, { ...axis }],
        }),
    } as unknown as TetherIOClient;
    await expect(readMachineDescriptor(client, entry(1n, 'machine.descriptor', 0))).rejects.toThrow(
      'duplicate axis identity',
    );
  });

  it('decodes a machine snapshot and rejects inconsistent aggregate counts', async () => {
    const client = {
      getTyped: vi.fn().mockResolvedValue({
        timestamp_us: 10n,
        state_generation: 3n,
        simulated: true,
        axis_count: 4,
        enabled_count: 3,
        fault_count: 1,
        warning_count: 0,
        stale_count: 0,
        al_state: 8,
        expected_wkc: 8,
        actual_wkc: 8,
        link_up: true,
        dc_locked: true,
      }),
    } as unknown as TetherIOClient;
    const snapshot = await readMachineSnapshot(client, entry(2n, 'machine.snapshot', 1));
    expect(snapshot.axisCount).toBe(4);
    expect(snapshot.simulated).toBe(true);
    const invalidClient = {
      getTyped: vi.fn().mockResolvedValue({
        timestamp_us: 10n,
        state_generation: 3n,
        simulated: true,
        axis_count: 2,
        enabled_count: 3,
        fault_count: 0,
        warning_count: 0,
        stale_count: 0,
        al_state: 8,
        expected_wkc: 4,
        actual_wkc: 4,
        link_up: true,
        dc_locked: true,
      }),
    } as unknown as TetherIOClient;
    await expect(
      readMachineSnapshot(invalidClient, entry(2n, 'machine.snapshot', 1)),
    ).rejects.toThrow('inconsistent fleet counts');
  });
});
