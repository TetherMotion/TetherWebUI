/**
 * Action tiles — everything that can write to the machine. All of them route
 * through the hub's audited command surface; when no authority lease is held
 * they render inert/disabled states (server re-checks regardless).
 */
import { html, TemplateResult } from 'lit';
import { DataHub, HubTopic } from '../data/hub';
import { MachineAction, MachineActionValue } from '../domain/machine-control';
import { ds402StateLabel } from '../domain/machine-profile';
import {
  bindHoldToRunJog,
  MotionModel,
  renderAuthorityPanel,
  renderCommandPanel,
  renderHomingPanel,
} from '../views/motion';
import { renderRecipes } from '../views/recipes';
import { icon } from '../icons';
import { optNumber, optString, TileElement } from './base';

export function motionModel(hub: DataHub, selectedTargets: string[]): MotionModel {
  return {
    controlsAvailable: hub.control?.controlsAvailable ?? false,
    lease: hub.lease
      ? {
          scope: hub.lease.scope,
          token: hub.lease.token,
          remainingMs: Math.max(0, hub.lease.expiresAtMs - Date.now()),
        }
      : undefined,
    axes: hub.commandAxes(),
    lastReceipt: hub.lastReceipt,
    selectedTargets,
    busy: hub.controlBusy,
  };
}

const ACTION_TOPICS: HubTopic[] = [
  'drives',
  'lease',
  'operations',
  'receipt',
  'services',
  'connection',
];

export class TileAuthority extends TileElement {
  private scope = 'machine';
  private leaseMs = 10000;

  protected topics(): HubTopic[] {
    return ACTION_TOPICS;
  }

  protected render(): TemplateResult {
    return html`<div id="authority-panel"></div>`;
  }

  protected updated(): void {
    const hub = this.hub;
    const host = this.querySelector<HTMLElement>('#authority-panel');
    if (!hub || !host) return;
    renderAuthorityPanel(host, motionModel(hub, []));
    const scopeInput = this.querySelector<HTMLInputElement>('#authority-scope');
    if (scopeInput && !hub.lease) scopeInput.value = this.scope;
    const leaseInput = this.querySelector<HTMLInputElement>('#authority-lease-ms');
    if (leaseInput) leaseInput.value = String(this.leaseMs);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('input', (event) => {
      const input = event.target as HTMLInputElement;
      if (input.id === 'authority-scope') this.scope = input.value;
      if (input.id === 'authority-lease-ms') this.leaseMs = Number(input.value) || 10000;
    });
    this.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button || !this.hub) return;
      const action = button.dataset.authority as
        'acquire' | 'renew' | 'release' | 'takeover' | undefined;
      if (action)
        void this.hub.authorityAction(action, this.scope.trim() || 'machine', this.leaseMs);
    });
  }
}

export class TileCommand extends TileElement {
  private readonly selected = new Set<string>();
  private deadlineMs = 5000;

  protected topics(): HubTopic[] {
    return ACTION_TOPICS;
  }

  protected render(): TemplateResult {
    return html`<div id="command-panel" class="tile-scroll"></div>`;
  }

  protected updated(): void {
    const hub = this.hub;
    const host = this.querySelector<HTMLElement>('#command-panel');
    if (!hub || !host) return;
    renderCommandPanel(host, motionModel(hub, [...this.selected]));
    const deadline = this.querySelector<HTMLInputElement>('#command-deadline-ms');
    if (deadline) deadline.value = String(this.deadlineMs);
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      const target = input.dataset?.target;
      if (!target) return;
      if (input.checked) this.selected.add(target);
      else this.selected.delete(target);
    });
    this.addEventListener('input', (event) => {
      const input = event.target as HTMLInputElement;
      if (input.id === 'command-deadline-ms') this.deadlineMs = Number(input.value) || 5000;
      if (input.id === 'jog-velocity') this.jogVelocity = Number(input.value) || 1000;
    });
    this.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button || !this.hub || button.id !== 'command-submit') return;
      const action = Number(this.querySelector<HTMLSelectElement>('#command-action')?.value ?? 0);
      void this.hub.dispatchCommand(
        action as MachineActionValue,
        [...this.selected],
        this.deadlineMs,
      );
    });
    this.disposers.push(
      bindHoldToRunJog(this, {
        start: (axis, direction) => void this.hub?.startJog(axis, direction, this.jogVelocity),
        stop: (axis) => void this.hub?.stopJog(axis),
        stopAll: () => void this.hub?.stopAllJogs(),
      }),
    );
  }

  private jogVelocity = 1000;
  private readonly disposers: (() => void)[] = [];

  disconnectedCallback(): void {
    this.disposers.forEach((d) => d());
    super.disconnectedCallback();
  }
}

export class TileJog extends TileElement {
  private velocity = 1000;
  private readonly disposers: (() => void)[] = [];

  protected topics(): HubTopic[] {
    return ACTION_TOPICS;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.disposers.push(
      bindHoldToRunJog(this, {
        start: (axis, direction) => void this.hub?.startJog(axis, direction, this.velocity),
        stop: (axis) => void this.hub?.stopJog(axis),
        stopAll: () => void this.hub?.stopAllJogs(),
      }),
    );
  }

  disconnectedCallback(): void {
    this.disposers.forEach((d) => d());
    super.disconnectedCallback();
  }

  protected render(): TemplateResult {
    const hub = this.hub;
    if (!hub?.control?.controlsAvailable)
      return html`<p class="widget-empty">Command service not advertised.</p>`;
    const axes = hub.commandAxes().filter((a) => {
      const only = optString(this.def, 'axis');
      return !only || a.stableId === only;
    });
    const canJog = !!hub.lease;
    return html`<div class="jog-pad">
      <label
        >Jog velocity
        <input
          type="number"
          min="1"
          max="1000000"
          .value=${String(this.velocity)}
          @input=${(e: Event) => (this.velocity = Number((e.target as HTMLInputElement).value) || 1000)}
        />
        drive units/s</label
      >
      ${axes.map(
        (axis) =>
          html`<div class="jog-row">
            <span class="jog-axis">${axis.name}</span>
            <button
              type="button"
              class="jog-btn"
              data-jog-axis="${axis.stableId}"
              data-jog-dir="-1"
              aria-label="Jog ${axis.name} negative (hold)"
              ?disabled=${!canJog || axis.stale}
            >
              ${icon('minus')}
            </button>
            <button
              type="button"
              class="jog-btn"
              data-jog-axis="${axis.stableId}"
              data-jog-dir="1"
              aria-label="Jog ${axis.name} positive (hold)"
              ?disabled=${!canJog || axis.stale}
            >
              ${icon('plus')}
            </button>
          </div>`,
      )}
      ${!axes.length ? html`<p class="widget-empty">No axes discovered.</p>` : ''}
      ${!canJog ? html`<p class="widget-empty">Acquire the motion lease to jog.</p>` : ''}
    </div>`;
  }
}

export class TileJogPair extends TileElement {
  private velocity = 1000;
  private readonly disposers: (() => void)[] = [];

  protected topics(): HubTopic[] {
    return ACTION_TOPICS;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.disposers.push(
      bindHoldToRunJog(this, {
        start: (axis, direction) => void this.hub?.startJog(axis, direction, this.velocity),
        stop: (axis) => void this.hub?.stopJog(axis),
        stopAll: () => void this.hub?.stopAllJogs(),
      }),
    );
  }

  disconnectedCallback(): void {
    this.disposers.forEach((d) => d());
    super.disconnectedCallback();
  }

  protected render(): TemplateResult {
    const hub = this.hub;
    const axisId = optString(this.def, 'axis') ?? '';
    const axis = hub?.commandAxes().find((a) => a.stableId === axisId);
    const enabled = hub?.canCommand && !!axis && !axis.stale;
    const label = this.def?.title ?? axis?.name ?? axisId ?? 'Axis';
    return html`<div class="panel-widget widget-jog widget-control">
      <span class="widget-label">${label}</span>
      <span class="widget-axis">${axis ? ds402StateLabel(axis.ds402State) : 'unbound'}</span>
      <div class="jog-pair">
        <button
          type="button"
          class="jog-btn"
          data-jog-axis="${axisId}"
          data-jog-dir="-1"
          aria-label="Jog ${label} negative"
          ?disabled=${!enabled}
        >
          ${icon('minus')}
        </button>
        <button
          type="button"
          class="jog-btn"
          data-jog-axis="${axisId}"
          data-jog-dir="1"
          aria-label="Jog ${label} positive"
          ?disabled=${!enabled}
        >
          ${icon('plus')}
        </button>
      </div>
    </div>`;
  }
}

export class TileCommandButton extends TileElement {
  protected topics(): HubTopic[] {
    return ACTION_TOPICS;
  }

  protected render(): TemplateResult {
    const hub = this.hub;
    const action = Number(this.def?.options?.['action'] ?? 0) as MachineActionValue;
    const axisId = optString(this.def, 'axis') ?? '';
    const label = optString(this.def, 'btnLabel') ?? this.def?.title ?? `Action ${action}`;
    const enabled = hub?.canCommand && !!axisId && !hub.controlBusy;
    return html`<div class="panel-widget widget-control">
      <span class="widget-label">${this.def?.title ?? label}</span>
      <button
        type="button"
        class="secondary"
        ?disabled=${!enabled}
        @click=${() => void this.hub?.dispatchAction(action, axisId)}
      >
        ${label}
      </button>
      ${hub?.canCommand ? '' : html`<span class="widget-state">lease required</span>`}
    </div>`;
  }
}

export class TileFnButton extends TileElement {
  protected topics(): HubTopic[] {
    return ['connection'];
  }

  protected render(): TemplateResult {
    const fn = optString(this.def, 'fn') ?? '';
    const advertised = !!this.hub?.functions.find((f) => f.name === fn);
    return html`<div class="panel-widget widget-control">
      <span class="widget-label">${this.def?.title ?? fn}</span>
      <button
        type="button"
        class="secondary"
        ?disabled=${!this.hub?.connected || !advertised}
        @click=${() => void this.hub?.invokeFunction(fn)}
      >
        ${this.def?.title ?? fn}
      </button>
      ${advertised ? '' : html`<span class="widget-state">not advertised</span>`}
    </div>`;
  }
}

export class TileHoming extends TileElement {
  protected topics(): HubTopic[] {
    return ACTION_TOPICS;
  }

  protected render(): TemplateResult {
    return html`<div id="homing-panel" class="tile-scroll"></div>`;
  }

  protected updated(): void {
    const hub = this.hub;
    const host = this.querySelector<HTMLElement>('#homing-panel');
    if (!hub || !host) return;
    renderHomingPanel(host, motionModel(hub, []), hub.homingStages, hub.runningHomingAxes());
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button || !this.hub) return;
      const axis = button.dataset.homeAxis;
      if (axis) void this.hub.homingAction(axis, button.dataset.homeStep ?? 'prepare');
    });
  }
}

export class TileRecipes extends TileElement {
  protected topics(): HubTopic[] {
    return ['services', 'connection'];
  }

  protected render(): TemplateResult {
    return html`<div id="recipes-panel" class="tile-scroll"></div>`;
  }

  protected updated(): void {
    const hub = this.hub;
    if (!hub) return;
    renderRecipes(this, {
      available: hub.control?.recipesAvailable ?? false,
      recipes: hub.recipes,
      result: hub.recipeResultText,
      busy: hub.controlBusy,
    });
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button || button.disabled || !this.hub) return;
      if (button.id === 'recipes-refresh') void this.hub.recipesLoad();
      else if (button.classList.contains('recipe-apply') && button.dataset.recipe)
        void this.hub.recipeApply(button.dataset.recipe);
    });
  }
}

customElements.define('tile-authority', TileAuthority);
customElements.define('tile-command', TileCommand);
customElements.define('tile-jog', TileJog);
customElements.define('tile-jog-pair', TileJogPair);
customElements.define('tile-command-button', TileCommandButton);
customElements.define('tile-fn-button', TileFnButton);
customElements.define('tile-homing', TileHoming);
customElements.define('tile-recipes', TileRecipes);
