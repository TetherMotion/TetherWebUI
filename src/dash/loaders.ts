/**
 * Lazy tile loaders — each tile module is a separate bundle chunk, imported
 * the first time one of its elements is needed. Loaders are keyed by custom
 * element tag so every mount point (tile frame, drawers, overlays) can await
 * registration before creating the element.
 */

const loadDisplay = () => import('../tiles/display');
const loadMachine = () => import('../tiles/machine');
const loadAnalysis = () => import('../tiles/analysis');
const loadActions = () => import('../tiles/actions');
const loadTools = () => import('../tiles/tools');
const loadFaceplate = () => import('../tiles/faceplate');
const loadProfile = () => import('../tiles/profile');
const loadHmi = () => import('../tiles/hmi');
const loadHmiw = () => import('../tiles/hmiw');

const TAG_LOADERS: Record<string, () => Promise<unknown>> = {
  // tiles/display.ts
  'tile-value': loadDisplay,
  'tile-gauge': loadDisplay,
  'tile-bar': loadDisplay,
  'tile-state': loadDisplay,
  'tile-lamp': loadDisplay,
  'tile-sparkline': loadDisplay,
  'tile-scene': loadDisplay,
  // tiles/machine.ts
  'tile-machine-state': loadMachine,
  'tile-drive-cards': loadMachine,
  'tile-diag-bus': loadMachine,
  'tile-diag-chain': loadMachine,
  'tile-diag-topology': loadMachine,
  'tile-diag-cyclic': loadMachine,
  'tile-supervisor': loadMachine,
  'tile-pdo-map': loadMachine,
  // tiles/analysis.ts
  'tile-alarm-list': loadAnalysis,
  'tile-event-timeline': loadAnalysis,
  'tile-operations': loadAnalysis,
  'tile-scope': loadAnalysis,
  // tiles/actions.ts
  'tile-authority': loadActions,
  'tile-command': loadActions,
  'tile-jog': loadActions,
  'tile-jog-pair': loadActions,
  'tile-command-button': loadActions,
  'tile-fn-button': loadActions,
  'tile-homing': loadActions,
  'tile-recipes': loadActions,
  // tiles/tools.ts
  'tile-sdo-inspector': loadTools,
  'tile-config-txn': loadTools,
  'tile-capture': loadTools,
  'tile-baseline': loadTools,
  'tile-checklist': loadTools,
  'tile-catalog': loadTools,
  'tile-note': loadTools,
  // tiles/faceplate.ts
  'tile-faceplate': loadFaceplate,
  // tiles/profile.ts
  'tile-profile': loadProfile,
  // tiles/hmi.ts
  'tile-trend': loadHmi,
  'tile-bitbutton': loadHmi,
  // tiles/hmiw.ts — scene-native widgets (shared HMI scene IR → SVG web /
  // Vulkan native, identical views)
  'tile-hmi-gauge': loadHmiw,
  'tile-hmi-bar': loadHmiw,
  'tile-hmi-digital': loadHmiw,
  'tile-hmi-lamp': loadHmiw,
  'tile-hmi-alarms': loadHmiw,
};

/** In-flight module loads, deduped by loader so one import serves all tags in a module. */
const inflight = new Map<() => Promise<unknown>, Promise<void>>();

/**
 * Resolve once the custom element for `tag` is registered. Tags without a
 * loader (e.g. already-eagerly imported in tests) resolve immediately.
 */
export function ensureTileTag(tag: string): Promise<void> {
  const loader = TAG_LOADERS[tag];
  if (!loader || customElements.get(tag)) return Promise.resolve();
  let pending = inflight.get(loader);
  if (!pending) {
    pending = loader().then(
      () => undefined,
      (err: unknown) => {
        inflight.delete(loader);
        throw err;
      },
    );
    inflight.set(loader, pending);
  }
  return pending;
}
