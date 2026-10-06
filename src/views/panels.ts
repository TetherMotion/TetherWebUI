import { AppProfile, AppProfileWidget } from '../domain/app-profile';
import { MachineAction } from '../domain/machine-control';

function esc(text: string): string {
  const element = document.createElement('span');
  element.textContent = text;
  return element.innerHTML;
}

export interface PanelsControls {
  /** Authority lease held and command surface advertised — enables jog/command. */
  canCommand: boolean;
  /** Display name of a command-target stable id, if known. */
  axisName: (stableId: string) => string | undefined;
}

export interface PanelsModel {
  /** Parsed server-signed application profile; undefined = surface absent. */
  profile?: AppProfile;
  /** Latest values keyed by catalog signal name (or `entry.field`). */
  values: ReadonlyMap<string, number | string>;
  /** Rolling numeric history for sparkline widgets, keyed like `values`. */
  history: ReadonlyMap<string, readonly number[]>;
  /** Signal names referenced by widgets that are not in the catalog. */
  unresolved: string[];
  stale: boolean;
  controls?: PanelsControls;
}

const ACTION_LABELS: Record<number, string> = {
  [MachineAction.Enable]: 'Enable',
  [MachineAction.Disable]: 'Disable',
  [MachineAction.QuickStop]: 'Quick stop',
  [MachineAction.FaultReset]: 'Fault reset',
  [MachineAction.Recover]: 'Recover',
  [MachineAction.SetMode]: 'Set mode',
  [MachineAction.JogStart]: 'Jog start',
  [MachineAction.JogStop]: 'Jog stop',
  [MachineAction.StepMove]: 'Step move',
  [MachineAction.MoveToPosition]: 'Move to position',
  [MachineAction.GroupMove]: 'Group move',
};

function widgetKey(widget: AppProfileWidget): string {
  return widget.field ? `${widget.entry}.${widget.field}` : (widget.entry ?? '');
}

function shownValue(widget: AppProfileWidget, value: number | string | undefined): string {
  if (value === undefined) return '—';
  if (typeof value !== 'number') return value;
  const decimals = widget.decimals ?? (widget.kind === 'dro' ? 3 : undefined);
  if (decimals !== undefined) return value.toFixed(decimals);
  return formatNumber(value);
}

function thresholdClass(widget: AppProfileWidget, value: number | string | undefined): string {
  if (typeof value !== 'number') return '';
  if (widget.critAbove !== undefined && value > widget.critAbove) return ' widget-crit';
  if (widget.warnAbove !== undefined && value > widget.warnAbove) return ' widget-warn';
  return '';
}

function renderWidget(widget: AppProfileWidget, model: PanelsModel): string {
  const key = widgetKey(widget);
  const value = widget.entry !== undefined ? model.values.get(key) : undefined;
  const shown = shownValue(widget, value);
  const cls =
    `panel-widget widget-${widget.kind}${thresholdClass(widget, value)}` +
    `${model.stale ? ' widget-stale' : ''}`;
  const unit = widget.unit ? `<span class="widget-unit">${esc(widget.unit)}</span>` : '';
  const label = `<span class="widget-label">${esc(widget.label)}</span>`;

  switch (widget.kind) {
    case 'bar':
    case 'gauge': {
      const min = widget.min ?? 0;
      const max = widget.max ?? 1;
      const fraction =
        typeof value === 'number' && max > min
          ? Math.min(1, Math.max(0, (value - min) / (max - min)))
          : 0;
      const pct = (fraction * 100).toFixed(1);
      const inner =
        widget.kind === 'gauge'
          ? `<div class="widget-gauge" style="--fill:${pct}%"><div class="widget-gauge-arc"></div><span class="widget-gauge-value">${shown}${unit}</span></div>`
          : `<span class="widget-value">${shown}${unit}</span>
             <div class="widget-bar"><div class="widget-bar-fill" style="width:${pct}%"></div></div>`;
      return `<div class="${cls}" role="meter" aria-valuemin="${min}" aria-valuemax="${max}" aria-valuenow="${typeof value === 'number' ? value : 0}">${label}${inner}</div>`;
    }
    case 'dro':
      return `<div class="${cls}">${label}
        <span class="widget-dro">${shown}${unit}</span></div>`;
    case 'sparkline': {
      const samples = model.history.get(key) ?? [];
      const min = widget.min ?? Math.min(...samples, 0);
      const max = widget.max ?? Math.max(...samples, 1);
      const span = max > min ? max - min : 1;
      const points = samples
        .map(
          (v, i) =>
            `${((i / Math.max(1, samples.length - 1)) * 100).toFixed(1)},${(30 - ((v - min) / span) * 28 - 1).toFixed(1)}`,
        )
        .join(' ');
      return `<div class="${cls}">${label}
        <svg class="widget-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
          ${samples.length > 1 ? `<polyline points="${points}" fill="none"/>` : ''}
        </svg>
        <span class="widget-value">${shown}${unit}</span></div>`;
    }
    case 'scene': {
      // Read-only kinematic scene (plan item 89): top-down XY view of actual
      // (filled) vs target (hollow) positions; a third axis renders as a Z bar.
      const axes = widget.axes ?? [];
      const norm = (i: number) => {
        const a = axes[i];
        if (!a) return undefined;
        const v = model.values.get(`${a.entry}.${a.field}`);
        if (typeof v !== 'number') return undefined;
        const min = a.min ?? 0;
        const max = a.max ?? 1;
        return max > min ? Math.min(1, Math.max(0, (v - min) / (max - min))) : 0;
      };
      const normTarget = (i: number) => {
        const a = axes[i];
        if (!a?.targetField) return undefined;
        const v = model.values.get(`${a.entry}.${a.targetField}`);
        if (typeof v !== 'number') return undefined;
        const min = a.min ?? 0;
        const max = a.max ?? 1;
        return max > min ? Math.min(1, Math.max(0, (v - min) / (max - min))) : 0;
      };
      const xa = norm(0);
      const ya = norm(1);
      const xt = normTarget(0);
      const yt = normTarget(1);
      const za = norm(2);
      const zt = normTarget(2);
      const px = (f: number) => (8 + f * 84).toFixed(1);
      const py = (f: number) => (92 - f * 84).toFixed(1);
      const nameOf = (i: number) => esc(axes[i]?.name ?? 'xyz'[i] ?? `a${i}`);
      const actual =
        xa !== undefined && ya !== undefined
          ? `<circle class="scene-actual" cx="${px(xa)}" cy="${py(ya)}" r="4"/>`
          : '';
      const target =
        xt !== undefined && yt !== undefined
          ? `<circle class="scene-target" cx="${px(xt)}" cy="${py(yt)}" r="4"/>`
          : '';
      const zBar =
        axes.length > 2
          ? `<rect x="104" y="8" width="6" height="84" class="scene-frame"/>
             ${za !== undefined ? `<rect x="104" y="${(92 - za * 84).toFixed(1)}" width="6" height="${(za * 84).toFixed(1)}" class="scene-actual"/>` : ''}
             ${zt !== undefined ? `<line x1="102" y1="${(92 - zt * 84).toFixed(1)}" x2="112" y2="${(92 - zt * 84).toFixed(1)}" class="scene-target"/>` : ''}
             <text x="107" y="98" class="scene-axis-label" text-anchor="middle">${nameOf(2)}</text>`
          : '';
      const summary = axes
        .map(
          (a, i) =>
            `${a.name ?? 'xyz'[i]}=${esc(shownValue({ ...widget, decimals: widget.decimals ?? 0 }, model.values.get(`${a.entry}.${a.field}`)))}`,
        )
        .join(' ');
      return `<div class="${cls}">${label}
        <svg class="widget-scene" viewBox="0 0 ${axes.length > 2 ? 114 : 100} 100" role="img" aria-label="${esc(widget.label)}: ${esc(summary)}">
          <rect x="8" y="8" width="84" height="84" class="scene-frame"/>
          ${target}${actual}${zBar}
          <text x="50" y="4" class="scene-axis-label" text-anchor="middle">${nameOf(1) ?? ''}</text>
          <text x="96" y="98" class="scene-axis-label" text-anchor="end">${nameOf(0)}</text>
        </svg>
        <span class="widget-value">${esc(summary)}${unit}</span></div>`;
    }
    case 'state':
    case 'lamp': {
      const text = widget.states?.[String(value)] ?? shown;
      const level =
        typeof value === 'number' && widget.critAbove !== undefined && value > widget.critAbove
          ? 'crit'
          : typeof value === 'number' && widget.warnAbove !== undefined && value > widget.warnAbove
            ? 'warn'
            : 'ok';
      if (widget.kind === 'lamp')
        return `<div class="${cls}"><span class="widget-lamp lamp-${level}" role="img" aria-label="${esc(text)}"></span>${label}<span class="widget-state">${esc(text)}</span></div>`;
      return `<div class="${cls}">${label}<span class="widget-state">${esc(text)}</span></div>`;
    }
    case 'jog': {
      const enabled = model.controls?.canCommand ?? false;
      const axisLabel = model.controls?.axisName(widget.axis!) ?? widget.axis ?? '';
      const axis = esc(widget.axis ?? '');
      const valuePart =
        widget.entry !== undefined ? `<span class="widget-dro">${shown}${unit}</span>` : '';
      return `<div class="${cls} widget-control">${label}
        <span class="widget-axis">${esc(axisLabel)}</span>${valuePart}
        <div class="jog-pair">
          <button type="button" class="jog-btn" data-jog-axis="${axis}" data-jog-dir="-1" aria-label="Jog ${esc(widget.label)} negative" ${enabled ? '' : 'disabled'}>−</button>
          <button type="button" class="jog-btn" data-jog-axis="${axis}" data-jog-dir="1" aria-label="Jog ${esc(widget.label)} positive" ${enabled ? '' : 'disabled'}>+</button>
        </div></div>`;
    }
    case 'command': {
      const enabled = model.controls?.canCommand ?? false;
      const action = widget.action!;
      const actionLabel = ACTION_LABELS[action] ?? `Action ${action}`;
      const axis = esc(widget.axis ?? '');
      return `<div class="${cls} widget-control">${label}
        <button type="button" class="secondary" data-widget-cmd-action="${action}" data-widget-cmd-axis="${axis}" ${enabled ? '' : 'disabled'}>${esc(widget.label || actionLabel)}</button>
        ${value !== undefined ? `<span class="widget-state">${esc(shown)}</span>` : ''}</div>`;
    }
    case 'button': {
      const enabled = model.controls?.canCommand ?? false;
      return `<div class="${cls} widget-control">${label}
        <button type="button" class="secondary" data-widget-fn="${esc(widget.fn!)}" ${enabled ? '' : 'disabled'}>${esc(widget.label)}</button></div>`;
    }
    default:
      return `<div class="${cls}">${label}<span class="widget-value">${shown}${unit}</span></div>`;
  }
}

function formatNumber(value: number): string {
  return Math.abs(value) >= 1000 ? value.toPrecision(4) : String(Math.round(value * 1000) / 1000);
}

export function renderPanels(root: HTMLElement, model: PanelsModel): void {
  const panel = root.querySelector<HTMLElement>('#panels-panel');
  if (!panel) return;
  if (!model.profile) {
    panel.innerHTML =
      '<p class="widget-empty">This server does not advertise a signed application profile (machine.app.profile). Custom panels are absent.</p>';
    return;
  }
  const unresolved = model.unresolved.length
    ? `<p class="form-result" role="status">Unresolved signals: ${model.unresolved.map(esc).join(', ')} — the profile references entries absent from the current catalog.</p>`
    : '';
  const controlsNote =
    model.controls && !model.controls.canCommand
      ? '<p class="form-result" role="status">Control widgets are inert — acquire an authority lease (Settings) and hold an operator+ role.</p>'
      : '';
  const panels = model.profile.panels
    .map(
      (
        p,
      ) => `<article class="machine-card panel-card"><div class="panel-title"><div><span class="eyebrow">${esc(p.id)}</span><h3>${esc(p.title)}</h3></div></div>
      <div class="panel-widgets">${p.widgets.map((w) => renderWidget(w, model)).join('')}</div></article>`,
    )
    .join('');
  panel.innerHTML = `
    <p class="event-history-note">Profile <code>${esc(model.profile.name)} v${esc(model.profile.version)}</code> · signature <code>${esc(model.profile.signatureHex)}…</code> · verified server-side. Display widgets are read-only; controls use the audited authority-gated command surface.</p>
    ${unresolved}${controlsNote}
    <div class="panel-grid">${panels || '<p class="widget-empty">The profile defines no panels.</p>'}</div>`;
}
