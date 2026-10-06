export interface NavigationItem {
  id: string;
  label: string;
}

export function machineShellTemplate(views: NavigationItem[]): string {
  return `
      <main class="shell machine-shell">
        <header class="topbar">
          <div class="brand"><span class="brand-mark">T</span><div><strong id="machine-display-name">Tether Machine Console</strong><small>EtherCAT observability · browser controls are not safety functions</small></div></div>
          <div class="connection"><input id="url" aria-label="WebSocket URL"><input id="auth-token" type="password" aria-label="Access token" placeholder="Token" autocomplete="off"><button id="connect">Connect</button><button id="theme-toggle" class="theme-toggle" aria-label="Toggle theme">◐</button><span id="status" class="status">Offline</span></div>
        </header>
        <nav class="app-nav" aria-label="Machine console navigation">${views.map((view) => `<button class="app-nav-item${view.id === 'overview' ? ' active' : ''}" data-view="${view.id}">${view.label}</button>`).join('')}</nav>
        <div class="safety-notice" role="note"><strong>Read-only session</strong><span>This interface is not an E-stop, STO, safety PLC, or safety-rated control. Use the machine's independent hardware safety system.</span><div class="global-state"><span id="role-label">Role: unverified</span><span id="authority-label">Control owner: none</span><span id="freshness-label">Data: waiting</span><span id="alarm-label">Alarms: unavailable</span></div></div>
        <section id="machine-view" class="machine-view" aria-live="polite">
          <div class="view-heading"><div><p class="eyebrow" id="view-kicker">Machine overview</p><h1 id="view-title">Overview</h1></div><span id="profile-badge" class="badge">Profile unavailable</span></div>
          <p id="profile-explanation" class="profile-explanation"></p>
          <section id="overview-page" class="machine-page">
            <div class="overview-grid">
              <article class="machine-card"><small>Telemetry health</small><strong id="machine-health">Unknown</strong><span id="machine-health-copy">No coherent machine snapshot received.</span></article>
              <article class="machine-card"><small>Drive snapshots</small><strong id="drive-count">0</strong><span id="drive-summary">Waiting for profile data</span></article>
              <article class="machine-card"><small>Event journal</small><strong id="event-count-summary">Unavailable</strong><span id="event-summary-copy">Typed event history service not advertised</span></article>
              <article class="machine-card"><small>Motion authority</small><strong>None</strong><span>Control lease service not advertised</span></article>
            </div>
            <section class="widget-section" aria-labelledby="state-widgets-title">
              <div class="panel-title"><div><span class="eyebrow">Live typed telemetry</span><h2 id="state-widgets-title">Machine state widgets</h2></div><span class="widget-source">MachineSnapshotV1 + DriveSnapshotV1 · read-only</span></div>
              <tether-machine-state id="machine-state-widget"></tether-machine-state>
              <div id="drive-state-widgets" class="drive-state-widgets"><p class="widget-empty">Connect to a machine profile to load EtherCAT and CiA 402 widgets.</p></div>
            </section>
            <article class="machine-card overview-callout"><h2>System status</h2><p id="overview-message">Connect to a schema-negotiated machine application to load coherent fleet state.</p></article>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">Fleet health</span><h2>Drive summary</h2></div><button class="secondary" data-open-view="drives">Open drives</button></div><div id="overview-drive-list" class="overview-drive-list"></div></article>
          </section>
          <section id="drives-page" class="machine-page" hidden><div id="drive-card-list" class="drive-card-list"><p class="widget-empty">No drive snapshots discovered.</p></div></section>
          <section id="alarms-page" class="machine-page" hidden>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">Alarm lifecycle</span><h2>Active alarms</h2></div><span id="alarm-service-state" class="widget-source">Service not discovered</span></div><p class="event-history-note">Acknowledge and clear require an authenticated operator role on the server. Acknowledgement never clears a machine fault cause; clear the underlying condition first.</p><div id="alarm-table-wrap" class="table-wrap"><table class="drive-table"><thead><tr><th>Alarm</th><th>Severity</th><th>Source</th><th>Description</th><th>State</th><th>Raised</th><th>Actor</th><th>Actions</th></tr></thead><tbody id="alarm-table-body"><tr><td colspan="8" class="widget-empty">No alarm service data.</td></tr></tbody></table></div></article>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">Read-only journal</span><h2>Event history</h2></div><span class="widget-source">Server cursor · bounded history</span></div><p class="event-history-note">This is an immutable event history view. It does not acknowledge, clear, or suppress alarms.</p><tether-event-timeline id="event-timeline"></tether-event-timeline></article>
          </section>
          <section id="motion-page" class="machine-page" hidden>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">Control authority</span><h2>Motion lease</h2></div><span id="motion-service-state" class="widget-source">Service not discovered</span></div>
              <div id="authority-panel"></div>
            </article>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">Validated commands</span><h2>Command dispatch</h2></div><span class="widget-source">Deadline-bounded · generation-checked · audited</span></div>
              <div id="command-panel"></div>
            </article>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">Guided sequence</span><h2>Homing</h2></div><span class="widget-source">Prepare → start → verify · cancelable</span></div>
              <div id="homing-panel"></div>
            </article>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">In-flight & history</span><h2>Operations</h2></div><button id="operations-refresh" class="secondary">Refresh</button></div>
              <div id="operations-table-wrap" class="table-wrap"><table class="drive-table"><thead><tr><th>Operation</th><th>Action</th><th>Target</th><th>State</th><th>Progress</th><th>Message</th></tr></thead><tbody id="operations-table-body"><tr><td colspan="6" class="widget-empty">No operations.</td></tr></tbody></table></div>
            </article>
          </section>
          <section id="diagnostics-page" class="machine-page" hidden>
            <div id="diag-stale-banner" class="stale-banner" role="alert" hidden></div>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">EtherCAT bus</span><h2>Network health</h2></div><span id="diag-counts" class="widget-source">Waiting for machine snapshot</span></div><div id="diag-bus" class="diag-metrics"><p class="widget-empty">No coherent machine snapshot received.</p></div></article>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">Cyclic loop</span><h2>Loop &amp; mailbox depth</h2></div><span id="diag-cyclic-source" class="widget-source">MachineDiagnosticsV1 · optional</span></div><div id="diag-cyclic" class="diag-metrics"><p class="widget-empty">No diagnostics source attached — the optional machine.diagnostics surface is absent.</p></div></article>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">Topology</span><h2>Slave chain</h2></div><span class="widget-source">MachineSnapshotV1 + DriveSnapshotV1 · read-only</span></div><div id="diag-chain" class="diag-chain"></div><div class="table-wrap"><table class="drive-table"><thead><tr><th>Axis</th><th>Slave</th><th>AL state</th><th>AL status</th><th>CiA 402</th><th>Quality</th><th>Fault</th><th>Data age</th></tr></thead><tbody id="diag-topology-body"><tr><td colspan="8" class="widget-empty">No schema-backed drive snapshots discovered.</td></tr></tbody></table></div><p class="event-history-note">Topology reflects reported telemetry only. Functional-safety state (STO, safe position) is not observable here.</p></article>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">PDO map</span><h2>Logical-address layout</h2></div><span class="widget-source">PdoEntryArrayV1 · optional · read-only</span></div><div class="table-wrap"><table class="drive-table"><thead><tr><th>Slave</th><th>PDO</th><th>Dir</th><th>Logical offset</th><th>Length</th><th>Entry</th></tr></thead><tbody id="diag-pdo-body"><tr><td colspan="6" class="widget-empty">No PDO source attached — the optional machine.pdo.map surface is absent.</td></tr></tbody></table></div></article>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">Supervision</span><h2>Slave recovery state</h2></div><span class="widget-source">SupervisorEntryArrayV1 · optional · diagnostic only</span></div><div class="table-wrap"><table class="drive-table"><thead><tr><th>Slave</th><th>State</th><th>Suspended</th><th>Recovering</th><th>Attempts</th><th>Action</th></tr></thead><tbody id="diag-supervisor-body"><tr><td colspan="6" class="widget-empty">No supervisor attached — the optional machine.supervisor.* surface is absent.</td></tr></tbody></table></div><p id="diag-supervisor-result" class="form-result" role="status"></p><p class="event-history-note">Retry is an operator request audited by the supervisor; it does not act on functional-safety interlocks (STO/E-stop) and cannot override them.</p></article>
          </section>
          <section id="commissioning-page" class="machine-page" hidden>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">Server-side recording</span><h2>Capture</h2></div><span class="widget-source">machine.capture.* · bounded retention</span></div><div id="capture-panel"></div></article>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">Staged writes</span><h2>Configuration transaction</h2></div><span class="widget-source">machine.config.* · technician role</span></div><div id="config-panel"></div></article>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">Object dictionary</span><h2>SDO inspector</h2></div><span class="widget-source">machine.sdo.* · optional backend</span></div><div id="sdo-panel"></div></article>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">Baseline</span><h2>Config export &amp; diff</h2></div><span class="widget-source">machine.config.export/diff/import · optional</span></div><div id="baseline-panel"></div></article>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">Acceptance</span><h2>Commissioning checklist</h2></div><span class="widget-source">machine.checklist.* · optional</span></div><div id="checklist-panel"></div></article>
          </section>
          <section id="recipes-page" class="machine-page" hidden>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">Named parameter sets</span><h2>Recipes</h2></div><span class="widget-source">machine.recipe.* · staged, audited</span></div><div id="recipes-panel"></div></article>
          </section>
          <section id="panels-page" class="machine-page" hidden>
            <div id="panels-panel"></div>
          </section>
          <section id="trends-page" class="machine-page" hidden>
            <article class="machine-card"><span class="eyebrow">Live signals</span><h2>Trend workspace</h2>
              <p>Each pane has its own channel set over one shared stream. "Freeze all" halts every pane at the same instant so traces stay comparable. Derived channels and FFT are computed in this browser; capture replay decodes exported records via the server's record layout.</p>
              <div class="trend-toolbar">
                <button id="trend-freeze-all" class="secondary">Freeze all</button>
                <button id="trend-resume-all" class="secondary" hidden>Resume all</button>
                <span class="trend-layout">
                  <select id="layout-select" aria-label="Saved layouts"><option value="">Saved layouts…</option></select>
                  <input id="layout-name" type="text" maxlength="64" placeholder="Layout name" aria-label="Layout name">
                  <button id="layout-save" class="secondary">Save</button>
                  <button id="layout-delete" class="secondary">Delete</button>
                </span>
                <label class="trend-replay">Replay capture <input id="capture-replay-file" type="file" accept=".bin,application/octet-stream"></label>
              </div>
              <p class="trend-hint">Drag to zoom · right-drag to pan · click to pin measurement cursors A/B</p>
              <div id="trend-annotations" class="trend-annotations" aria-label="Annotations"></div>
              <div class="trend-panes">
                <div class="trend-pane">
                  <div class="trend-pane-head">
                    <label class="trend-picker">Pane A
                      <input id="trend-search-0" class="trend-search" type="search" placeholder="Filter channels…" aria-label="Filter pane A channels">
                      <select id="trend-select-0" multiple size="5" aria-label="Pane A channels"></select>
                    </label>
                    <div class="trend-pane-tools">
                      <select id="trend-preset-0" class="trend-preset" aria-label="Pane A preset"><option value="">Preset…</option><option value="motion">Position/velocity/torque</option><option value="error">Following error</option><option value="network">Network health</option></select>
                      <select id="trend-derive-0" class="trend-derive" aria-label="Pane A derived channel"><option value="">derived: none</option><option value="diff">A−B</option><option value="sum">Σ all</option><option value="abs">|A|</option></select>
                      <button class="secondary trend-fft" data-pane="0" title="Magnitude spectrum of the first channel's retained samples">FFT</button>
                      <button class="secondary trend-freeze" data-pane="0">Freeze</button>
                    </div>
                  </div>
                  <tether-webgpu-scope id="trend-scope-0"></tether-webgpu-scope>
                  <output id="trend-stats-0" class="trend-stats" aria-live="off"></output>
                </div>
                <div class="trend-pane">
                  <div class="trend-pane-head">
                    <label class="trend-picker">Pane B
                      <input id="trend-search-1" class="trend-search" type="search" placeholder="Filter channels…" aria-label="Filter pane B channels">
                      <select id="trend-select-1" multiple size="5" aria-label="Pane B channels"></select>
                    </label>
                    <div class="trend-pane-tools">
                      <select id="trend-preset-1" class="trend-preset" aria-label="Pane B preset"><option value="">Preset…</option><option value="motion">Position/velocity/torque</option><option value="error">Following error</option><option value="network">Network health</option></select>
                      <select id="trend-derive-1" class="trend-derive" aria-label="Pane B derived channel"><option value="">derived: none</option><option value="diff">A−B</option><option value="sum">Σ all</option><option value="abs">|A|</option></select>
                      <button class="secondary trend-fft" data-pane="1" title="Magnitude spectrum of the first channel's retained samples">FFT</button>
                      <button class="secondary trend-freeze" data-pane="1">Freeze</button>
                    </div>
                  </div>
                  <tether-webgpu-scope id="trend-scope-1"></tether-webgpu-scope>
                  <output id="trend-stats-1" class="trend-stats" aria-live="off"></output>
                </div>
              </div>
              <div id="trend-plot-overlay" class="trend-plot-overlay" hidden>
                <div class="trend-plot-dialog" role="dialog" aria-label="Frequency plot">
                  <div class="trend-plot-head">
                    <h3 id="trend-plot-title">Plot</h3>
                    <button id="trend-plot-close" class="secondary">Close</button>
                  </div>
                  <canvas id="trend-plot-canvas"></canvas>
                </div>
              </div>
            </article>
          </section>
          <section id="settings-page" class="machine-page" hidden>
            <article class="machine-card"><div class="panel-title"><div><span class="eyebrow">Local preferences</span><h2>Connection & display</h2></div><span class="widget-source">Browser-local · per origin</span></div>
              <p class="event-history-note">These settings live in this browser only. Access tokens are never persisted.</p>
              <form id="settings-form" class="config-form">
                <label>Default WebSocket URL <input id="settings-url" aria-label="Default WebSocket URL"></label>
                <label>Telemetry poll interval (ms) <input id="settings-poll-ms" type="number" min="200" max="60000" step="100"></label>
                <label>Trend stream interval (ms) <input id="settings-stream-ms" type="number" min="1" max="10000"></label>
                <div class="config-actions"><button type="submit">Save preferences</button><button type="button" id="settings-reset" class="secondary">Reset to defaults</button><button type="button" id="support-bundle" class="secondary">Download support bundle</button></div>
              </form>
              <p class="event-history-note">The support bundle is a JSON snapshot of catalog metadata, machine state, events, and service status — tokens, credentials, and network addresses are redacted before download.</p>
              <p id="build-info" class="event-history-note"></p>
            </article>
          </section>
          <section id="explore-page" class="machine-page" hidden><div class="workspace explore-workspace"><aside class="panel catalog-panel"><div class="panel-title"><div><span class="eyebrow">Expert tool</span><h2>Generic catalog</h2></div><span id="catalog-count" class="badge">0</span></div><nav class="tabs"><button class="tab active" data-tab="all">All</button><button class="tab" data-tab="signals">Signals</button><button class="tab" data-tab="params">Parameters</button><button class="tab" data-tab="functions">Functions</button></nav><tether-catalog id="catalog"></tether-catalog></aside><section class="content"><div class="scope panel"><div class="scope-head"><div><span class="eyebrow">Oscilloscope</span><h2>Selected signal trace</h2></div><div class="scope-actions"><span id="live-dot" class="live-dot">● LIVE</span><button id="pause-btn" class="secondary">Pause</button><button id="reset-zoom-btn" class="secondary" hidden>Reset zoom</button></div></div><tether-webgpu-scope id="scope"></tether-webgpu-scope></div><article class="machine-card"><h2>Generic function catalog</h2><p>Functions are descriptive only here. Motion-affecting actions are not invoked from this expert catalog.</p><tether-function-list id="functions"></tether-function-list></article></section></div></section>
          <section id="placeholder-page" class="machine-page" hidden><article class="machine-card unavailable-card"><span class="state-label">Service unavailable</span><h2 id="placeholder-title">Not advertised</h2><p id="placeholder-copy">No state is inferred from generic registry names. This server does not provide the typed, versioned service required for this view.</p></article></section>
        </section>
        <footer><span>Typed V6 telemetry · server remains authoritative</span><span>Hardware safety functions are independent</span></footer>
        <div id="toast-host" class="toast-host" aria-live="polite"></div>
      </main>`;
}
