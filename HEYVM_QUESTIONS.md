# Questions for the heyvm dev team

Context: Tauri desktop app (`txture` / `todo`) embeds an HTTP agent in a
local KVM sandbox via `heyvm create --backend-type kvm`. Image built with
`heyvm mvm build --local-only` from a custom Ubuntu 24.04 + Node 22
Dockerfile. heyvm version is whatever's on `main` as of 2026-05-28.

The end-to-end flow works, but a few rough edges turned a 10-minute
integration into a multi-hour debug session. Sharing the friction points
in case any are bugs vs. intentional-but-undocumented behavior.

---

## 1. `--open-port` is a silent no-op on the KVM backend

```
heyvm create --backend-type kvm --name todo-agent --image todo-agent \
    --mount /home/user/.todo:/data --open-port 8080:8080
```

The create succeeds, the agent inside the guest binds to `0.0.0.0:8080`,
but the host has no listener on `:8080` and no NAT/portforward rule.
The only way we found to reach the guest from the host is to talk
directly to the guest IP on the `tap-kv-<sandbox-suffix>` interface
(which is in a /30 with host=`.5`, guest=`.6`).

**Question:** Is `--open-port` intentionally local-only-libvirt-supported?
If so, can the CLI either:

- print a warning when `--open-port` is passed with a backend that doesn't
  honor it, or
- transparently set up the equivalent on KVM (iptables DNAT, or just an
  iroh proxy), or
- document this in `heyvm create --help` (currently "Port to forward to
  the host at creation time" implies it works everywhere)

**Bonus ask:** Could `heyvm get <sandbox> --format json` include the
guest IP / tap-device name so we don't have to parse `ip -j addr show
tap-kv-<suffix>` ourselves? Right now we strip "sb-" from the sandbox
ID, look up `tap-kv-<suffix>`, take the host /30 address and XOR the
last octet with `0x03` to derive the guest IP. Works, but obviously
brittle if the network plan changes.

---

## 2. `heyvm port-forward` on KVM binds locally but the tunnel fails

```
$ heyvm port-forward todo-agent 8080 --host-port 8080 &
Forwarding localhost:8080 -> sb-65bf2d01:8080
Press Ctrl+C to stop

$ ss -tln | grep 8080
LISTEN 0 128 127.0.0.1:8080 0.0.0.0:*
LISTEN 0 128 [::1]:8080     [::]:*

$ curl http://localhost:8080/health
curl: (56) Recv failure: Connection reset by peer
```

Host port accepts the connection, then immediately RSTs. The agent is
verifiably alive — `curl http://<tap-guest-ip>:8080/health` returns
`{"status":"ok"}` at the same moment.

We worked around this by skipping port-forward entirely and connecting
directly to the guest tap IP. Wanted to flag it though — either the
internal forwarder is broken for KVM or there's a setup step we missed.

---

## 3. Serial-console `heyvm exec` intermittently times out during early
  boot of large images

Our image is ~456 MB (Ubuntu 24.04 + openssh-server + Node 22 from
NodeSource). First boots after `heyvm create` or `heyvm start` often
see `heyvm exec` time out at 30s with:

```
ERROR mvm_ctrl::cli: Failed to execute command:
  Serial console execute timed out after 30s. Buffered output:
  #
```

A `#` prompt shows up on the serial console (so `/init.sh` ran and
`exec /bin/sh` happened), but the marker-delimited command we send
(`echo __HEYVM_xxx_START__; (...) 2>&1; echo __HEYVM_xxx_END__`)
doesn't echo back. ~30–60s later, exec starts working normally for
the rest of the sandbox's life.

Repro: ~456 MB ext4 image, `heyvm create --backend-type kvm ...`,
immediately `heyvm exec ... -- echo hello` in a loop. First few error,
later ones succeed.

Worse case: we hit a related timeout during `heyvm create` itself —
`KVM VM sb-XXXXX timed out waiting for HEYVM_READY after 60s` even
though `HEYVM_READY` would have printed seconds later if we'd waited.

**Question:** Is there a "wait until exec is really ready" knob, or
can the boot-marker timeout in `heyvm create` be configurable (CLI flag
or env)? 60s is plenty when the cache is warm, brittle on first boot of
a freshly built image when the host is also doing other work.

---

## 4. `heyvm create` always emits a TTL warning when mounts are passed

```
heyvm create --backend-type kvm --name x ... --mount /host:/sandbox
# stderr: warning: sandbox has mounts but will expire in 3600s (< 24h).
#         Pass `--no-ttl` to make it persistent.
```

The warning is printed to stderr, but our wrapping code surfaces stderr
in error reports, so we got false alarms before adding `--no-ttl`
explicitly. Two small asks:

- Could `--no-ttl` be the default when `--mount` is specified? The user
  almost always wants persistence when they're bind-mounting host state.
- Or could the warning be tagged so callers can suppress it without
  losing real errors (e.g. write to `stderr` with a known prefix, or
  add `--quiet`)?

---

## 5. `--image` flag is asymmetric across backends

- `--backend-type kvm --image todo-agent` resolves to
  `~/.heyo/images/firecracker/todo-agent.ext4`
- `--backend-type firecracker --image todo-agent` same
- `--backend-type libvirt --image todo-agent` expects a path
  (`~/.heyo/images/todo-agent.qcow2`) or a docker-style ref

This bit us during the migration — the old code passed
`/home/user/.heyo/images/<name>.qcow2` as `--image`, which worked for
libvirt but became "Image not found at path:" once we wanted KVM. We
ended up branching in Rust to pass the path for libvirt and the bare
name for KVM/firecracker, which feels like a heyvm-side concern.

**Question:** Should `heyvm` resolve a bare image name across backends
consistently (look in `firecracker/` *and* the qcow2 root), or is the
asymmetry deliberate (e.g. because libvirt also supports docker refs)?

---

## 6. `heyvm exec` swallows stdout when the boot serial protocol is
  half-broken

When the symptom in (3) occurs partially — exec doesn't time out, but
returns `{"exit_code": 0, "stderr": "", "stdout": ""}` for *every*
command — it looks like a success to scripted callers but nothing
actually ran. Made debugging confusing because `setup_agent` saw exit-0
for `node dist/index.js &` but `wait-for 8080` then failed; the natural
read is "node started, port not yet ready" rather than "exec lost the
input."

**Question:** Could a totally-empty marker response surface as a
non-zero exit code or a `protocol_error` field in JSON, so callers can
tell "command ran and printed nothing" apart from "command never ran"?

---

## What we'd love most

If we had to pick one, it'd be a way for the agent inside a local KVM
sandbox to be reachable from the host without parsing `ip` output.
Either:

- `--open-port` does the iptables thing on KVM, or
- `heyvm port-forward` actually works for KVM, or
- `heyvm get` exposes the guest IP in JSON.

Everything else we worked around. Thanks!
