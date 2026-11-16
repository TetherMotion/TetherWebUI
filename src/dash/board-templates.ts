/**
 * Board templates for the "New board" picker.
 *
 * Each template produces a ready-made BoardDoc with fresh tile ids —
 * operator presets that pre-place the new HMI tiles (faceplate,
 * profile run) next to the alarm/event surfaces so a temperature
 * cell is one click instead of a from-scratch layout. Prefix options
 * carry placeholders the user edits to their PLC instance names.
 */
import { BOARD_FORMAT, BoardDoc, makeTile } from './model';

export interface BoardTemplate {
  id: string;
  title: string;
  description: string;
  /** Tiles for the template board (fresh ids each call). */
  tiles(): BoardDoc['tiles'];
}

export const BOARD_TEMPLATES: BoardTemplate[] = [
  {
    id: 'blank',
    title: 'Blank board',
    description: 'Empty canvas — add tiles from the gallery.',
    tiles: () => [],
  },
  {
    id: 'temperature-cell',
    title: 'Temperature cell',
    description:
      'Operator panel for one temperature loop: loop faceplate (PV/SP/commands), FB_AtcProfile run status, alarms.',
    tiles: () => [
      makeTile(
        'faceplate',
        { x: 0, y: 0, w: 4, h: 4 },
        {
          title: 'Loop TIC101',
          options: {
            kind: 'loop',
            prefix: 'plc.Main.TIC101',
            title: 'TIC101',
            min: 0,
            max: 200,
          },
        },
      ),
      makeTile(
        'profile',
        { x: 4, y: 0, w: 4, h: 3 },
        {
          options: { prefix: 'plc.Main.Prof', title: 'Profile', unit: '°C' },
        },
      ),
      makeTile(
        'alarm-list',
        { x: 8, y: 0, w: 4, h: 4 },
        { title: 'Alarms' },
      ),
      makeTile(
        'note',
        { x: 0, y: 4, w: 12, h: 2 },
        {
          options: {
            text: 'Edit each tile to point at your PLC instances — e.g. faceplate prefix plc.POU1.TIC101 (PV/SP/OUT/AUTO/…), profile prefix plc.POU1.prof (FB_AtcProfile members).',
          },
        },
      ),
    ],
  },
  {
    id: 'motor-cell',
    title: 'Motor cell',
    description:
      'Motor operator panel: state/run/fwd/rev/ready/fault faceplate plus alarms.',
    tiles: () => [
      makeTile(
        'faceplate',
        { x: 0, y: 0, w: 4, h: 4 },
        {
          title: 'Motor M101',
          options: {
            kind: 'motor',
            prefix: 'plc.Main.M101',
            title: 'M101',
          },
        },
      ),
      makeTile(
        'alarm-list',
        { x: 4, y: 0, w: 4, h: 4 },
        { title: 'Alarms' },
      ),
      makeTile(
        'note',
        { x: 0, y: 4, w: 12, h: 2 },
        {
          options: {
            text: 'Edit the faceplate prefix to your motor FB instance (e.g. plc.POU1.M101) — roles resolve as prefix.STATE/.RUN/.FWD/.REV/.READY/.FAULT/... .',
          },
        },
      ),
    ],
  },
];

/** Build a user board from a template id (fresh tile ids). */
export function boardFromTemplate(
  templateId: string,
  title?: string,
): BoardDoc | undefined {
  const tpl = BOARD_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) return undefined;
  const n = title ?? tpl.title;
  return {
    format: BOARD_FORMAT,
    id: `user.${crypto.randomUUID().slice(0, 8)}`,
    title: n,
    source: 'user',
    tiles: tpl.tiles(),
  };
}
