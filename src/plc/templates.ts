/**
 * Project templates — starter .fbd.json documents offered on a fresh
 * project (and via the toolbar "Templates" button). Each file is a
 * canonical fbd.v1 project that imports through the same
 * `importFbdJson` path as a user-supplied file.
 */

import { importFbdJson, type PlcProject } from './store';
import atcRecipe from './templates/atc-recipe.fbd.json';
import deviceTerminals from './templates/device-terminals.fbd.json';
import haBridge from './templates/ha-bridge.fbd.json';
import haEntity from './templates/ha-entity.fbd.json';
import mqttLink from './templates/mqtt-link.fbd.json';
import motorControl from './templates/motor-control.fbd.json';
import profileLoop from './templates/profile-loop.fbd.json';
import safetyCircuit from './templates/safety-circuit.fbd.json';
import temperatureCell from './templates/temperature-cell.fbd.json';
import tonDebounce from './templates/ton-debounce.fbd.json';

export interface ProjectTemplate {
  /** Stable id — also the localStorage dismissal key suffix. */
  id: string;
  /** Card title. */
  name: string;
  /** One-line description shown under the title. */
  desc: string;
  /** Project name stamped onto the imported document. */
  project: string;
  /** Raw fbd.v1 document (JSON module import). */
  doc: unknown;
}

export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: 'temperature-cell',
    name: 'Temperature cell',
    desc: 'EL1014 DI → PID → PWM → EL2004 DO loop (EK_PID)',
    project: 'Temperature cell',
    doc: temperatureCell,
  },
  {
    id: 'device-terminals',
    name: 'Device terminals',
    desc: 'Mixed DI/DO/AI Beckhoff EK terminal with channel pins',
    project: 'Device terminals',
    doc: deviceTerminals,
  },
  {
    id: 'profile-loop',
    name: 'Profile control loop',
    desc: 'Ramp/soak profile + controller + heater channel (ST inline)',
    project: 'Profile loop',
    doc: profileLoop,
  },
  {
    id: 'ton-debounce',
    name: 'TON debounce',
    desc: 'Minimal timer-on-delay example network',
    project: 'TON debounce',
    doc: tonDebounce,
  },
  {
    id: 'motor-control',
    name: 'Motor control',
    desc: 'DOL starter — start/stop/overload with SR seal-in latch',
    project: 'Motor control',
    doc: motorControl,
  },
  {
    id: 'safety-circuit',
    name: 'Safety circuit',
    desc: 'E-stop + guard door — reset-required enable latch',
    project: 'Safety circuit',
    doc: safetyCircuit,
  },
  {
    id: 'ha-bridge',
    name: 'Home Assistant bridge',
    desc: 'FB_HaBridge — MQTT entities in/out + event triggers',
    project: 'HA bridge',
    doc: haBridge,
  },
  {
    id: 'ha-entity',
    name: 'HA entity (FBD)',
    desc: 'FB_HaEntity — one pin-wired Home Assistant switch/sensor',
    project: 'HA entity',
    doc: haEntity,
  },
  {
    id: 'mqtt-link',
    name: 'MQTT link (FBD)',
    desc: 'FB_MqttLink + Sub/Tx/Rx — broker link with Hdl fan-out',
    project: 'MQTT link',
    doc: mqttLink,
  },
  {
    id: 'atc-recipe',
    name: 'Batch temperature recipe',
    desc: 'FB_AtcBatch ramp/dwell/cool profile + PID + trend capture',
    project: 'ATC batch recipe',
    doc: atcRecipe,
  },
];

/**
 * Instantiate a template as a PlcProject. The document is deep-copied
 * via JSON round-trip and its `project` name is stamped, so applying
 * the same template twice yields independent projects.
 */
export function instantiateTemplate(t: ProjectTemplate): PlcProject {
  const text = JSON.stringify(t.doc);
  const project = importFbdJson(text);
  project.fbd.project = t.project;
  return project;
}

/** Picker dismissal keys — sessionStorage suppresses the auto-open
 *  for this tab, localStorage suppresses it permanently. */
export const TPL_PICKER_SESSION_KEY = 'tether.plc.tplPicker.off';
export const TPL_PICKER_FOREVER_KEY = 'tether.plc.tplPicker.never';

/** True when the picker should auto-open for a fresh empty project. */
export function tplPickerWanted(
  session: { getItem(k: string): string | null },
  local: { getItem(k: string): string | null },
): boolean {
  return (
    local.getItem(TPL_PICKER_FOREVER_KEY) === null &&
    session.getItem(TPL_PICKER_SESSION_KEY) === null
  );
}
