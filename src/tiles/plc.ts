/**
 * tile-plc-ide — board tile hosting the TetherPLC IDE.
 * The IDE is a standalone element (src/plc/plc-ide); this tile only
 * forwards the hub so watch/deploy share the machine connection.
 */
import { html } from 'lit';
import { TileElement } from './base';
import '../plc/plc-ide';

export class TilePlcIde extends TileElement {
  protected render() {
    return html`<tether-plc-ide .hub=${this.hub}></tether-plc-ide>`;
  }
}

customElements.define('tile-plc-ide', TilePlcIde);
