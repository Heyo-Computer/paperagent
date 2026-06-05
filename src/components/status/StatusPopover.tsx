import { useState, useEffect } from "preact/hooks";
import { statusPopoverOpen, agentStatus, agentMode, deployUrl } from "../../state/store";
import {
  getStatusInfo, stopVm, setupAgent, startAgent, stopAgent, getRecentLogs,
  getCalendarStatus, syncCalendarToTodos,
  deployAgent, connectRemote, disconnectRemote, teardownDeploy,
  connectP2p, disconnectP2p, getDeploymentInfo,
  connectNetwork, listNetworkServices,
  listSandboxes, getAgentConfig, setAgentConfig, updateAgent,
} from "../../api/commands";
import { listen } from "@tauri-apps/api/event";
import type { StatusInfo, CalendarStatus, DeploymentInfo, NetworkServiceInfo } from "../../types";

function StatusDot({ status }: { status: string }) {
  const cls =
    status === "running" ? "running" :
    status === "starting" || status === "reconnecting" ? "starting" :
    status === "error" || status === "unreachable" ? "error" :
    "disconnected";
  return <span class={`status-indicator ${cls}`} />;
}

function Row({ label, value, status }: { label: string; value: string; status?: string }) {
  return (
    <div class="status-row">
      {status !== undefined && <StatusDot status={status} />}
      <span class="status-row-label">{label}</span>
      <span class="status-row-value">{value}</span>
    </div>
  );
}

function ModeLabel({ mode }: { mode: string }) {
  const label =
    mode === "deployed" ? "Deployed" :
    mode === "remote" ? "Remote" :
    mode === "p2p" ? "P2P" :
    mode === "network" ? "Network" : "Local";
  const cls = mode === "local" ? "disconnected" : "running";
  return (
    <div class="status-row">
      <StatusDot status={cls} />
      <span class="status-row-label">Mode</span>
      <span class="status-row-value">{label}</span>
    </div>
  );
}

export function StatusPopover() {
  const [info, setInfo] = useState<StatusInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [setupRunning, setSetupRunning] = useState(false);
  const [setupProgress, setSetupProgress] = useState("");
  const [deployRunning, setDeployRunning] = useState(false);
  const [deployProgress, setDeployProgress] = useState("");
  const [actionMsg, setActionMsg] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [logContent, setLogContent] = useState("");
  const [calStatus, setCalStatus] = useState<CalendarStatus | null>(null);
  const [calSyncing, setCalSyncing] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [connectingRemote, setConnectingRemote] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [p2pTicket, setP2pTicket] = useState("");
  const [p2pRelay, setP2pRelay] = useState("");
  const [connectingP2p, setConnectingP2p] = useState(false);
  const [showP2p, setShowP2p] = useState(false);
  const [deployInfo, setDeployInfo] = useState<DeploymentInfo | null>(null);
  const [showNetwork, setShowNetwork] = useState(false);
  const [networkServices, setNetworkServices] = useState<NetworkServiceInfo[]>([]);
  const [loadingNetwork, setLoadingNetwork] = useState(false);
  const [connectingNetwork, setConnectingNetwork] = useState("");
  const [copied, setCopied] = useState(false);
  const [existingSandboxes, setExistingSandboxes] = useState<string[]>([]);
  const [showSandboxPicker, setShowSandboxPicker] = useState(false);
  const [selectedSandbox, setSelectedSandbox] = useState("");

  function refresh() {
    setLoading(true);
    setActionMsg("");
    getStatusInfo()
      .then((si) => {
        setInfo(si);
        agentMode.value = si.agent_mode;
        deployUrl.value = si.deploy_url;
      })
      .catch(() => setInfo(null))
      .finally(() => setLoading(false));
    // Deployment info carries the P2P ticket (so it survives a relaunch) — used
    // to display what we're connected to in P2P mode.
    getDeploymentInfo().then(setDeployInfo).catch(() => setDeployInfo(null));
  }

  useEffect(() => {
    if (statusPopoverOpen.value) {
      refresh();
      setShowLogs(false);
      setCopied(false);
      setShowSandboxPicker(false);
      getCalendarStatus()
        .then(setCalStatus)
        .catch(() => setCalStatus(null));
      listSandboxes()
        .then(setExistingSandboxes)
        .catch(() => setExistingSandboxes([]));
    }
  }, [statusPopoverOpen.value]);

  useEffect(() => {
    let unlisten1: (() => void) | undefined;
    let unlisten2: (() => void) | undefined;
    listen<string>("setup-progress", (e) => {
      setSetupProgress(e.payload);
    }).then((fn) => { unlisten1 = fn; });
    listen<string>("deploy-progress", (e) => {
      setDeployProgress(e.payload);
    }).then((fn) => { unlisten2 = fn; });
    return () => { unlisten1?.(); unlisten2?.(); };
  }, []);

  function loadLogs() {
    getRecentLogs(50).then(setLogContent).catch(() => setLogContent("(failed to load logs)"));
  }

  function toggleLogs() {
    const next = !showLogs;
    setShowLogs(next);
    if (next) loadLogs();
  }

  if (!statusPopoverOpen.value) return null;

  function close() {
    statusPopoverOpen.value = false;
  }

  // ── Local mode handlers ──

  async function handleFullSetup() {
    setSetupRunning(true);
    setSetupProgress("Starting setup...");
    setActionMsg("");
    agentStatus.value = "starting";
    try {
      const result = await setupAgent();
      setActionMsg(result);
      agentStatus.value = "running";
      refresh();
    } catch (e) {
      setActionMsg(`Setup failed: ${e}`);
      agentStatus.value = "error";
      setShowLogs(true);
      loadLogs();
    } finally {
      setSetupRunning(false);
      setSetupProgress("");
    }
  }

  async function handleAttachExisting() {
    if (!selectedSandbox) return;
    setSetupRunning(true);
    setSetupProgress(`Attaching to '${selectedSandbox}'...`);
    setActionMsg("");
    agentStatus.value = "starting";
    try {
      const cfg = await getAgentConfig();
      await setAgentConfig({ ...cfg, vm_name: selectedSandbox });
      const result = await setupAgent();
      setActionMsg(result);
      agentStatus.value = "running";
      setShowSandboxPicker(false);
      refresh();
    } catch (e) {
      setActionMsg(`Attach failed: ${e}`);
      agentStatus.value = "error";
      setShowLogs(true);
      loadLogs();
    } finally {
      setSetupRunning(false);
      setSetupProgress("");
    }
  }

  async function handleStopVm() {
    setActionMsg("");
    try {
      await stopVm();
      setActionMsg("Sandbox stopped");
      refresh();
    } catch (e) {
      setActionMsg(`Error: ${e}`);
    }
  }

  async function handleUpdateAgent() {
    setSetupRunning(true);
    setSetupProgress("Updating agent...");
    setActionMsg("");
    try {
      const result = await updateAgent();
      setActionMsg(result);
      agentStatus.value = "running";
      refresh();
    } catch (e) {
      setActionMsg(`Update failed: ${e}`);
      agentStatus.value = "error";
      setShowLogs(true);
      loadLogs();
    } finally {
      setSetupRunning(false);
      setSetupProgress("");
    }
  }

  async function handleStartAgent() {
    setActionMsg("");
    agentStatus.value = "starting";
    try {
      await startAgent();
      setActionMsg("Agent started");
      agentStatus.value = "running";
      refresh();
    } catch (e) {
      setActionMsg(`Error: ${e}`);
      agentStatus.value = "error";
    }
  }

  async function handleStopAgent() {
    setActionMsg("");
    try {
      await stopAgent();
      setActionMsg("Agent stopped");
      agentStatus.value = "disconnected";
      refresh();
    } catch (e) {
      setActionMsg(`Error: ${e}`);
    }
  }

  // ── Deploy handlers ──

  async function handleDeploy() {
    setDeployRunning(true);
    setDeployProgress("Starting deployment...");
    setActionMsg("");
    agentStatus.value = "starting";
    try {
      const url = await deployAgent();
      setActionMsg(`Deployed at ${url}`);
      agentStatus.value = "running";
      agentMode.value = "deployed";
      deployUrl.value = url;
      refresh();
    } catch (e) {
      setActionMsg(`Deploy failed: ${e}`);
      agentStatus.value = "error";
      setShowLogs(true);
      loadLogs();
    } finally {
      setDeployRunning(false);
      setDeployProgress("");
    }
  }

  async function handleTeardown() {
    setActionMsg("");
    try {
      await teardownDeploy();
      setActionMsg("Deployment stopped");
      agentStatus.value = "disconnected";
      agentMode.value = "local";
      deployUrl.value = null;
      refresh();
    } catch (e) {
      setActionMsg(`Error: ${e}`);
    }
  }

  // ── Remote connect handlers ──

  async function handleConnect() {
    if (!remoteUrl.trim()) return;
    setConnectingRemote(true);
    setActionMsg("");
    agentStatus.value = "starting";
    try {
      const msg = await connectRemote(remoteUrl.trim());
      setActionMsg(msg);
      agentStatus.value = "running";
      agentMode.value = "remote";
      deployUrl.value = remoteUrl.trim();
      setRemoteUrl("");
      setShowConnect(false);
      refresh();
    } catch (e) {
      setActionMsg(`Connect failed: ${e}`);
      agentStatus.value = "error";
    } finally {
      setConnectingRemote(false);
    }
  }

  async function handleDisconnect() {
    setActionMsg("");
    try {
      await disconnectRemote();
      setActionMsg("Disconnected");
      agentStatus.value = "disconnected";
      agentMode.value = "local";
      deployUrl.value = null;
      refresh();
    } catch (e) {
      setActionMsg(`Error: ${e}`);
    }
  }

  // ── P2P connect handlers ──

  async function handleConnectP2p() {
    if (!p2pTicket.trim()) return;
    setConnectingP2p(true);
    setActionMsg("");
    agentStatus.value = "starting";
    try {
      const msg = await connectP2p(p2pTicket.trim(), p2pRelay.trim() || undefined);
      setActionMsg(msg);
      agentStatus.value = "running";
      agentMode.value = "p2p";
      setP2pTicket("");
      setP2pRelay("");
      setShowP2p(false);
      refresh();
    } catch (e) {
      setActionMsg(`P2P connect failed: ${e}`);
      agentStatus.value = "error";
    } finally {
      setConnectingP2p(false);
    }
  }

  async function handleDisconnectP2p() {
    setActionMsg("");
    try {
      await disconnectP2p();
      setActionMsg("Disconnected");
      agentStatus.value = "disconnected";
      agentMode.value = "local";
      deployUrl.value = null;
      refresh();
    } catch (e) {
      setActionMsg(`Error: ${e}`);
    }
  }

  // ── Network connect handlers ──

  async function handleToggleNetwork() {
    const next = !showNetwork;
    setShowNetwork(next);
    if (next && networkServices.length === 0) {
      setLoadingNetwork(true);
      setActionMsg("");
      try {
        setNetworkServices(await listNetworkServices());
      } catch (e) {
        setActionMsg(`Couldn't list network services: ${e}`);
      } finally {
        setLoadingNetwork(false);
      }
    }
  }

  async function handleConnectNetwork(svc: NetworkServiceInfo) {
    setConnectingNetwork(svc.address);
    setActionMsg("");
    agentStatus.value = "starting";
    try {
      const msg = await connectNetwork(svc.name, svc.port);
      setActionMsg(msg);
      agentStatus.value = "running";
      agentMode.value = "network";
      setShowNetwork(false);
      refresh();
    } catch (e) {
      setActionMsg(`Network connect failed: ${e}`);
      agentStatus.value = "error";
    } finally {
      setConnectingNetwork("");
    }
  }

  async function handleCopyUrl() {
    const url = info?.deploy_url || deployUrl.value;
    if (url) {
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        setActionMsg("Failed to copy URL");
      }
    }
  }

  async function handleCalendarSync() {
    setCalSyncing(true);
    setActionMsg("");
    try {
      const msg = await syncCalendarToTodos();
      setActionMsg(msg);
    } catch (e) {
      setActionMsg(`Calendar sync failed: ${e}`);
    } finally {
      setCalSyncing(false);
    }
  }

  const mode = info?.agent_mode || agentMode.value;
  const currentDeployUrl = info?.deploy_url || deployUrl.value;
  const needsSetup = info && info.sandbox_status === "not_created";
  const sandboxStopped = info && info.sandbox_status === "stopped";
  const isLocal = mode === "local";
  const isDeployed = mode === "deployed";
  const isRemote = mode === "remote";
  const isP2p = mode === "p2p";
  const isNetwork = mode === "network";
  return (
    <div class="status-popover-overlay" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="status-popover">
        <div class="status-popover-header">
          <span class="status-popover-title">Status</span>
          <button class="settings-close" onClick={close} title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>

        {loading && !info && (
          <div class="status-popover-body">
            <span class="status-loading">Loading...</span>
          </div>
        )}

        {info && (
          <div class="status-popover-body">
            {/* Agent & mode status */}
            <Row label="Agent" value={info.agent_status} status={info.agent_status} />
            {info.agent_error && <div class="status-error">{info.agent_error}</div>}
            <ModeLabel mode={mode} />

            {/* Deploy URL (when deployed or remote) */}
            {currentDeployUrl && (isDeployed || isRemote) && (
              <div class="status-row">
                <span class="status-row-label">URL</span>
                <span class="status-row-value" style={{ fontSize: "10px", fontFamily: "var(--font-mono)" }}>
                  {currentDeployUrl.replace(/^https?:\/\//, "")}
                </span>
                <button
                  class="btn btn-sm btn-ghost"
                  onClick={handleCopyUrl}
                  style={{ marginLeft: "auto", padding: "1px 6px", fontSize: "10px" }}
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            )}

            {/* Local sandbox info (only in local mode) */}
            {isLocal && (
              <>
                <Row label="Sandbox" value={info.sandbox_status} status={
                  info.sandbox_status === "running" ? "running" :
                  info.sandbox_status === "stopped" ? "disconnected" :
                  info.sandbox_status === "not_created" ? "disconnected" : "error"
                } />
                <Row label="Name" value={info.sandbox_name} />
                {info.sandbox_error && <div class="status-error">{info.sandbox_error}</div>}
              </>
            )}

            <div class="status-divider" />
            <Row label="heyvm" value={info.heyvm_available ? "available" : "not found"} status={info.heyvm_available ? "running" : "error"} />
            {isLocal && <Row label="Data dir" value={info.data_dir} status={info.data_dir_exists ? "running" : "error"} />}

            {/* ── Local mode actions ── */}
            {isLocal && (
              <>
                {/* Setup progress */}
                {setupRunning && (
                  <div class="setup-progress">
                    <div class="setup-progress-spinner" />
                    <span>{setupProgress}</span>
                  </div>
                )}

                {!setupRunning && info.heyvm_available && (
                  <div class="status-divider" />
                )}

                {/* Setup button for fresh sandbox */}
                {!setupRunning && info.heyvm_available && needsSetup && (
                  <div class="setup-section">
                    <div class="setup-description">
                      Create a new VM with image <code>todo-agent</code> on the KVM backend, or attach to an existing sandbox.
                    </div>
                    <button class="btn btn-sm btn-primary setup-btn" onClick={handleFullSetup}>
                      Create New VM
                    </button>
                    {existingSandboxes.length > 0 && (
                      <button
                        class="btn btn-sm btn-ghost setup-btn"
                        onClick={() => setShowSandboxPicker(!showSandboxPicker)}
                        style={{ marginTop: "6px" }}
                      >
                        {showSandboxPicker ? "Hide existing sandboxes" : `Use existing sandbox (${existingSandboxes.length})`}
                      </button>
                    )}
                    {showSandboxPicker && (
                      <div class="status-connect-section" style={{ marginTop: "6px" }}>
                        <select
                          class="settings-select"
                          value={selectedSandbox}
                          onChange={(e) => setSelectedSandbox((e.target as HTMLSelectElement).value)}
                        >
                          <option value="">— Pick a sandbox —</option>
                          {existingSandboxes.map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                        <button
                          class="btn btn-sm btn-primary"
                          onClick={handleAttachExisting}
                          disabled={!selectedSandbox}
                          style={{ marginTop: "6px" }}
                        >
                          Attach
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* Stopped sandbox */}
                {!setupRunning && info.heyvm_available && sandboxStopped && (
                  <div class="status-actions">
                    <button class="btn btn-sm btn-primary" onClick={handleFullSetup}>Start Agent</button>
                    <button class="btn btn-sm btn-ghost" onClick={refresh} disabled={loading}>Refresh</button>
                  </div>
                )}

                {/* Running sandbox actions */}
                {!setupRunning && info.heyvm_available && !needsSetup && !sandboxStopped && (
                  <div class="status-actions">
                    {info.sandbox_status === "running" && info.agent_status === "disconnected" && (
                      <button class="btn btn-sm btn-primary" onClick={handleStartAgent}>Start Agent</button>
                    )}
                    {(info.agent_status === "running" || info.agent_status === "unreachable") && (
                      <button class="btn btn-sm btn-secondary" onClick={handleStopAgent}>Stop Agent</button>
                    )}
                    {info.sandbox_status === "running" && (
                      <button class="btn btn-sm btn-secondary" onClick={handleUpdateAgent}>Update Agent</button>
                    )}
                    {info.sandbox_status === "running" && (
                      <button class="btn btn-sm btn-secondary" onClick={handleStopVm}>Stop VM</button>
                    )}
                    <button class="btn btn-sm btn-ghost" onClick={refresh} disabled={loading}>Refresh</button>
                  </div>
                )}

                {!info.heyvm_available && (
                  <div class="status-error" style={{ marginTop: "6px" }}>
                    Install heyvm to create and manage sandboxes.
                  </div>
                )}

                {/* Deploy to cloud button */}
                {!setupRunning && !deployRunning && info.heyvm_available && (
                  <>
                    <div class="status-divider" />
                    <div class="setup-section">
                      <div class="setup-description">
                        Deploy to Heyo Cloud for multi-device access.
                      </div>
                      <button class="btn btn-sm btn-primary setup-btn" onClick={handleDeploy}>
                        Deploy to Cloud
                      </button>
                    </div>
                  </>
                )}

                {/* Deploy progress */}
                {deployRunning && (
                  <div class="setup-progress">
                    <div class="setup-progress-spinner" />
                    <span>{deployProgress}</span>
                  </div>
                )}
              </>
            )}

            {/* ── Deployed mode actions ── */}
            {isDeployed && (
              <>
                <div class="status-divider" />
                <div class="status-actions">
                  <button class="btn btn-sm btn-secondary" onClick={handleTeardown}>Stop Deployment</button>
                  <button class="btn btn-sm btn-ghost" onClick={refresh} disabled={loading}>Refresh</button>
                </div>
              </>
            )}

            {/* ── Remote mode actions ── */}
            {isRemote && (
              <>
                <div class="status-divider" />
                <div class="status-actions">
                  <button class="btn btn-sm btn-secondary" onClick={handleDisconnect}>Disconnect</button>
                  <button class="btn btn-sm btn-ghost" onClick={refresh} disabled={loading}>Refresh</button>
                </div>
              </>
            )}

            {/* ── P2P mode actions ── */}
            {isP2p && (
              <>
                <div class="status-divider" />
                {deployInfo?.p2p_ticket && (
                  <div class="status-row">
                    <span class="status-row-label">Ticket</span>
                    <span class="status-row-value" style={{ fontSize: "10px", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {deployInfo.p2p_ticket}
                    </span>
                  </div>
                )}
                <div class="status-actions">
                  <button class="btn btn-sm btn-secondary" onClick={handleDisconnectP2p}>Disconnect</button>
                  <button class="btn btn-sm btn-ghost" onClick={refresh} disabled={loading}>Refresh</button>
                </div>
              </>
            )}

            {/* ── Network mode actions ── */}
            {isNetwork && (
              <>
                <div class="status-divider" />
                {deployInfo?.network_service && (
                  <div class="status-row">
                    <span class="status-row-label">Service</span>
                    <span class="status-row-value" style={{ fontFamily: "var(--font-mono)" }}>
                      {deployInfo.network_service}:{deployInfo.network_port}
                    </span>
                  </div>
                )}
                <div class="status-actions">
                  <button class="btn btn-sm btn-secondary" onClick={handleDisconnectP2p}>Disconnect</button>
                  <button class="btn btn-sm btn-ghost" onClick={refresh} disabled={loading}>Refresh</button>
                </div>
              </>
            )}

            {/* ── Connect to remote section (when not already connected out) ── */}
            {!isDeployed && !isRemote && !isP2p && !isNetwork && (
              <>
                <div class="status-divider" />
                <button
                  class="status-logs-toggle"
                  onClick={() => setShowConnect(!showConnect)}
                >
                  {showConnect ? "Hide" : "Connect to Remote"}
                </button>
                {showConnect && (
                  <div class="status-connect-section">
                    <input
                      type="text"
                      class="status-connect-input"
                      placeholder="https://sandbox.heyo.computer"
                      value={remoteUrl}
                      onInput={(e) => setRemoteUrl((e.target as HTMLInputElement).value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleConnect(); }}
                    />
                    <button
                      class="btn btn-sm btn-primary"
                      onClick={handleConnect}
                      disabled={connectingRemote || !remoteUrl.trim()}
                    >
                      {connectingRemote ? "Connecting..." : "Connect"}
                    </button>
                  </div>
                )}

                {/* Connect over P2P (iroh) */}
                <button
                  class="status-logs-toggle"
                  onClick={() => setShowP2p(!showP2p)}
                >
                  {showP2p ? "Hide" : "Connect over P2P"}
                </button>
                {showP2p && (
                  <div class="status-connect-section">
                    <input
                      type="text"
                      class="status-connect-input"
                      placeholder="heyo://… ticket or shortname"
                      value={p2pTicket}
                      onInput={(e) => setP2pTicket((e.target as HTMLInputElement).value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleConnectP2p(); }}
                    />
                    <input
                      type="text"
                      class="status-connect-input"
                      placeholder="relay URL (optional)"
                      value={p2pRelay}
                      onInput={(e) => setP2pRelay((e.target as HTMLInputElement).value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleConnectP2p(); }}
                      style={{ marginTop: "6px" }}
                    />
                    <button
                      class="btn btn-sm btn-primary"
                      onClick={handleConnectP2p}
                      disabled={connectingP2p || !p2pTicket.trim()}
                      style={{ marginTop: "6px" }}
                    >
                      {connectingP2p ? "Connecting..." : "Connect"}
                    </button>
                  </div>
                )}

                {/* Connect to a networked VM (heyo network services) */}
                <button
                  class="status-logs-toggle"
                  onClick={handleToggleNetwork}
                >
                  {showNetwork ? "Hide" : "Connect to a networked VM"}
                </button>
                {showNetwork && (
                  <div class="status-connect-section">
                    {loadingNetwork && <span class="status-loading">Loading services…</span>}
                    {!loadingNetwork && networkServices.length === 0 && (
                      <div class="setup-description">
                        No services on your default network. Expose a VM's agent port from the
                        desktop app (or <code>heyvm network expose-service</code>), then refresh.
                        <button
                          class="btn btn-sm btn-ghost"
                          onClick={handleToggleNetwork}
                          style={{ marginTop: "6px" }}
                        >
                          Reload
                        </button>
                      </div>
                    )}
                    {!loadingNetwork && networkServices.map((svc) => (
                      <div key={svc.address} class="status-row" style={{ marginTop: "4px" }}>
                        <StatusDot status={svc.routable ? "running" : "disconnected"} />
                        <span class="status-row-value" style={{ fontFamily: "var(--font-mono)", fontSize: "11px" }}>
                          {svc.address}
                        </span>
                        <button
                          class="btn btn-sm btn-primary"
                          onClick={() => handleConnectNetwork(svc)}
                          disabled={!svc.routable || connectingNetwork === svc.address}
                          style={{ marginLeft: "auto", padding: "1px 8px", fontSize: "11px" }}
                          title={svc.routable ? "" : "No live route — run `heyvm network expose-service`"}
                        >
                          {connectingNetwork === svc.address ? "Connecting…" : "Connect"}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Calendar sync */}
            {calStatus?.connected && (
              <>
                <div class="status-divider" />
                <div class="status-actions">
                  <button class="btn btn-sm btn-primary" onClick={handleCalendarSync} disabled={calSyncing}>
                    {calSyncing ? "Syncing..." : "Sync Calendar"}
                  </button>
                </div>
              </>
            )}

            {actionMsg && <div class="status-action-msg">{actionMsg}</div>}

            {/* Logs section */}
            <div class="status-divider" />
            <button class="status-logs-toggle" onClick={toggleLogs}>
              {showLogs ? "Hide Logs" : "View Logs"}
              {info.log_file && <span class="status-log-path">{info.log_file}</span>}
            </button>

            {showLogs && (
              <div class="status-logs">
                <div class="status-logs-actions">
                  <button class="btn btn-sm btn-ghost" onClick={loadLogs}>Refresh</button>
                </div>
                <pre class="status-logs-content">{logContent || "(empty)"}</pre>
              </div>
            )}
          </div>
        )}

        {!loading && !info && (
          <div class="status-popover-body">
            <span class="status-error">Could not load status info</span>
            <button class="btn btn-sm btn-ghost" onClick={refresh} style={{ marginTop: "6px" }}>Retry</button>
          </div>
        )}
      </div>
    </div>
  );
}
