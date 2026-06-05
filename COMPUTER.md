# COMPUTER.md

> The agent's map of this VM, per the [agent-computers spec](https://github.com/Heyo-Computer/computer).
> This file lives at `/data/COMPUTER.md` inside the sandbox. `/data` is the persistent
> mount, so this file survives sync and re-seeding.

This is a long-lived [heyvm](https://heyo.computer) sandbox that hosts the **paperagent**
agent — a Node.js service that reads and writes the user's todos, lists, books,
artifacts, and calendar cache, runs shell commands, and searches the web on the
user's behalf. The desktop app (Tauri + Preact, on the host) talks to this VM over
JSON-RPC.

## Operating system & package manager

- **OS:** Ubuntu 24.04 LTS (firecracker rootfs from `agent/Dockerfile.firecracker`;
  cloud deploys use `ubuntu:24.04`).
- **Package manager:** `apt-get` (Debian/Ubuntu). The base image runs as `root`, so
  `apt-get` works directly — `sudo` may not be present on the firecracker rootfs.
- **Hostname:** `todo-agent`.
- **Shell:** `/bin/bash` (login), `/bin/sh` for init scripts.

## Project directories

Everything the agent owns lives under `/data`, which is the durable mount
(host `~/.todo` → guest `/data`). Layout:

| Path | Contents |
|------|----------|
| `/data/agent` | The agent service code (`dist/index.js` entrypoint, `node_modules`, `package.json`). Pushed in at setup. |
| `/data/storage` | Day-partitioned user data: `storage/YYYY/MM/DD/day.json`, `specs/{todo-id}.md`, plus `lists/`, `books/`, and their `index.json` files. |
| `/data/artifacts` | Agent-generated files and folders the user can browse from the app. |
| `/data/config` | `agent.json` (settings; secrets are scrubbed from the seeded copy), `calendar.json`, `calendar_tokens.json`. |
| `/data/logs` | `agent.log` (agent stdout/stderr), `npm.log` (dependency install output). |
| `/data/COMPUTER.md` | This file. |

The storage modules honor `HEYO_DATA_DIR` (defaults to `/data`) — only set it when
running the agent's unit tests against a temp dir on the host.

## Tooling

- **Node.js 22.x** (`node`, `npm`) — installed via NodeSource in the image. This is
  the agent runtime.
- **bun** — used on the *host* for the app/agent build; not required inside the VM.
  The agent runs the precompiled `dist/` with plain `node`.
- `openssh-server` (`sshd`), `curl`, `ca-certificates`, `gnupg`, `iproute2`, `tar`.

## Services

- **paperagent agent** — an Express server (`/data/agent/dist/index.js`) listening on
  `0.0.0.0:8080`.
  - Health check: `GET /health` → `{"status":"ok"}`.
  - ACP JSON-RPC 2.0 endpoint: `POST /rpc`. Methods are namespaced: `agent/*`
    (`chat`, `status`, `clear`, `stop`), `storage/*`, `lists/*`, `books/*`,
    `links/*`, `artifacts/*`, `migration/*`, `calendar/save_events`.
  - Started detached as: `cd /data/agent && <env> node dist/index.js`, logging to
    `/data/logs/agent.log`. Only one instance should hold port 8080.
- **sshd** — listens on port 22 (root login permitted; a `heyo` user exists with
  password `heyo`). Reachable from the host via `heyvm ssh-proxy`, not a public port.

Exposed ports: **22** (SSH) and **8080** (agent RPC). The host binds 8080 dynamically
via `--open-port`.

## Environment variables & secrets

Secrets are **not** stored on disk in the VM. The seeded `/data/config/agent.json` has
its key fields (`api_key`, `openrouter_api_key`, `heyo_api_key`, `speech_api_key`)
scrubbed. Instead, secrets and runtime config are injected as **environment variables**
when the agent process is started by the host:

| Variable | Purpose |
|----------|---------|
| `PORT` | Agent listen port (default `8080`). |
| `LLM_PROVIDER` | `anthropic` (default) or `openrouter`. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | Claude credentials + model (anthropic provider). |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | OpenRouter credentials + model (openrouter provider). |
| `SPEC_VERBOSITY` | Spec-writing verbosity; overrides the config file. |
| `USER_CONTEXT` | User context string; overrides the config file. |

The provider client throws eagerly if the relevant `*_API_KEY` is unset. Because the
KVM mount is copy-in (not live), the host cannot write these into the VM's config file
at runtime — that is why they travel as env vars at process start. To read the current
values inside the VM: inspect the running `node` process's environment, not a file.

## Restrictions & gotchas

- **No live mount under KVM.** `--mount` is **copy-in at creation**, not a live
  bind. Editing files in the VM does not propagate back to the host automatically, and
  host edits do not appear in a running VM. Use `heyvm sync` or push files explicitly
  (see below). Plan-config (verbosity, user context) and secrets are passed via env to
  work around this.
- **One agent per port 8080.** Starting a second `node dist/index.js` will fight for the
  port. Stop the old one first: `pkill -f 'node dist/index.js'`.
- **Long-running commands over the serial console time out.** A plain `&` backgrounded
  job over the KVM serial console can be killed when the exec session closes
  (~30s console limit). Detach properly with `nohup sh -c '...' >log 2>&1 &` and poll a
  marker/logfile, the pattern the host uses for `npm install` and agent start.
- **`sudo` may be absent** on the firecracker rootfs (you are already `root`); on cloud
  `msb` images, prefer running as the provided user.
- **Outbound network** uses `nameserver 8.8.8.8`; the agent reaches the Anthropic /
  OpenRouter API and Anthropic web search. No inbound except the exposed ports.
- Secrets live only in process env — don't write them back into `/data/config`.

---

## For agents outside the VM (host-side operations)

The desktop app drives all of this automatically; this section documents the manual
equivalents.

### Accessing the VM

- SSH / SCP route through the heyvm ssh-proxy (no public SSH port):
  `ssh -o ProxyCommand='heyvm ssh-proxy <vm>' root@<vm>` — or use
  `heyvm ssh <vm>` / `heyvm exec <vm> -- <cmd>`.
- Agent RPC: the host hits `http://127.0.0.1:<mapped-port>/rpc` where `<mapped-port>`
  is the dynamic host port bound to guest 8080.

### Start / stop

```bash
heyvm start <vm>          # boot the sandbox
heyvm stop  <vm>          # shut it down
heyvm list                # show sandboxes + status
```

The agent itself auto-provisions on app launch; manually:
`cd /data/agent && PORT=8080 ANTHROPIC_API_KEY=... node dist/index.js`.

### Transferring files to/from the VM

- **Seed via mount (copy-in):** write to the host data dir `~/.todo/…`; it lands at
  `/data/…` when the sandbox is (re)created with `--mount ~/.todo:/data`. This is how
  this `COMPUTER.md` is installed.
- **Push into a running VM:** `scp` through the ssh-proxy, e.g. tar the payload, scp to
  `/tmp`, then unpack — the pattern used to deploy `/data/agent`. Direct
  `heyvm file-push` is unreliable under KVM; use scp.
- **Sync:** `heyvm sync` carries the mount contents (host → guest).

### Snapshots

```bash
heyvm stop <vm>
heyvm snapshot --name <image-name> <vm>     # save a reusable image
```

The agent base image (Node.js pre-installed) is snapshotted this way and reused so new
sandboxes start with the runtime already present.

### Rebuilding the firecracker image

The image is defined in `agent/Dockerfile.firecracker` (Ubuntu 24.04 + Node 22 + sshd,
data dirs pre-created, `/init.sh` brings up networking and sshd and prints
`HEYVM_READY`).
