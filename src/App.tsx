import { ThemeProvider, themeList, setTheme } from "./theme/ThemeProvider";
import { useTheme } from "./theme/ThemeProvider";
import { useRef, useCallback, useEffect, useState } from "preact/hooks";
import { activeTab, agentStatus, agentMode, settingsOpen, agentName, statusPopoverOpen, setupProgress, days, allArtifacts, allLists, allBooks } from "./state/store";
import { WeekAccordion } from "./components/days/DayAccordion";
import { MonthAccordion } from "./components/days/MonthAccordion";
import { DayPanel } from "./components/days/DayPanel";
import { BacklogPanel } from "./components/backlog/BacklogPanel";
import { ListsPanel } from "./components/lists/ListsPanel";
import { BooksPanel } from "./components/books/BooksPanel";
import { ArtifactsPanel } from "./components/artifacts/ArtifactsPanel";
import { ChatWindow } from "./components/chat/ChatWindow";
import { SettingsPanel } from "./components/settings/SettingsPanel";
import { StatusPopover } from "./components/status/StatusPopover";
import { setupEventListeners } from "./api/events";
import { getAgentStatus, getAgentConfig, setAgentConfig, getDaysRange, listAllArtifacts, listLists, listBooks, setupAgent } from "./api/commands";
import type { ViewTab, AgentStatus } from "./types";
import { signal } from "@preact/signals";

const tabs: { id: ViewTab; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "backlog", label: "Backlog" },
  { id: "lists", label: "Lists" },
  { id: "books", label: "Books" },
  { id: "artifacts", label: "Artifacts" },
];

// Content area height in pixels (null = use flex default)
const contentHeight = signal<number | null>(null);

/** Shown over the data tabs until the sandbox agent (the data backend) is up. */
function BootGate() {
  const status = agentStatus.value;
  const progress = setupProgress.value;
  const [retrying, setRetrying] = useState(false);

  async function retry() {
    setRetrying(true);
    try {
      await setupAgent();
    } catch {
      /* status events drive the UI; errors surface via agent-status */
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div class="boot-gate">
      <div class="boot-gate-inner">
        {status === "error" ? (
          <>
            <div class="boot-gate-title">Couldn't start the sandbox</div>
            <div class="boot-gate-msg">{progress || "The data agent failed to start."}</div>
            <div class="boot-gate-actions">
              <button class="btn btn-primary" disabled={retrying} onClick={retry}>
                {retrying ? "Retrying…" : "Retry"}
              </button>
              <button class="btn btn-secondary" onClick={() => (settingsOpen.value = true)}>
                Open Settings
              </button>
            </div>
          </>
        ) : (
          <>
            <div class="boot-gate-spinner" />
            <div class="boot-gate-title">Starting the sandbox…</div>
            <div class="boot-gate-msg">
              {progress || "Bringing up your data agent. First launch can take a minute."}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function AppShell() {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    setupEventListeners();
    // Apply persisted theme at startup, before any settings UI opens.
    getAgentConfig().then((c) => {
      if (c.theme_name) setTheme(c.theme_name);
    }).catch(() => {});
    // Sync initial agent status (auto-start may have finished before listener was ready)
    getAgentStatus().then((s) => {
      agentStatus.value = s as AgentStatus;
    }).catch(() => {});
    // Populate the shared signals at boot so @-mentions have data even on
    // the default Day tab (DayPanel keeps its own local state and doesn't fill it,
    // and artifacts only load when the Artifacts tab is opened).
    getDaysRange().then((d) => { days.value = d; }).catch(() => {});
    listAllArtifacts().then((a) => { allArtifacts.value = a; }).catch(() => {});
    listLists().then((l) => { allLists.value = l; }).catch(() => {});
    listBooks().then((b) => { allBooks.value = b; }).catch(() => {});

    // Re-fetch data on window focus when in deployed/remote mode (multi-device sync)
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && agentMode.value !== "local") {
        getDaysRange().then((d) => { days.value = d; }).catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);

    // Keep a manually-dragged content height bounded when the window resizes.
    // Without this, the fixed px height (flex: none) goes stale and the chat
    // panel below it gets squished/clipped by .app-column's overflow: hidden.
    const handleResize = () => {
      if (contentHeight.value === null || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const headerOffset = 72;
      const minContent = 80;
      const minChat = 150;
      const available = rect.height - headerOffset;
      const clamped = Math.max(minContent, Math.min(contentHeight.value, available - minChat));
      if (clamped !== contentHeight.value) contentHeight.value = clamped;
    };
    window.addEventListener("resize", handleResize);

    // Prevent the webview from navigating when files are dropped outside the chat input
    const swallow = (e: DragEvent) => { e.preventDefault(); };
    document.addEventListener("dragover", swallow);
    document.addEventListener("drop", swallow);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("dragover", swallow);
      document.removeEventListener("drop", swallow);
    };
  }, []);

  const onMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      // Offset from top of container to the mouse position
      // Subtract header (~38) + tabs (~34) = ~72px
      const headerOffset = 72;
      const minContent = 80;
      const minChat = 150;
      const available = rect.height - headerOffset;
      let newHeight = e.clientY - rect.top - headerOffset;
      newHeight = Math.max(minContent, Math.min(newHeight, available - minChat));
      contentHeight.value = newHeight;
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  const contentStyle = contentHeight.value !== null
    ? { height: `${contentHeight.value}px`, flex: "none" }
    : undefined;

  return (
    <div class="app-column" ref={containerRef}>
      {/* Header */}
      <div class="app-header">
        <h1 class="app-title">{agentName.value}</h1>
        <div class="app-header-right">
          <button
            class="header-icon-btn"
            onClick={() => (statusPopoverOpen.value = true)}
            title="Status"
          >
            <span class={`status-indicator ${agentStatus.value}`} />
          </button>
          <button
            class="header-icon-btn"
            onClick={() => (settingsOpen.value = true)}
            title="Agent settings"
          >
            <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
              <path d="M16.2 12.5a1.4 1.4 0 0 0 .3 1.5l.05.05a1.7 1.7 0 1 1-2.4 2.4l-.05-.05a1.4 1.4 0 0 0-1.5-.3 1.4 1.4 0 0 0-.85 1.28v.15a1.7 1.7 0 1 1-3.4 0v-.08A1.4 1.4 0 0 0 7.5 16.2a1.4 1.4 0 0 0-1.5.3l-.05.05a1.7 1.7 0 1 1-2.4-2.4l.05-.05a1.4 1.4 0 0 0 .3-1.5A1.4 1.4 0 0 0 2.62 11.75h-.15a1.7 1.7 0 1 1 0-3.4h.08A1.4 1.4 0 0 0 3.8 7.5a1.4 1.4 0 0 0-.3-1.5l-.05-.05a1.7 1.7 0 1 1 2.4-2.4l.05.05a1.4 1.4 0 0 0 1.5.3h.07a1.4 1.4 0 0 0 .85-1.28v-.15a1.7 1.7 0 1 1 3.4 0v.08a1.4 1.4 0 0 0 .85 1.28 1.4 1.4 0 0 0 1.5-.3l.05-.05a1.7 1.7 0 1 1 2.4 2.4l-.05.05a1.4 1.4 0 0 0-.3 1.5v.07a1.4 1.4 0 0 0 1.28.85h.15a1.7 1.7 0 0 1 0 3.4h-.08a1.4 1.4 0 0 0-1.28.85Z" />
            </svg>
          </button>
          <button
            class="header-icon-btn"
            onClick={async () => {
              const idx = themeList.findIndex((t) => t.name === theme.name);
              const next = themeList[(idx + 1) % themeList.length];
              setTheme(next.name);
              try {
                const c = await getAgentConfig();
                await setAgentConfig({ ...c, theme_name: next.name });
              } catch {}
            }}
            title={`Theme: ${theme.label} (click to cycle)`}
          >
            {theme.background.type === "solid"
              ? (theme.name === "dark" ? "\u2600" : "\u263E")
              : "\u273F"}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div class="tab-bar">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            class={`tab-btn ${activeTab.value === tab.id ? "active" : ""}`}
            onClick={() => (activeTab.value = tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Scrollable content area — gated on the sandbox being up, since it's the
          single source of truth for all data. */}
      <div class="content-area" style={contentStyle}>
        {agentStatus.value === "running" ? (
          <>
            {activeTab.value === "day" && <DayPanel />}
            {activeTab.value === "week" && <WeekAccordion />}
            {activeTab.value === "month" && <MonthAccordion />}
            {activeTab.value === "backlog" && <BacklogPanel />}
            {activeTab.value === "lists" && <ListsPanel />}
            {activeTab.value === "books" && <BooksPanel />}
            {activeTab.value === "artifacts" && <ArtifactsPanel />}
          </>
        ) : (
          <BootGate />
        )}
      </div>

      {/* Resize handle */}
      <div class="resize-handle" onMouseDown={onMouseDown}>
        <div class="resize-handle-bar" />
      </div>

      {/* Chat — always visible, anchored to bottom */}
      <ChatWindow />

      {/* Overlays */}
      <SettingsPanel />
      <StatusPopover />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  );
}
