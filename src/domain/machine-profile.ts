import { CatalogEntry, FunctionEntry } from '../protocol';
import { SchemaCatalogV6 } from '../schema-v6';
import { TetherIOClient } from '../client';
import { MACHINE_FUNCTION_NAMES } from './machine-control';

export const DRIVE_SNAPSHOT_ROOT = 'tether.machine.cia402.DriveSnapshotV1';
export const MACHINE_DESCRIPTOR_ROOT = 'tether.machine.cia402.MachineDescriptorV1';
export const MACHINE_SNAPSHOT_ROOT = 'tether.machine.cia402.MachineSnapshotV1';
export const MACHINE_DIAGNOSTICS_ROOT = 'tether.machine.cia402.MachineDiagnosticsV1';

export interface DriveSnapshotView {
  timestampUs: bigint;
  stateGeneration: bigint;
  slaveIndex: number;
  alStatusCode: number;
  statusWord: number;
  controlWord: number;
  faultCode: number;
  qualityFlags: number;
  alState: number;
  ds402State: number;
  targetMode: number;
  displayMode: number;
  targetPosition: number;
  demandPosition: number;
  actualPosition: number;
  followingError: number;
  targetVelocity: number;
  actualVelocity: number;
  targetTorque: number;
  actualTorque: number;
  homingState: number;
}

export interface MachineProfileAvailability {
  profile: 'machine.cia402.v1' | 'unavailable';
  descriptor: boolean;
  machineSnapshot: boolean;
  descriptorEntry?: CatalogEntry;
  machineSnapshotEntry?: CatalogEntry;
  diagnosticsEntry?: CatalogEntry;
  driveSnapshots: CatalogEntry[];
  controlsAvailable: boolean;
  explanation: string;
}

export interface MachineAxisDescriptor {
  stableId: string;
  name: string;
  slaveIndex: number;
  displayOrder: number;
  groupId: string;
  positionUnit: string;
  positionScale: number;
  velocityUnit: string;
  velocityScale: number;
  supportsHoming: boolean;
}

export interface MachineDescriptorView {
  profileVersion: number;
  machineId: string;
  displayName: string;
  timezone: string;
  unitSystem: string;
  axes: MachineAxisDescriptor[];
}

export interface MachineSnapshotView {
  timestampUs: bigint;
  stateGeneration: bigint;
  simulated: boolean;
  axisCount: number;
  enabledCount: number;
  faultCount: number;
  warningCount: number;
  staleCount: number;
  alState: number;
  expectedWkc: number;
  actualWkc: number;
  linkUp: boolean;
  dcLocked: boolean;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (
    typeof value === 'bigint' &&
    value <= BigInt(Number.MAX_SAFE_INTEGER) &&
    value >= BigInt(Number.MIN_SAFE_INTEGER)
  )
    return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error(`DriveSnapshotV1 field ${key} has an invalid value`);
}

function readBigInt(record: Record<string, unknown>, key: string): bigint {
  const value = record[key];
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`DriveSnapshotV1 field ${key} has an invalid value`);
}

async function readRecord(
  client: TetherIOClient,
  entry: CatalogEntry,
  schemaName: string,
): Promise<Record<string, unknown>> {
  const decoded = await client.getTyped(entry);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error(`${schemaName} did not decode to a structured value`);
  }
  return decoded as Record<string, unknown>;
}

function asRecord(value: unknown, schemaName: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${schemaName} did not decode to a structured value`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`Machine profile field ${key} is invalid`);
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') throw new Error(`Machine profile field ${key} is invalid`);
  return value;
}

export function discoverMachineProfile(
  catalog: SchemaCatalogV6 | undefined,
  signals: CatalogEntry[],
  functions: FunctionEntry[] = [],
): MachineProfileAvailability {
  const functionNames = new Set(functions.map((entry) => entry.name));
  const controls =
    functionNames.has(MACHINE_FUNCTION_NAMES.authorityAcquire) &&
    functionNames.has(MACHINE_FUNCTION_NAMES.authorityRelease) &&
    functionNames.has(MACHINE_FUNCTION_NAMES.command) &&
    functionNames.has(MACHINE_FUNCTION_NAMES.alarmsRead);
  if (!catalog) {
    return {
      profile: 'unavailable',
      descriptor: false,
      machineSnapshot: false,
      driveSnapshots: [],
      controlsAvailable: false,
      explanation:
        'V6 schema negotiation is not complete; machine data and actions remain unavailable.',
    };
  }
  const names = new Set(catalog.slotToNode.map((node) => node.name));
  const descriptor = names.has(MACHINE_DESCRIPTOR_ROOT);
  const machineSnapshot = names.has(MACHINE_SNAPSHOT_ROOT);
  // A schema-less entry wires schemaSlot=0, which resolves to whatever node
  // happens to occupy slot 0 — require the server's explicit `schema.name`
  // metadata marker so untyped scalar signals are never misclassified.
  const typedAs = (entry: CatalogEntry, root: string) =>
    entry.schemaEpoch === BigInt(catalog.epoch) &&
    catalog.slotToNode[entry.schemaSlot]?.name === root &&
    entry.metadata?.['schema.name'] === root;
  const descriptorEntry = signals.find((entry) => typedAs(entry, MACHINE_DESCRIPTOR_ROOT));
  const machineSnapshotEntry = signals.find((entry) => typedAs(entry, MACHINE_SNAPSHOT_ROOT));
  // Optional surface: present only when the server attached a diagnostics
  // source. Absent is normal — the view renders "not available".
  const diagnosticsEntry = signals.find((entry) => typedAs(entry, MACHINE_DIAGNOSTICS_ROOT));
  const driveSnapshots = signals.filter((entry) => typedAs(entry, DRIVE_SNAPSHOT_ROOT));
  const complete =
    descriptor &&
    machineSnapshot &&
    !!descriptorEntry &&
    !!machineSnapshotEntry &&
    driveSnapshots.length > 0;
  return {
    profile: complete ? 'machine.cia402.v1' : 'unavailable',
    descriptor,
    machineSnapshot,
    descriptorEntry,
    machineSnapshotEntry,
    diagnosticsEntry,
    driveSnapshots,
    controlsAvailable: controls,
    explanation: complete
      ? controls
        ? 'Profile state is schema-negotiated and the server advertises validated command services. Commands require an authenticated operator lease and are bounded by deadline and state-generation checks; they do not replace functional safety systems.'
        : 'Profile state is schema-negotiated. Motion remains read-only until the server advertises authenticated authority and validated command services.'
      : 'This server does not expose the complete machine.cia402.v1 descriptor/snapshot contract. Generic IO is available in Explore; browser motion controls are disabled.',
  };
}

export async function readMachineDescriptor(
  client: TetherIOClient,
  entry: CatalogEntry,
): Promise<MachineDescriptorView> {
  const record = await readRecord(client, entry, 'MachineDescriptorV1');
  if (!Array.isArray(record.axes)) throw new Error('MachineDescriptorV1 axes is not an array');
  const axes = record.axes.map((value): MachineAxisDescriptor => {
    const axis = asRecord(value, 'AxisDescriptorV1');
    return {
      stableId: readString(axis, 'stable_id'),
      name: readString(axis, 'name'),
      slaveIndex: readNumber(axis, 'slave_index'),
      displayOrder: readNumber(axis, 'display_order'),
      groupId: readString(axis, 'group_id'),
      positionUnit: readString(axis, 'position_unit'),
      positionScale: readNumber(axis, 'position_scale'),
      velocityUnit: readString(axis, 'velocity_unit'),
      velocityScale: readNumber(axis, 'velocity_scale'),
      supportsHoming: readBoolean(axis, 'supports_homing'),
    };
  });
  if (axes.length === 0 || axes.length > 16)
    throw new Error('MachineDescriptorV1 axis count is outside profile bounds');
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const axis of axes) {
    if (
      !axis.stableId ||
      ids.has(axis.stableId) ||
      !axis.name ||
      !Number.isInteger(axis.displayOrder) ||
      orders.has(axis.displayOrder) ||
      !Number.isFinite(axis.positionScale) ||
      axis.positionScale === 0 ||
      !Number.isFinite(axis.velocityScale) ||
      axis.velocityScale === 0
    ) {
      throw new Error('MachineDescriptorV1 contains an invalid or duplicate axis identity');
    }
    ids.add(axis.stableId);
    orders.add(axis.displayOrder);
  }
  const profileVersion = readNumber(record, 'profile_version');
  if (profileVersion !== 1)
    throw new Error(`Unsupported machine profile version ${profileVersion}`);
  const orderedAxes = [...axes];
  orderedAxes.sort((left, right) => left.displayOrder - right.displayOrder);
  return {
    profileVersion,
    machineId: readString(record, 'machine_id'),
    displayName: readString(record, 'display_name'),
    timezone: readString(record, 'timezone'),
    unitSystem: readString(record, 'unit_system'),
    axes: orderedAxes,
  };
}

export async function readMachineSnapshot(
  client: TetherIOClient,
  entry: CatalogEntry,
): Promise<MachineSnapshotView> {
  const record = await readRecord(client, entry, 'MachineSnapshotV1');
  const snapshot: MachineSnapshotView = {
    timestampUs: readBigInt(record, 'timestamp_us'),
    stateGeneration: readBigInt(record, 'state_generation'),
    simulated: readBoolean(record, 'simulated'),
    axisCount: readNumber(record, 'axis_count'),
    enabledCount: readNumber(record, 'enabled_count'),
    faultCount: readNumber(record, 'fault_count'),
    warningCount: readNumber(record, 'warning_count'),
    staleCount: readNumber(record, 'stale_count'),
    alState: readNumber(record, 'al_state'),
    expectedWkc: readNumber(record, 'expected_wkc'),
    actualWkc: readNumber(record, 'actual_wkc'),
    linkUp: readBoolean(record, 'link_up'),
    dcLocked: readBoolean(record, 'dc_locked'),
  };
  if (
    snapshot.axisCount === 0 ||
    snapshot.enabledCount > snapshot.axisCount ||
    snapshot.faultCount > snapshot.axisCount ||
    snapshot.warningCount > snapshot.axisCount ||
    snapshot.staleCount > snapshot.axisCount
  ) {
    throw new Error('MachineSnapshotV1 contains inconsistent fleet counts');
  }
  return snapshot;
}

export async function readDriveSnapshot(
  client: TetherIOClient,
  entry: CatalogEntry,
): Promise<DriveSnapshotView> {
  const record = await readRecord(client, entry, 'DriveSnapshotV1');
  return {
    timestampUs: readBigInt(record, 'timestamp_us'),
    stateGeneration: readBigInt(record, 'state_generation'),
    slaveIndex: readNumber(record, 'slave_index'),
    alStatusCode: readNumber(record, 'al_status_code'),
    statusWord: readNumber(record, 'status_word'),
    controlWord: readNumber(record, 'control_word'),
    faultCode: readNumber(record, 'fault_code'),
    qualityFlags: readNumber(record, 'quality_flags'),
    alState: readNumber(record, 'al_state'),
    ds402State: readNumber(record, 'ds402_state'),
    targetMode: readNumber(record, 'target_mode'),
    displayMode: readNumber(record, 'display_mode'),
    targetPosition: readNumber(record, 'target_position'),
    demandPosition: readNumber(record, 'demand_position'),
    actualPosition: readNumber(record, 'actual_position'),
    followingError: readNumber(record, 'following_error'),
    targetVelocity: readNumber(record, 'target_velocity'),
    actualVelocity: readNumber(record, 'actual_velocity'),
    targetTorque: readNumber(record, 'target_torque'),
    actualTorque: readNumber(record, 'actual_torque'),
    homingState: readNumber(record, 'homing_state'),
  };
}

export interface MachineDiagnosticsView {
  timestampUs: bigint;
  cycleCount: bigint;
  missedDeadlines: bigint;
  maxCycleWorkUs: number;
  jitterMaxUs: number;
  jitterAvgUs: number;
  dcSyncCount: bigint;
  dcSyncErrors: bigint;
  dcJitterMaxUs: number;
  mbxSends: bigint;
  mbxSendErrors: bigint;
  mbxCollects: bigint;
  mbxCollectErrors: bigint;
  maxSendLatencyNs: number;
  txRetries: number;
  txFailures: number;
  rxFrames: number;
  slavesDetected: number;
  slavesOperational: number;
  lastWkc: number;
}

function optionalNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (value === undefined) return 0;
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
}

function optionalBigInt(record: Record<string, unknown>, key: string): bigint {
  const value = record[key];
  if (value === undefined) return 0n;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return 0n;
}

/**
 * Read the optional machine.diagnostics signal. Field decoding is tolerant —
 * a server implementing an older/different revision may omit counters.
 */
export async function readMachineDiagnostics(
  client: TetherIOClient,
  entry: CatalogEntry,
): Promise<MachineDiagnosticsView> {
  const record = await readRecord(client, entry, 'MachineDiagnosticsV1');
  return {
    timestampUs: optionalBigInt(record, 'timestamp_us'),
    cycleCount: optionalBigInt(record, 'cycle_count'),
    missedDeadlines: optionalBigInt(record, 'missed_deadlines'),
    maxCycleWorkUs: optionalNumber(record, 'max_cycle_work_us'),
    jitterMaxUs: optionalNumber(record, 'jitter_max_us'),
    jitterAvgUs: optionalNumber(record, 'jitter_avg_us'),
    dcSyncCount: optionalBigInt(record, 'dc_sync_count'),
    dcSyncErrors: optionalBigInt(record, 'dc_sync_errors'),
    dcJitterMaxUs: optionalNumber(record, 'dc_jitter_max_us'),
    mbxSends: optionalBigInt(record, 'mbx_sends'),
    mbxSendErrors: optionalBigInt(record, 'mbx_send_errors'),
    mbxCollects: optionalBigInt(record, 'mbx_collects'),
    mbxCollectErrors: optionalBigInt(record, 'mbx_collect_errors'),
    maxSendLatencyNs: optionalNumber(record, 'max_send_latency_ns'),
    txRetries: optionalNumber(record, 'tx_retries'),
    txFailures: optionalNumber(record, 'tx_failures'),
    rxFrames: optionalNumber(record, 'rx_frames'),
    slavesDetected: optionalNumber(record, 'slaves_detected'),
    slavesOperational: optionalNumber(record, 'slaves_operational'),
    lastWkc: optionalNumber(record, 'last_wkc'),
  };
}

export function alStateLabel(state: number): string {
  return (
    ({ 1: 'INIT', 2: 'PRE-OP', 4: 'SAFE-OP', 8: 'OP' } as Record<number, string>)[state] ??
    `Unknown (${state})`
  );
}

export function ds402StateLabel(state: number): string {
  return (
    (
      {
        0: 'Not ready',
        1: 'Switch-on disabled',
        2: 'Ready to switch on',
        3: 'Switched on',
        4: 'Operation enabled',
        5: 'Quick stop active',
        6: 'Fault reaction active',
        7: 'Fault',
      } as Record<number, string>
    )[state] ?? `Unknown (${state})`
  );
}
