import { describe, expect, it } from 'vitest';
import { interpretDrive } from './drives';
import { DriveSnapshotView, MachineAxisDescriptor } from '../domain/machine-profile';

const AXIS: MachineAxisDescriptor = {
  stableId: 'axis-x',
  name: 'X',
  slaveIndex: 0,
  displayOrder: 0,
  groupId: 'axes',
  positionUnit: 'mm',
  positionScale: 0.001,
  velocityUnit: 'mm/s',
  velocityScale: 0.001,
  supportsHoming: true,
};

function snap(over: Partial<DriveSnapshotView> = {}): DriveSnapshotView {
  return {
    timestampUs: 1n,
    stateGeneration: 1n,
    slaveIndex: 0,
    alStatusCode: 0,
    statusWord: 0x0637,
    controlWord: 0x000f,
    faultCode: 0,
    qualityFlags: 0,
    alState: 8,
    ds402State: 4,
    targetMode: 8,
    displayMode: 8,
    targetPosition: 5000,
    demandPosition: 5000,
    actualPosition: 5001,
    followingError: 1,
    targetVelocity: 0,
    actualVelocity: 0,
    targetTorque: 0,
    actualTorque: 12,
    homingState: 0,
    ...over,
  };
}

describe('interpretDrive', () => {
  it('collapses a nominal enabled drive to a healthy card with no anomalies', () => {
    const c = interpretDrive({ snapshot: snap(), ageMs: 20, axis: AXIS });
    expect(c.tone).toBe('healthy');
    expect(c.pill).toBe('Enabled');
    expect(c.anomalies).toEqual([]);
    expect(c.interp).toContain('CSP');
    expect(c.interp).toContain('at 5.001 mm');
    // AL state is nominal (OP) — it must not appear in the compact view.
    expect(c.anomalies.join(' ')).not.toContain('OP');
  });

  it('surfaces a non-OP AL state only when abnormal', () => {
    const c = interpretDrive({
      snapshot: snap({ alState: 2, alStatusCode: 0x0011 }),
      ageMs: 20,
      axis: AXIS,
    });
    expect(c.anomalies.some((a) => a.includes('bus') && a.includes('0x0011'))).toBe(true);
  });

  it('reports a fault with code and recovery hint', () => {
    const c = interpretDrive({
      snapshot: snap({ ds402State: 7, faultCode: 0x7500 }),
      ageMs: 20,
      axis: AXIS,
    });
    expect(c.tone).toBe('fault');
    expect(c.pill).toContain('0x7500');
    expect(c.anomalies.some((a) => a.includes('Fault reset'))).toBe(true);
  });

  it('flags stale data', () => {
    const c = interpretDrive({
      snapshot: snap({ qualityFlags: 1 }),
      ageMs: 5000,
      axis: AXIS,
    });
    expect(c.pill).toBe('Stale');
    expect(c.anomalies.some((a) => a.includes('stale'))).toBe(true);
  });

  it('interprets in-progress motion instead of showing raw positions', () => {
    const c = interpretDrive({
      snapshot: snap({ actualPosition: 1000 }),
      ageMs: 20,
      axis: AXIS,
    });
    expect(c.interp).toContain('→ 5.000 mm');
  });

  it('surfaces a large following error', () => {
    const c = interpretDrive({
      snapshot: snap({ followingError: 400 }),
      ageMs: 20,
      axis: AXIS,
    });
    expect(c.anomalies.some((a) => a.includes('following error'))).toBe(true);
  });

  it('reports homing progress', () => {
    const c = interpretDrive({
      snapshot: snap({ displayMode: 6, homingState: 1 }),
      ageMs: 20,
      axis: AXIS,
    });
    expect(c.interp).toContain('homing in progress');
  });
});
