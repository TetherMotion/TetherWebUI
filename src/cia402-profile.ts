/**
 * Fixed values for the machine.cia402.v1 IO profile.
 *
 * This layout mirrors tether/io/CiA402Profile.hpp. The wire format is
 * explicit little-endian bytes; JavaScript object layout is irrelevant.
 */

export const CIA402_PROFILE = 'machine.cia402.v1';
export const CIA402_PROFILE_VERSION = 1;
export const DRIVE_SNAPSHOT_SCHEMA = 'tether.machine.cia402.DriveSnapshotV1';
export const DRIVE_SNAPSHOT_SIZE = 64;

export const enum DriveQuality {
  None = 0,
  Stale = 1 << 0,
  Simulated = 1 << 1,
  Estimated = 1 << 2,
  EthercatDegraded = 1 << 3,
  UnitConversionFailed = 1 << 4,
}

export interface DriveSnapshotV1 {
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
  reserved: number;
}

export function encodeDriveSnapshot(value: DriveSnapshotV1): Uint8Array {
  const bytes = new Uint8Array(DRIVE_SNAPSHOT_SIZE);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, value.timestampUs, true);
  view.setBigUint64(8, value.stateGeneration, true);
  view.setUint16(16, value.slaveIndex, true);
  view.setUint16(18, value.alStatusCode, true);
  view.setUint16(20, value.statusWord, true);
  view.setUint16(22, value.controlWord, true);
  view.setUint16(24, value.faultCode, true);
  view.setUint32(26, value.qualityFlags, true);
  view.setUint8(30, value.alState);
  view.setUint8(31, value.ds402State);
  view.setInt8(32, value.targetMode);
  view.setInt8(33, value.displayMode);
  view.setInt32(34, value.targetPosition, true);
  view.setInt32(38, value.demandPosition, true);
  view.setInt32(42, value.actualPosition, true);
  view.setInt32(46, value.followingError, true);
  view.setInt32(50, value.targetVelocity, true);
  view.setInt32(54, value.actualVelocity, true);
  view.setInt16(58, value.targetTorque, true);
  view.setInt16(60, value.actualTorque, true);
  view.setUint8(62, value.homingState);
  view.setUint8(63, value.reserved);
  return bytes;
}

export function decodeDriveSnapshot(bytes: Uint8Array): DriveSnapshotV1 {
  if (bytes.length !== DRIVE_SNAPSHOT_SIZE) {
    throw new Error(
      `invalid ${DRIVE_SNAPSHOT_SCHEMA} size: expected ${DRIVE_SNAPSHOT_SIZE}, got ${bytes.length}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    timestampUs: view.getBigUint64(0, true),
    stateGeneration: view.getBigUint64(8, true),
    slaveIndex: view.getUint16(16, true),
    alStatusCode: view.getUint16(18, true),
    statusWord: view.getUint16(20, true),
    controlWord: view.getUint16(22, true),
    faultCode: view.getUint16(24, true),
    qualityFlags: view.getUint32(26, true),
    alState: view.getUint8(30),
    ds402State: view.getUint8(31),
    targetMode: view.getInt8(32),
    displayMode: view.getInt8(33),
    targetPosition: view.getInt32(34, true),
    demandPosition: view.getInt32(38, true),
    actualPosition: view.getInt32(42, true),
    followingError: view.getInt32(46, true),
    targetVelocity: view.getInt32(50, true),
    actualVelocity: view.getInt32(54, true),
    targetTorque: view.getInt16(58, true),
    actualTorque: view.getInt16(60, true),
    homingState: view.getUint8(62),
    reserved: view.getUint8(63),
  };
}
