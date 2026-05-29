import { useState, useEffect } from "preact/hooks";
import { settingsOpen, agentName } from "../../state/store";
import {
  getAgentConfig, setAgentConfig,
  getCalendarConfig, setCalendarConfig,
  getCalendarStatus, connectGoogleCalendar,
  disconnectGoogleCalendar, syncCalendarToTodos,
} from "../../api/commands";
import { themeList, setTheme } from "../../theme/ThemeProvider";
import type { AgentConfig, CalendarConfig, CalendarStatus } from "../../types";

const MODELS = [
  { value: "claude-sonnet-4-6-20250514", label: "Claude Sonnet 4.6" },
  { value: "claude-opus-4-6-20250514", label: "Claude Opus 4.6" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

const BACKENDS = [
  { value: "libvirt", label: "Libvirt (Linux, recommended)" },
  { value: "kvm", label: "KVM (Linux)" },
  { value: "firecracker", label: "Firecracker (Linux)" },
  { value: "apple_vf", label: "Apple VF (macOS)" },
  { value: "docker", label: "Docker" },
  { value: "bubblewrap", label: "Bubblewrap" },
];

const REGIONS = [
  { value: "US", label: "US" },
  { value: "EU", label: "EU" },
];

const SIZE_CLASSES = [
  { value: "micro", label: "Micro (0.25 CPU, 0.5 GB)" },
  { value: "mini", label: "Mini (0.5 CPU, 1 GB)" },
  { value: "small", label: "Small (1 CPU, 2 GB)" },
  { value: "medium", label: "Medium (2 CPU, 4 GB)" },
  { value: "large", label: "Large (4 CPU, 8 GB)" },
];

const IMAGES = [
  { value: "ubuntu:24.04", label: "Ubuntu 24.04" },
  { value: "alpine:3.23", label: "Alpine 3.23" },
];

const DEFAULT_CONFIG: AgentConfig = {
  api_key: "",
  model: "claude-sonnet-4-6-20250514",
  vm_name: "todo-agent",
  vm_backend: "libvirt",
  data_dir: "~/.todo",
  heyo_api_key: "",
  heyo_cloud_url: "https://server.heyo.computer",
  deploy_region: "US",
  deploy_size_class: "small",
  deploy_image: "ubuntu:24.04",
  speech_api_key: "",
  spec_verbosity: "normal",
  user_context: "",
  theme_name: "dark",
  llm_provider: "anthropic",
  openrouter_api_key: "",
  openrouter_model: "anthropic/claude-sonnet-4-6",
};

const VERBOSITIES: { value: "terse" | "normal" | "detailed"; label: string; hint: string }[] = [
  { value: "terse", label: "Terse", hint: "Brief and to the point" },
  { value: "normal", label: "Normal", hint: "Default level of detail" },
  { value: "detailed", label: "Detailed", hint: "Thorough with context and rationale" },
];

const USER_CONTEXT_MAX = 1000;

const DEFAULT_CAL_CONFIG: CalendarConfig = {
  client_id: "",
  client_secret: "",
  enabled: false,
  calendar_id: "",
};

export function SettingsPanel() {
  const [config, setConfig] = useState<AgentConfig>(DEFAULT_CONFIG);
  const [calConfig, setCalConfig] = useState<CalendarConfig>(DEFAULT_CAL_CONFIG);
  const [calStatus, setCalStatus] = useState<CalendarStatus | null>(null);
  const [calConnecting, setCalConnecting] = useState(false);
  const [calMessage, setCalMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getAgentConfig().then((c) => {
      setConfig(c);
      if (c.vm_name) agentName.value = c.vm_name;
      if (c.theme_name) setTheme(c.theme_name);
    }).catch(() => {});
    getCalendarConfig().then(setCalConfig).catch(() => {});
    getCalendarStatus().then(setCalStatus).catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      await setAgentConfig(config);
      await setCalendarConfig(calConfig);
      agentName.value = config.vm_name || "planner";
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  async function handleCalConnect() {
    setCalConnecting(true);
    setCalMessage("");
    try {
      // Save config first so the backend has the credentials
      await setCalendarConfig(calConfig);
      const msg = await connectGoogleCalendar();
      setCalMessage(msg);
      getCalendarStatus().then(setCalStatus).catch(() => {});
    } catch (err) {
      setCalMessage(`${err}`);
    } finally {
      setCalConnecting(false);
    }
  }

  async function handleCalDisconnect() {
    await disconnectGoogleCalendar();
    setCalMessage("Disconnected.");
    getCalendarStatus().then(setCalStatus).catch(() => {});
  }

  async function handleCalSync() {
    setCalMessage("");
    try {
      const msg = await syncCalendarToTodos();
      setCalMessage(msg);
    } catch (err) {
      setCalMessage(`${err}`);
    }
  }

  function handleClose() {
    settingsOpen.value = false;
  }

  function update(patch: Partial<AgentConfig>) {
    setConfig({ ...config, ...patch });
  }

  if (!settingsOpen.value) return null;

  return (
    <div class="settings-overlay" onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
      <div class="settings-panel">
        <div class="settings-header">
          <span class="settings-title">Settings</span>
          <button class="settings-close" onClick={handleClose} title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>

        <div class="settings-body">
          {/* ── Appearance section ── */}
          <div class="settings-section-label">Appearance</div>

          <div class="settings-field">
            <span class="settings-label">Theme</span>
            <div class="theme-picker">
              {themeList.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  class={`theme-swatch${config.theme_name === t.name ? " active" : ""}`}
                  onClick={() => {
                    update({ theme_name: t.name });
                    setTheme(t.name);
                  }}
                  title={t.label}
                >
                  <span
                    class={`theme-swatch-preview theme-preview-${t.background.type}`}
                    style={{
                      background: t.colors["bg-primary"].startsWith("rgba")
                        ? t.colors["bg-secondary"]
                        : t.colors["bg-primary"],
                      borderColor: t.colors["border"],
                    }}
                  >
                    <span class="theme-swatch-accent" style={{ background: t.colors["accent"] }} />
                  </span>
                  <span class="theme-swatch-label">{t.label}</span>
                </button>
              ))}
            </div>
            <span class="settings-hint">Aurora, Waves, and Dots use animated GPU shaders.</span>
          </div>

          <div class="settings-divider" />

          {/* ── Agent section ── */}
          <div class="settings-section-label">Agent</div>

          <label class="settings-field">
            <span class="settings-label">LLM Provider</span>
            <select
              class="settings-select"
              value={config.llm_provider}
              onChange={(e) => update({ llm_provider: e.currentTarget.value as "anthropic" | "openrouter" })}
            >
              <option value="anthropic">Anthropic (direct)</option>
              <option value="openrouter">OpenRouter</option>
            </select>
          </label>

          {config.llm_provider === "anthropic" && (
            <>
              <label class="settings-field">
                <span class="settings-label">Anthropic API Key</span>
                <input
                  type="password"
                  class="settings-input"
                  value={config.api_key}
                  onInput={(e) => update({ api_key: e.currentTarget.value })}
                  placeholder="sk-ant-..."
                />
              </label>

              <label class="settings-field">
                <span class="settings-label">Model</span>
                <select
                  class="settings-select"
                  value={config.model}
                  onChange={(e) => update({ model: e.currentTarget.value })}
                >
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </label>
            </>
          )}

          {config.llm_provider === "openrouter" && (
            <>
              <label class="settings-field">
                <span class="settings-label">OpenRouter API Key</span>
                <input
                  type="password"
                  class="settings-input"
                  value={config.openrouter_api_key}
                  onInput={(e) => update({ openrouter_api_key: e.currentTarget.value })}
                  placeholder="sk-or-..."
                />
              </label>

              <label class="settings-field">
                <span class="settings-label">OpenRouter Model</span>
                <input
                  type="text"
                  class="settings-input"
                  value={config.openrouter_model}
                  onInput={(e) => update({ openrouter_model: e.currentTarget.value })}
                  placeholder="anthropic/claude-sonnet-4-6"
                />
                <span class="settings-hint">e.g. anthropic/claude-sonnet-4-6, openai/gpt-4.1, google/gemini-2.5-pro. See openrouter.ai/models.</span>
              </label>
            </>
          )}

          <label class="settings-field">
            <span class="settings-label">VM Name</span>
            <input
              type="text"
              class="settings-input"
              value={config.vm_name}
              onInput={(e) => update({ vm_name: e.currentTarget.value })}
              placeholder="todo-agent"
            />
          </label>

          <label class="settings-field">
            <span class="settings-label">VM Backend</span>
            <select
              class="settings-select"
              value={config.vm_backend}
              onChange={(e) => update({ vm_backend: e.currentTarget.value })}
            >
              {BACKENDS.map((b) => (
                <option key={b.value} value={b.value}>{b.label}</option>
              ))}
            </select>
          </label>

          <label class="settings-field">
            <span class="settings-label">Data Directory</span>
            <input
              type="text"
              class="settings-input"
              value={config.data_dir}
              onInput={(e) => update({ data_dir: e.currentTarget.value })}
              placeholder="~/.todo"
            />
            <span class="settings-hint">Mounted into the VM at /data. Created if missing.</span>
          </label>

          {/* ── Heyo / Deploy section ── */}
          <div class="settings-divider" />
          <div class="settings-section-label">Heyo Cloud</div>

          <label class="settings-field">
            <span class="settings-label">Heyo API Key</span>
            <input
              type="password"
              class="settings-input"
              value={config.heyo_api_key}
              onInput={(e) => update({ heyo_api_key: e.currentTarget.value })}
              placeholder="heyo_..."
            />
            <span class="settings-hint">Used by heyvm to authenticate with Heyo cloud</span>
          </label>

          <label class="settings-field">
            <span class="settings-label">Cloud URL</span>
            <input
              type="text"
              class="settings-input"
              value={config.heyo_cloud_url}
              onInput={(e) => update({ heyo_cloud_url: e.currentTarget.value })}
              placeholder="https://server.heyo.computer"
            />
          </label>

          <label class="settings-field">
            <span class="settings-label">Deploy Region</span>
            <select
              class="settings-select"
              value={config.deploy_region}
              onChange={(e) => update({ deploy_region: e.currentTarget.value })}
            >
              {REGIONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </label>

          <label class="settings-field">
            <span class="settings-label">Size Class</span>
            <select
              class="settings-select"
              value={config.deploy_size_class}
              onChange={(e) => update({ deploy_size_class: e.currentTarget.value })}
            >
              {SIZE_CLASSES.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </label>

          <label class="settings-field">
            <span class="settings-label">Image</span>
            <select
              class="settings-select"
              value={config.deploy_image}
              onChange={(e) => update({ deploy_image: e.currentTarget.value })}
            >
              {IMAGES.map((i) => (
                <option key={i.value} value={i.value}>{i.label}</option>
              ))}
            </select>
          </label>
          {/* ── Speech section ── */}
          <div class="settings-divider" />
          <div class="settings-section-label">Speech</div>

          <label class="settings-field">
            <span class="settings-label">Mistral API Key</span>
            <input
              type="password"
              class="settings-input"
              value={config.speech_api_key}
              onInput={(e) => update({ speech_api_key: e.currentTarget.value })}
              placeholder="..."
            />
            <span class="settings-hint">Used for Voxtral voice transcription (Ctrl+H)</span>
          </label>

          {/* ── Spec writing section ── */}
          <div class="settings-divider" />
          <div class="settings-section-label">Spec Writing</div>

          <div class="settings-field">
            <span class="settings-label">Verbosity</span>
            <div class="settings-radio-group">
              {VERBOSITIES.map((v) => (
                <label key={v.value} class="settings-radio">
                  <input
                    type="radio"
                    name="spec-verbosity"
                    value={v.value}
                    checked={config.spec_verbosity === v.value}
                    onChange={() => update({ spec_verbosity: v.value })}
                  />
                  <span class="settings-radio-label">
                    <span class="settings-radio-title">{v.label}</span>
                    <span class="settings-radio-hint">{v.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <label class="settings-field">
            <span class="settings-label">About me</span>
            <textarea
              class="settings-textarea"
              value={config.user_context}
              onInput={(e) => {
                const v = e.currentTarget.value.slice(0, USER_CONTEXT_MAX);
                update({ user_context: v });
              }}
              maxLength={USER_CONTEXT_MAX}
              rows={4}
              placeholder="Context about you that the agent should consider when writing specs (role, expertise, preferences, ongoing projects)..."
            />
            <span class="settings-hint">
              {config.user_context.length} / {USER_CONTEXT_MAX} characters
            </span>
          </label>

          {/* ── Calendar section ── */}
          <div class="settings-divider" />
          <div class="settings-section-label">Google Calendar</div>

          <label class="settings-field">
            <span class="settings-label">OAuth Client ID</span>
            <input
              type="text"
              class="settings-input"
              value={calConfig.client_id}
              onInput={(e) => setCalConfig({ ...calConfig, client_id: e.currentTarget.value })}
              placeholder="xxxx.apps.googleusercontent.com"
            />
          </label>

          <label class="settings-field">
            <span class="settings-label">OAuth Client Secret</span>
            <input
              type="password"
              class="settings-input"
              value={calConfig.client_secret}
              onInput={(e) => setCalConfig({ ...calConfig, client_secret: e.currentTarget.value })}
            />
          </label>

          <label class="settings-field">
            <span class="settings-label">Calendar ID</span>
            <input
              type="text"
              class="settings-input"
              value={calConfig.calendar_id}
              onInput={(e) => setCalConfig({ ...calConfig, calendar_id: e.currentTarget.value })}
              placeholder="primary"
            />
            <span class="settings-hint">Leave blank for your primary calendar</span>
          </label>

          <label class="settings-field settings-checkbox-field">
            <input
              type="checkbox"
              checked={calConfig.enabled}
              onChange={(e) => setCalConfig({ ...calConfig, enabled: e.currentTarget.checked })}
            />
            <span class="settings-label">Sync events to todos on startup</span>
          </label>

          <div class="settings-field" style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            {calStatus?.connected ? (
              <>
                <span class="settings-hint" style={{ color: "var(--color-accent)" }}>Connected</span>
                <button class="btn btn-sm btn-ghost" onClick={handleCalSync}>Sync now</button>
                <button class="btn btn-sm btn-ghost" onClick={handleCalDisconnect}>Disconnect</button>
              </>
            ) : (
              <button
                class="btn btn-sm btn-primary"
                onClick={handleCalConnect}
                disabled={calConnecting || !calConfig.client_id || !calConfig.client_secret}
              >
                {calConnecting ? "Connecting..." : "Connect Google Calendar"}
              </button>
            )}
          </div>

          {calMessage && (
            <div class="settings-hint" style={{ marginTop: "4px" }}>{calMessage}</div>
          )}
        </div>

        <div class="settings-footer">
          {saved && <span class="settings-saved">Saved</span>}
          <button class="btn btn-secondary btn-sm" onClick={handleClose}>Cancel</button>
          <button class="btn btn-primary btn-sm" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
