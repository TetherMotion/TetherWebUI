/**
 * Guided-homing panel gating (plan item 58) and hold-to-run jog wiring
 * (plan item 60): pointer/keyboard/focus-loss semantics under jsdom.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  bindHoldToRunJog,
  CommandAxisOption,
  homingStateLabel,
  HomingStage,
  MotionModel,
  renderHomingPanel,
} from './motion';

function axis(overrides: Partial<CommandAxisOption> = {}): CommandAxisOption {
  return {
    stableId: 'sim-axis-x',
    name: 'X',
    generation: 1n,
    ds402State: 3, // Switched on
    stale: false,
    supportsHoming: true,
    homingState: 0,
    ...overrides,
  };
}

function model(overrides: Partial<MotionModel> = {}): MotionModel {
  return {
    controlsAvailable: true,
    lease: { scope: 'machine', token: 7n, remainingMs: 10_000 },
    axes: [axis()],
    busy: false,
    ...overrides,
  };
}

const noStages = new Map<string, HomingStage>();
const noRunning = new Set<string>();

function host(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('homingStateLabel', () => {
  it('labels known states and falls back for unknown', () => {
    expect(homingStateLabel(0)).toBe('Not homed');
    expect(homingStateLabel(3)).toBe('Referenced');
    expect(homingStateLabel(9)).toBe('State 9');
  });
});

describe('renderHomingPanel', () => {
  it('shows the safe state when controls are not advertised', () => {
    const el = host();
    renderHomingPanel(el, model({ controlsAvailable: false }), noStages, noRunning);
    expect(el.textContent).toContain('not advertised');
  });

  it('shows a placeholder when no axis supports homing', () => {
    const el = host();
    renderHomingPanel(el, model({ axes: [axis({ supportsHoming: false })] }), noStages, noRunning);
    expect(el.textContent).toContain('No axis declares homing support');
  });

  it('enables prepare but not start before the guided sequence begins', () => {
    const el = host();
    renderHomingPanel(el, model(), noStages, noRunning);
    const prepare = el.querySelector<HTMLButtonElement>('[data-home-step="prepare"]')!;
    const start = el.querySelector<HTMLButtonElement>('[data-home-step="start"]')!;
    const cancel = el.querySelector<HTMLButtonElement>('[data-home-step="cancel"]')!;
    expect(prepare.disabled).toBe(false);
    expect(start.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
  });

  it('enables start after prepare and cancel while running', () => {
    const el = host();
    const stages = new Map([['sim-axis-x', 'prepared' as HomingStage]]);
    renderHomingPanel(el, model(), stages, noRunning);
    expect(el.querySelector<HTMLButtonElement>('[data-home-step="start"]')!.disabled).toBe(false);
    expect(el.querySelector<HTMLButtonElement>('[data-home-step="cancel"]')!.disabled).toBe(false);
    expect(el.textContent).toContain('Step 2');
  });

  it('reflects a running homing operation and the referenced result', () => {
    const el = host();
    renderHomingPanel(el, model(), noStages, new Set(['sim-axis-x']));
    expect(el.textContent).toContain('Step 3');
    expect(el.querySelector<HTMLButtonElement>('[data-home-step="cancel"]')!.disabled).toBe(false);

    renderHomingPanel(el, model({ axes: [axis({ homingState: 3 })] }), noStages, noRunning);
    expect(el.textContent).toContain('Referenced');
  });

  it('disables everything without a lease or on a stale/faulted axis', () => {
    const el = host();
    renderHomingPanel(el, model({ lease: undefined }), noStages, noRunning);
    expect(el.querySelector<HTMLButtonElement>('[data-home-step="prepare"]')!.disabled).toBe(true);

    renderHomingPanel(el, model({ axes: [axis({ stale: true })] }), noStages, noRunning);
    expect(el.textContent).toContain('snapshot stale');
    expect(el.querySelector<HTMLButtonElement>('[data-home-step="prepare"]')!.disabled).toBe(true);

    renderHomingPanel(el, model({ axes: [axis({ ds402State: 7 })] }), noStages, noRunning);
    expect(el.textContent).toContain('blocked');
  });
});

describe('bindHoldToRunJog', () => {
  function fixture() {
    const el = host();
    el.innerHTML = `<button class="jog-btn" data-jog-axis="sim-axis-x" data-jog-dir="1">+</button>`;
    const handlers = { start: vi.fn(), stop: vi.fn(), stopAll: vi.fn() };
    bindHoldToRunJog(el, handlers);
    return { el, button: el.querySelector<HTMLButtonElement>('.jog-btn')!, handlers };
  }

  it('starts on pointerdown and stops on pointerup', () => {
    const { button, handlers } = fixture();
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(handlers.start).toHaveBeenCalledWith('sim-axis-x', 1);
    button.dispatchEvent(new Event('pointerup', { bubbles: true }));
    expect(handlers.stop).toHaveBeenCalledWith('sim-axis-x');
  });

  it('stops on pointercancel', () => {
    const { button, handlers } = fixture();
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    button.dispatchEvent(new Event('pointercancel', { bubbles: true }));
    expect(handlers.stop).toHaveBeenCalledWith('sim-axis-x');
  });

  it('ignores pointerdown on disabled buttons', () => {
    const { button, handlers } = fixture();
    button.disabled = true;
    button.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(handlers.start).not.toHaveBeenCalled();
  });

  it('starts on Space/Enter keydown and stops on keyup, ignoring repeats', () => {
    const { button, handlers } = fixture();
    button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(handlers.start).toHaveBeenCalledWith('sim-axis-x', 1);
    button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, repeat: true }));
    expect(handlers.start).toHaveBeenCalledTimes(1);
    button.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    expect(handlers.stop).toHaveBeenCalledWith('sim-axis-x');

    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(handlers.start).toHaveBeenCalledTimes(1);
  });

  it('stops all held jogs on window blur and page hide', () => {
    const { handlers } = fixture();
    window.dispatchEvent(new Event('blur'));
    expect(handlers.stopAll).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(handlers.stopAll).toHaveBeenCalledTimes(2);
  });

  it('disposer removes all listeners', () => {
    const el = host();
    el.innerHTML = `<button class="jog-btn" data-jog-axis="sim-axis-x" data-jog-dir="1">+</button>`;
    const handlers = { start: vi.fn(), stop: vi.fn(), stopAll: vi.fn() };
    const dispose = bindHoldToRunJog(el, handlers);
    dispose();
    el.querySelector<HTMLButtonElement>('.jog-btn')!.dispatchEvent(
      new Event('pointerdown', { bubbles: true }),
    );
    expect(handlers.start).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('blur'));
    expect(handlers.stopAll).not.toHaveBeenCalled();
  });
});
