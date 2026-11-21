/**
 * Freeform HMI screen tiles — render/design `hmi.screen.v1` documents
 * (src/hmi/screen.ts) on the board:
 *
 *  - tile-hmi-screen:     runtime view — saved screen + live catalog
 *                         values composited into one scene (SVG/WebGPU
 *                         via the shared scene path).
 *  - tile-hmi-designer:   embeds <hmi-screen-designer> — palette, drag,
 *                         resize, signal binding; saves to localStorage.
 *
 * Screen name comes from tile option `screen` (default 'screen1').
 */
import { html, TemplateResult } from 'lit';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { HubTopic } from '../data/hub';
import { TileDef } from '../dash/model';
import { TileElement, optString } from './base';
import { sceneToSvg, HmiScene } from '../hmi/scene';
import { webgpuSceneEnabled, paintWebGpuScene } from '../hmi/webgpu-scene';
import {
  HmiScreen, ScreenValues, defaultScreen, loadScreen, saveScreen,
  screenScene, normalizeScreen,
} from '../hmi/screen';
import '../hmi/screen-designer';
import type { HmiScreenDesigner } from '../hmi/screen-designer';

function screenName(def?: TileDef): string {
  return optString(def, 'screen') ?? 'screen1';
}

function screenValues(hubValues: Map<string, number | string>): ScreenValues {
  const out: ScreenValues = {};
  for (const [k, v] of hubValues) out[k] = v;
  return out;
}

export class TileHmiScreen extends TileElement {
  private screen?: HmiScreen;
  private lastScene?: HmiScene;

  protected topics(): HubTopic[] { return ['values', 'catalog']; }

  protected bindingKeys(): string[] {
    return (this.screen?.widgets ?? [])
      .map((w) => w.signal)
      .filter((s): s is string => !!s);
  }

  protected onHub(): void {
    this.screen = loadScreen(localStorage, screenName(this.def)) ?? defaultScreen(screenName(this.def));
    this.lastScene = screenScene(this.screen, screenValues(this.hub?.values ?? new Map()));
    if (webgpuSceneEnabled() && this.lastScene) paintWebGpuScene(this, this.lastScene);
    this.requestUpdate();
  }

  render(): TemplateResult {
    const sc = this.lastScene;
    if (!sc) return html`<div class="hmi-scene-wrap plc-dim">no screen</div>`;
    if (webgpuSceneEnabled())
      return html`<div class="hmi-scene-wrap"><div class="hmi-gpu-host"></div></div>`;
    return html`<div class="hmi-scene-wrap">${unsafeHTML(sceneToSvg(sc, 'hmi-scene-svg'))}</div>`;
  }
}
customElements.define('tile-hmi-screen', TileHmiScreen);

export class TileHmiDesigner extends TileElement {
  private screen?: HmiScreen;

  protected topics(): HubTopic[] { return ['values', 'catalog']; }

  private designerScreen(): HmiScreen {
    if (!this.screen)
      this.screen = loadScreen(localStorage, screenName(this.def)) ?? defaultScreen(screenName(this.def));
    return this.screen;
  }

  private catalogSignals(): string[] {
    const hub = this.hub;
    if (!hub) return [];
    return [...hub.params, ...hub.signals].map((e) => e.name).sort();
  }

  private onScreenChange = (e: CustomEvent<string>): void => {
    const s = normalizeScreen(JSON.parse(e.detail));
    if (!s) return;
    this.screen = s;
    saveScreen(localStorage, s);
  };

  render(): TemplateResult {
    const s = this.designerScreen();
    return html`
      <hmi-screen-designer
        .screen=${s}
        .signals=${this.catalogSignals()}
        .values=${screenValues(this.hub?.values ?? new Map())}
        @change=${this.onScreenChange}
      ></hmi-screen-designer>`;
  }
}
customElements.define('tile-hmi-designer', TileHmiDesigner);
