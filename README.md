# Planner

A desktop task manager with an AI agent that runs in a sandboxed VM. Built with Tauri v2, Preact, and Rust.

The agent lives inside a [heyvm](https://heyo.computer) sandbox and can read/write your todos, create specs, search the web, and execute commands. Calendar events sync automatically from Google Calendar.

## Prerequisites

- [Bun](https://bun.sh) (package manager + runtime)
- [Rust](https://rustup.rs) (stable toolchain)
- [heyvm](https://heyo.computer) (sandbox manager)
- A virtualization backend: **libvirt** (Linux), **Apple Virtualization** (macOS), or **Docker**
- An [Anthropic API key](https://console.anthropic.com)

## Quick Start

```bash
# Install frontend dependencies
bun install

# Install agent dependencies
cd agent && bun install && cd ..

# Build the agent (TypeScript -> JS)
cd agent && bun run build && cd ..

# Run in development mode
bun run tauri dev
```

On first launch, open **Settings** and configure:

1. **Anthropic API Key** -- required for the agent to work
2. **VM Name** -- name for your sandbox (default: `txture-agent`)
3. **VM Backend** -- `libvirt` on Linux, `apple_vf` on macOS

Then click **Set up** in the chat panel to create the sandbox, install the agent, and start it.

## Build for Production

```bash
bun run tauri build
```

The compiled app will be in `src-tauri/target/release/bundle/`.

## Project Structure

```
todo/
  agent/              # Node.js agent service (runs inside the sandbox)
    src/
      agent.ts        # Claude API integration + tool definitions
      index.ts        # Express RPC server
      tools/          # Agent tools (file, shell, todo, search)
  src/                # Frontend (Preact + TypeScript)
    components/       # UI components (chat, todos, settings, etc.)
    api/              # Tauri IPC command wrappers
    state/            # Reactive state (Preact signals)
    theme/            # CSS themes
  src-tauri/          # Rust backend
    src/
      commands/       # Tauri IPC handlers (agent, storage, calendar, etc.)
      services/       # Business logic (heyvm, calendar OAuth, agent RPC)
      models/         # Data structures (TodoItem, DayEntry, AgentMessage)
```

## How It Works

**Storage** is day-partitioned JSON at `~/.todo/storage/YYYY/MM/DD/`:
- `day.json` -- the day's todo items
- `specs/{todo-id}.md` -- markdown spec files for individual todos

When the agent is running, all storage operations route through it via JSON-RPC. This means a remote instance of the app can connect to the same sandbox and access the same data.

**The agent** runs as a Node.js Express server inside a heyvm sandbox. It uses Claude via the Anthropic SDK with these tools:
- `read_file`, `write_file`, `list_directory` -- filesystem access under `/data`
- `exec_command` -- shell commands in the sandbox
- `save_spec`, `update_todo`, `get_todos` -- direct todo/spec management
- `web_search` -- Anthropic's built-in web search

**Chat** supports `@` mentions -- type `@` to autocomplete a todo item. The mention includes the todo's ID and date so the agent can act on it directly.

## Agent Sandbox Setup

The app creates a heyvm sandbox with the agent image baked in (Node.js 18 + npm pre-installed). The image is at `~/.heyo/images/txture-agent-base.qcow2`.

To build the base image from scratch:

```bash
# Create a sandbox, install Node.js, clean up
heyvm create --name txture-agent --backend-type libvirt --type shell
heyvm exec txture-agent -- sh -c "sudo apt-get update -qq && sudo apt-get install -y nodejs npm"
heyvm exec txture-agent -- sh -c "sudo apt-get clean && sudo rm -rf /var/lib/apt/lists/*"

# Snapshot it as a reusable image
heyvm stop txture-agent
heyvm snapshot --name txture-agent-base txture-agent
```

## Google Calendar Integration

Syncs today's calendar events as todos on app startup.

### Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project (or use an existing one)
3. Enable the **Google Calendar API**
4. Go to **Credentials** > **Create Credentials** > **OAuth 2.0 Client ID**
5. Application type: **Desktop app**
6. Add `http://localhost:19284/callback` as an authorized redirect URI
7. Copy the **Client ID** and **Client Secret**

### Configure in the App

1. Open **Settings** in the app
2. Scroll to the **Google Calendar** section
3. Paste the Client ID and Client Secret
4. Check **Sync events to todos on startup**
5. Click **Save**, then **Connect Google Calendar**
6. Authorize in the browser window that opens

Events sync automatically on each app launch. Use **Sync now** in settings for manual sync.

## Voice Transcription

Press **Ctrl+H** to record voice input, which is transcribed via the Mistral Voxtral API and inserted into the chat.

Add your Mistral API key under **Settings > Speech**.

### Linux: GStreamer Plugins Required

On Linux, the Tauri webview (WebKitGTK) uses GStreamer to encode audio from the microphone. Without the right plugins, voice recording will silently produce no data. Install these packages:

```bash
# Ubuntu / Debian / Pop!_OS
sudo apt install gstreamer1.0-plugins-good gstreamer1.0-plugins-bad

# If using PulseAudio
sudo apt install gstreamer1.0-pulseaudio

# If using PipeWire
sudo apt install gstreamer1.0-pipewire
```

## Configuration

All configuration is stored in `~/.todo/config/`:

| File | Purpose |
|------|---------|
| `agent.json` | Anthropic API key, model, VM settings, Heyo cloud config |
| `calendar.json` | Google OAuth client credentials, calendar ID, sync toggle |
| `calendar_tokens.json` | OAuth access/refresh tokens (auto-managed) |

## Development

```bash
# Frontend dev server (hot reload)
bun run dev

# Tauri dev (frontend + Rust backend with hot reload)
bun run tauri dev

# Build agent after changes
cd agent && bun run build

# Check Rust compilation
cd src-tauri && cargo check
```

### Key Technologies

- **Tauri v2** -- desktop framework (Rust backend + webview frontend)
- **Preact** -- lightweight React-compatible UI with signals for state
- **heyvm** -- microsandbox manager for running the agent in an isolated VM
- **Anthropic SDK** -- Claude API with tool use for the agent
- **reqwest** -- HTTP client for agent RPC and Google Calendar API
