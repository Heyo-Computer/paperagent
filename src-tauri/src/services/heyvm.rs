use std::process::Command;
use std::sync::OnceLock;
use crate::logging;

/// Directories where `heyvm` (and the ssh/scp tools it relies on) commonly live but
/// which a macOS GUI app does NOT inherit on PATH when launched from the Dock/Spotlight.
/// A GUI-launched app only gets a minimal `/usr/bin:/bin:/usr/sbin:/sbin`, so installs
/// under Homebrew, cargo, or `~/.local/bin` become invisible. We probe these explicitly
/// and also prepend them to PATH for every spawned process.
fn extra_bin_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join("bin"));
    }
    for p in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"] {
        dirs.push(std::path::PathBuf::from(p));
    }
    dirs
}

/// PATH augmented with the common install dirs above, so that spawned processes — and
/// in particular `scp`'s `ProxyCommand=heyvm ssh-proxy …`, which resolves `heyvm`
/// through the child's PATH — can find binaries even under a stripped GUI environment.
fn augmented_path() -> String {
    let mut parts: Vec<String> = extra_bin_dirs()
        .into_iter()
        .map(|d| d.to_string_lossy().to_string())
        .collect();
    if let Ok(existing) = std::env::var("PATH") {
        for p in existing.split(':') {
            if !p.is_empty() && !parts.iter().any(|e| e == p) {
                parts.push(p.to_string());
            }
        }
    }
    parts.join(":")
}

/// Resolve the full path to the `heyvm` binary, probing common install locations first
/// and then the augmented PATH. Falls back to the bare name `heyvm` (relying on PATH)
/// if nothing is found. Cached for the lifetime of the process.
pub fn heyvm_bin() -> &'static str {
    static BIN: OnceLock<String> = OnceLock::new();
    BIN.get_or_init(|| {
        // Probe explicit install dirs first.
        for dir in extra_bin_dirs() {
            let candidate = dir.join("heyvm");
            if candidate.is_file() {
                return candidate.to_string_lossy().to_string();
            }
        }
        // Then any directory on the augmented PATH.
        for dir in augmented_path().split(':') {
            if dir.is_empty() { continue; }
            let candidate = std::path::Path::new(dir).join("heyvm");
            if candidate.is_file() {
                return candidate.to_string_lossy().to_string();
            }
        }
        logging::error("[heyvm] binary not found in common locations or PATH; falling back to bare 'heyvm'");
        "heyvm".to_string()
    })
}

fn heyvm_cmd() -> Command {
    let mut cmd = Command::new(heyvm_bin());
    cmd.env("PATH", augmented_path());
    cmd
}

fn run(label: &str, cmd: &mut Command) -> Result<String, String> {
    let display = format!("{:?}", cmd);
    logging::info(&format!("[heyvm] {}: running {}", label, display));

    let output = cmd.output().map_err(|e| {
        let msg = format!("[heyvm] {}: spawn failed: {}", label, e);
        logging::error(&msg);
        msg
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        logging::info(&format!("[heyvm] {}: exit 0, stdout={}", label, stdout.trim()));
        Ok(stdout)
    } else {
        let msg = format!(
            "[heyvm] {}: exit {}, stderr={}",
            label,
            output.status.code().unwrap_or(-1),
            stderr.trim()
        );
        logging::error(&msg);
        Err(format!("{}: {}", label, stderr.trim()))
    }
}

/// Path to the SSH key heyvm installs into sandbox images.
fn ssh_key_path() -> std::path::PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".heyo/keys/id_heyvm"))
        .unwrap_or_else(|| std::path::PathBuf::from(".heyo/keys/id_heyvm"))
}

/// Common ssh/scp options that route through `heyvm ssh-proxy <vm>` (bypassing the
/// serial console, which can't carry large payloads). Used to push files into a
/// running sandbox over its sshd.
fn ssh_proxy_opts(vm_name: &str) -> Vec<String> {
    vec![
        "-o".into(), "BatchMode=yes".into(),
        "-o".into(), "StrictHostKeyChecking=no".into(),
        "-o".into(), "UserKnownHostsFile=/dev/null".into(),
        "-o".into(), "ConnectTimeout=20".into(),
        "-o".into(), "IdentitiesOnly=yes".into(),
        "-i".into(), ssh_key_path().to_string_lossy().to_string(),
        "-o".into(), format!("ProxyCommand={} ssh-proxy {}", heyvm_bin(), vm_name),
    ]
}

/// Copy a local file into a running sandbox over SSH (via ssh-proxy). Retries a
/// few times because sshd may take a moment to come up after `start`.
pub fn scp_into_sandbox(vm_name: &str, local: &std::path::Path, remote: &str) -> Result<(), String> {
    let target = format!("root@{}:{}", vm_name, remote);
    let mut last_err = String::new();
    for attempt in 1..=5 {
        let mut cmd = Command::new("scp");
        cmd.env("PATH", augmented_path());
        cmd.args(ssh_proxy_opts(vm_name));
        cmd.arg(local).arg(&target);
        match run(&format!("scp(attempt {})", attempt), &mut cmd) {
            Ok(_) => return Ok(()),
            Err(e) => {
                last_err = e;
                std::thread::sleep(std::time::Duration::from_secs(2));
            }
        }
    }
    Err(format!("scp into sandbox failed after retries: {}", last_err))
}

// ── Sandbox lifecycle ──

pub fn list_sandboxes() -> Result<String, String> {
    run("list", heyvm_cmd().arg("list"))
}

/// List ALL sandboxes (running + stopped). Used by the "use existing VM" picker —
/// a synced/pulled VM is typically stopped, so the default running-only list misses it.
pub fn list_all_sandboxes() -> Result<String, String> {
    run("list_all", heyvm_cmd().args(["list", "--all"]))
}

pub fn sandbox_exists(name: &str) -> bool {
    sandbox_status(name).is_some()
}

/// Parse `heyvm list` output and return the STATUS value for the given sandbox name.
pub fn sandbox_status(name: &str) -> Option<String> {
    let output = list_sandboxes().ok()?;
    for line in output.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        // Table rows: NAME  ID  STATUS  BACKEND  TYPE / IMAGE
        if cols.len() >= 3 && cols[0] == name {
            return Some(cols[2].to_lowercase());
        }
    }
    None
}

#[derive(serde::Deserialize)]
pub struct PortMapping {
    pub host_port: u16,
    pub guest_port: u16,
}

#[derive(serde::Deserialize)]
pub struct CreateResult {
    pub id: String,
    pub name: String,
    pub status: String,
    #[serde(default)]
    pub port_mappings: Vec<PortMapping>,
}

/// Port spec for --open-port: (host_port, guest_port). Use (0, guest) for dynamic host port.
pub type PortSpec = (u16, u16);

/// Map UI/config backend names to the identifiers the `heyvm` CLI actually accepts.
/// In particular the macOS native virtualization backend is `apple_virt`; earlier
/// versions of this app stored/sent `apple_vf`, which heyvm does not recognize and
/// silently falls back to its settings default (libvirt) for — failing on macOS.
/// Normalizing here fixes both new configs and any `apple_vf` already saved on disk.
pub fn normalize_backend(backend: &str) -> &str {
    match backend {
        "apple_vf" => "apple_virt",
        other => other,
    }
}

pub fn create_sandbox_with_backend(
    name: &str,
    backend: &str,
    data_dir: &str,
    image: Option<&str>,
    open_ports: &[PortSpec],
) -> Result<CreateResult, String> {
    let backend = normalize_backend(backend);
    logging::info(&format!("[heyvm] create_sandbox: name={}, backend={}, data_dir={}, image={:?}, open_ports={:?}",
        name, backend, data_dir, image, open_ports));
    let mut cmd = heyvm_cmd();
    cmd.args([
        "create",
        "--format", "json",
        "--name", name,
        "--backend-type", backend,
        "--type", "shell",
        "--no-ttl",
        "--mount", &format!("{}:/data", data_dir),
    ]);
    if let Some(img) = image {
        cmd.args(["--image", img]);
    }
    for (host, guest) in open_ports {
        let spec = if *host == 0 {
            guest.to_string()
        } else {
            format!("{}:{}", host, guest)
        };
        cmd.args(["--open-port", &spec]);
    }
    let raw = run("create", &mut cmd)?;
    serde_json::from_str(raw.trim())
        .map_err(|e| format!("create: failed to parse output: {} (raw: {})", e, raw.trim()))
}

/// Build a Firecracker/KVM rootfs image from a Dockerfile.
pub fn build_image(dockerfile: &std::path::Path, name: &str) -> Result<String, String> {
    logging::info(&format!("[heyvm] build_image: dockerfile={}, name={}", dockerfile.display(), name));
    let mut cmd = heyvm_cmd();
    cmd.args([
        "mvm", "build",
        "--local-only",
        "-f", &dockerfile.to_string_lossy(),
        "-n", name,
    ]);
    run("mvm_build", &mut cmd)
}

/// Build an Apple Virtualization (apple_virt) rootfs image from a Dockerfile.
/// Unlike firecracker (which goes through `heyvm mvm build`), apple_virt images
/// are built via `heyvm images build --backend apple_virt` and land at
/// `~/.heyo/images/apple_virt/<name>/`, usable via `heyvm create --image <name>`.
///
/// `--from default` supplies the donor `grubaa64.efi` (generic across distros)
/// that the host places on each sandbox's ESP. The actual boot uses the kernel
/// staged *inside* the rootfs at /boot/vmlinuz-lts (see Dockerfile.apple_virt's
/// final RUN), not the donor's standalone kernel — so the `default` (Alpine)
/// donor is fine and, unlike `ubuntu-24.04`, auto-downloads if absent.
///
/// `--size-mb 12288` matches heyo's Ubuntu+node base; APFS CoW clones make the
/// nominal size ~free on disk until the guest actually writes.
pub fn build_apple_virt_image(dockerfile: &std::path::Path, name: &str) -> Result<String, String> {
    logging::info(&format!("[heyvm] build_apple_virt_image: dockerfile={}, name={}", dockerfile.display(), name));
    let context = dockerfile.parent().map(|p| p.to_string_lossy().to_string());
    let mut cmd = heyvm_cmd();
    cmd.args([
        "images", "build",
        "--backend", "apple_virt",
        "--from", "default",
        "--size-mb", "12288",
        "-f", &dockerfile.to_string_lossy(),
    ]);
    if let Some(ctx) = &context {
        cmd.args(["--context", ctx]);
    }
    cmd.args(["-n", name]);
    run("apple_virt_build", &mut cmd)
}

/// Run `heyvm get <name> --format json` and return the parsed object.
fn get_sandbox_json(name: &str) -> Option<serde_json::Value> {
    let output = heyvm_cmd().args(["get", name, "--format", "json"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

/// Get a sandbox's ID by name/slug.
pub fn sandbox_id(name: &str) -> Option<String> {
    get_sandbox_json(name)?
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

/// Guest IP for a KVM/Firecracker sandbox. Prefers the `guest_ip` field
/// from `heyvm get` (added in newer heyvm versions); falls back to
/// deriving it from the host's `tap-kv-<suffix>` /30 address for older
/// versions.
pub fn kvm_guest_ip(name_or_id: &str) -> Option<String> {
    if let Some(info) = get_sandbox_json(name_or_id) {
        if let Some(ip) = info.get("guest_ip").and_then(|v| v.as_str()) {
            return Some(ip.to_string());
        }
        if let Some(id) = info.get("id").and_then(|v| v.as_str()) {
            return derive_kvm_guest_ip_from_tap(id);
        }
    }
    derive_kvm_guest_ip_from_tap(name_or_id)
}

/// Discover a sandbox's primary global IPv4 by asking the guest directly over
/// `heyvm exec`.
///
/// This is the reliable path for the **apple_virt** backend: its vmnet DHCP
/// address is host-routable (the host can hit `http://<guest_ip>:<port>`
/// directly), but heyvm's `get` does not cache it (`guest_ip` stays None
/// because the host-side DHCP probe runs before the lease lands), there is no
/// `tap-kv-*` host device for `kvm_guest_ip`'s derivation path, and neither
/// `--open-port` localhost NAT nor `heyvm port-forward` actually carry traffic.
/// Since `exec` works (serial early in boot, SSH once the key is provisioned),
/// the guest itself is the source of truth for its own address.
pub fn guest_ip_via_exec(name: &str) -> Option<String> {
    let cmd = "ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1";
    let out = exec_in_sandbox_json(name, &["sh", "-c", cmd], Some("10s")).ok()?;
    let ip = out.stdout.trim();
    // Sanity-check it parses as IPv4 before handing it back as a URL host.
    ip.parse::<std::net::Ipv4Addr>().ok().map(|_| ip.to_string())
}

/// Fallback for older heyvm versions: parse `ip -j addr show tap-kv-<suffix>`
/// and derive the guest /30 peer by flipping the last two bits of the
/// host octet.
fn derive_kvm_guest_ip_from_tap(sandbox_id: &str) -> Option<String> {
    let suffix = sandbox_id.strip_prefix("sb-").unwrap_or(sandbox_id);
    let iface = format!("tap-kv-{}", suffix);
    let output = std::process::Command::new("ip")
        .args(["-j", "addr", "show", &iface])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let host_ip_str = value
        .as_array()?
        .first()?
        .get("addr_info")?
        .as_array()?
        .iter()
        .find_map(|info| {
            if info.get("family").and_then(|v| v.as_str()) == Some("inet") {
                info.get("local").and_then(|v| v.as_str()).map(|s| s.to_string())
            } else {
                None
            }
        })?;
    let host: std::net::Ipv4Addr = host_ip_str.parse().ok()?;
    let mut octets = host.octets();
    octets[3] ^= 0x03;
    Some(std::net::Ipv4Addr::from(octets).to_string())
}

/// List sandbox names (local + cloud) from `heyvm list`. Skips the header rows.
pub fn list_sandbox_names() -> Result<Vec<String>, String> {
    let output = list_sandboxes()?;
    let mut names = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('-') {
            continue;
        }
        let cols: Vec<&str> = trimmed.split_whitespace().collect();
        if cols.len() < 3 || cols[0] == "NAME" {
            continue;
        }
        names.push(cols[0].to_string());
    }
    Ok(names)
}

pub fn start_sandbox(name: &str) -> Result<String, String> {
    run("start", heyvm_cmd().args(["start", name]))
}

pub fn rm_sandbox(name: &str) -> Result<String, String> {
    run("rm", heyvm_cmd().args(["rm", name, "--yes"]))
}

pub fn stop_sandbox(name: &str) -> Result<String, String> {
    run("stop", heyvm_cmd().args(["stop", name]))
}

// ── Exec ──

/// How many times to (re)try an exec that fails with a transient SSH/transport
/// error, and how long to wait between tries.
const EXEC_RETRY_ATTEMPTS: u32 = 5;
const EXEC_RETRY_DELAY_MS: u64 = 1500;

/// True for errors that are an artifact of the guest's SSH not being ready yet
/// rather than a real command failure. On apple_virt the first exec(s) after a
/// VM start commonly hit "Permission denied" — heyvm routes exec over SSH once
/// the guest IP is cached, but the heyvm key provisioning into the guest settles
/// a beat later. These clear on their own within a second or two, so retrying
/// rides past them. Note this can surface two ways: as a failed `heyvm` process
/// (Err from run), or as a *successful* heyvm call whose JSON reports a non-zero
/// `exit_code` with the SSH error on stderr (see exec_in_sandbox_json).
fn is_transient_exec_err(msg: &str) -> bool {
    let l = msg.to_lowercase();
    [
        "permission denied",
        "connection refused",
        "connection reset",
        "connection closed",
        "kex_exchange_identification",
        "connection timed out",
        "operation timed out",
        "broken pipe",
        "host key verification",
        "no guest ip",
        "no route to host",
    ]
    .iter()
    .any(|p| l.contains(p))
}

pub fn exec_in_sandbox(name: &str, cmd: &[&str]) -> Result<String, String> {
    let mut args = vec!["exec", "--stdout-only", name, "--"];
    args.extend_from_slice(cmd);
    logging::info(&format!("[heyvm] exec: sandbox={}, cmd={:?}", name, cmd));

    let mut last_err = String::new();
    for attempt in 1..=EXEC_RETRY_ATTEMPTS {
        match run("exec", heyvm_cmd().args(&args)) {
            Ok(s) => return Ok(s),
            Err(e) => {
                if is_transient_exec_err(&e) && attempt < EXEC_RETRY_ATTEMPTS {
                    logging::warn(&format!("[heyvm] exec: transient error (attempt {}/{}), retrying: {}", attempt, EXEC_RETRY_ATTEMPTS, e));
                    std::thread::sleep(std::time::Duration::from_millis(EXEC_RETRY_DELAY_MS));
                    last_err = e;
                    continue;
                }
                return Err(e);
            }
        }
    }
    Err(last_err)
}

pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Execute a command with structured JSON output and optional timeout.
pub fn exec_in_sandbox_json(name: &str, cmd: &[&str], timeout: Option<&str>) -> Result<ExecOutput, String> {
    let mut args = vec!["exec", "--format", "json"];
    if let Some(t) = timeout {
        args.extend_from_slice(&["--timeout", t]);
    }
    args.push(name);
    args.push("--");
    args.extend_from_slice(cmd);
    logging::info(&format!("[heyvm] exec_json: sandbox={}, cmd={:?}, timeout={:?}", name, cmd, timeout));

    #[derive(serde::Deserialize)]
    struct JsonOut {
        stdout: String,
        stderr: String,
        exit_code: i32,
    }

    let mut last_err = String::new();
    let parsed: JsonOut = 'retry: loop {
        for attempt in 1..=EXEC_RETRY_ATTEMPTS {
            match run("exec_json", heyvm_cmd().args(&args)) {
                Ok(raw) => {
                    let parsed: JsonOut = serde_json::from_str(raw.trim())
                        .map_err(|e| format!("exec_json: failed to parse output: {} (raw: {})", e, raw.trim()))?;
                    // A non-zero exit whose stderr is an SSH-not-ready artifact means
                    // the command never actually ran — retry rather than report it as
                    // a (silent) success to the caller.
                    if parsed.exit_code != 0 && is_transient_exec_err(&parsed.stderr) && attempt < EXEC_RETRY_ATTEMPTS {
                        logging::warn(&format!("[heyvm] exec_json: transient exit_code={} (attempt {}/{}), retrying: {}", parsed.exit_code, attempt, EXEC_RETRY_ATTEMPTS, parsed.stderr.trim()));
                        std::thread::sleep(std::time::Duration::from_millis(EXEC_RETRY_DELAY_MS));
                        last_err = parsed.stderr;
                        continue;
                    }
                    break 'retry parsed;
                }
                Err(e) => {
                    if is_transient_exec_err(&e) && attempt < EXEC_RETRY_ATTEMPTS {
                        logging::warn(&format!("[heyvm] exec_json: transient error (attempt {}/{}), retrying: {}", attempt, EXEC_RETRY_ATTEMPTS, e));
                        std::thread::sleep(std::time::Duration::from_millis(EXEC_RETRY_DELAY_MS));
                        last_err = e;
                        continue;
                    }
                    return Err(e);
                }
            }
        }
        return Err(last_err);
    };

    if parsed.exit_code != 0 {
        logging::warn(&format!("[heyvm] exec_json: exit_code={}, stderr={}", parsed.exit_code, parsed.stderr.trim()));
    }

    Ok(ExecOutput {
        stdout: parsed.stdout,
        stderr: parsed.stderr,
        exit_code: parsed.exit_code,
    })
}

// ── wait-for ──

pub struct WaitForResult {
    pub port: u16,
    pub ready: bool,
}

pub fn wait_for(name: &str, port: u16, timeout: Option<&str>, path: Option<&str>) -> Result<WaitForResult, String> {
    let mut cmd = heyvm_cmd();
    cmd.args(["wait-for", "--format", "json", name, &port.to_string()]);
    if let Some(t) = timeout {
        cmd.args(["--timeout", t]);
    }
    if let Some(p) = path {
        cmd.args(["--path", p]);
    }
    let raw = run("wait-for", &mut cmd)?;

    #[derive(serde::Deserialize)]
    struct JsonOut {
        port: u16,
        ready: bool,
    }

    let parsed: JsonOut = serde_json::from_str(raw.trim())
        .map_err(|e| format!("wait-for: failed to parse output: {} (raw: {})", e, raw.trim()))?;

    Ok(WaitForResult { port: parsed.port, ready: parsed.ready })
}

// ── port-forward (long-running, returns child process) ──

pub fn port_forward(name: &str, sandbox_port: u16, host_port: Option<u16>) -> Result<std::process::Child, String> {
    let mut cmd = heyvm_cmd();
    cmd.args(["port-forward", name, &sandbox_port.to_string()]);
    if let Some(hp) = host_port {
        cmd.args(["--host-port", &hp.to_string()]);
    }
    logging::info(&format!("[heyvm] port-forward: sandbox={}, port={}, host_port={:?}", name, sandbox_port, host_port));
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("port-forward: spawn failed: {}", e))
}

// ── Cloud deploy helpers ──

/// Options for creating a cloud-deployed sandbox.
pub struct CloudCreateOpts<'a> {
    pub name: &'a str,
    pub backend: &'a str,
    pub cloud_url: &'a str,
    pub image: Option<&'a str>,
    pub open_ports: &'a [PortSpec],
    pub env_vars: &'a [(&'a str, &'a str)],
    pub setup_hooks: &'a [&'a str],
    pub start_command: Option<&'a str>,
}

pub fn create_cloud_sandbox(opts: &CloudCreateOpts) -> Result<CreateResult, String> {
    let backend = normalize_backend(opts.backend);
    logging::info(&format!("[heyvm] create_cloud_sandbox: name={}, backend={}, cloud_url={}",
        opts.name, backend, opts.cloud_url));
    let mut cmd = heyvm_cmd();
    cmd.args([
        "create",
        "--format", "json",
        "--name", opts.name,
        "--backend-type", backend,
        "--cloud-url", opts.cloud_url,
    ]);
    if let Some(img) = opts.image {
        cmd.args(["--image", img]);
    }
    for (host, guest) in opts.open_ports {
        let spec = if *host == 0 {
            guest.to_string()
        } else {
            format!("{}:{}", host, guest)
        };
        cmd.args(["--open-port", &spec]);
    }
    for (key, val) in opts.env_vars {
        cmd.args(["--env", &format!("{}={}", key, val)]);
    }
    for hook in opts.setup_hooks {
        cmd.args(["--setup-hook", hook]);
    }
    if let Some(start_cmd) = opts.start_command {
        cmd.args(["--start-command", start_cmd]);
    }
    let raw = run("create_cloud", &mut cmd)?;
    serde_json::from_str(raw.trim())
        .map_err(|e| format!("create_cloud: failed to parse output: {} (raw: {})", e, raw.trim()))
}

/// Archive a local directory to Heyo cloud. Returns the raw output (contains archive ID).
pub fn archive_dir(path: &str, name: &str, mount_path: &str, cloud_url: &str) -> Result<String, String> {
    logging::info(&format!("[heyvm] archive_dir: path={}, name={}, mount_path={}", path, name, mount_path));
    let mut cmd = heyvm_cmd();
    cmd.args([
        "archive-dir",
        path,
        "--name", name,
        "--mount-path", mount_path,
        "--cloud-url", cloud_url,
        "--no-ignore",
    ]);
    run("archive_dir", &mut cmd)
}

/// Bind a sandbox port to a public hostname. Returns the raw output (contains hostname).
pub fn bind_port(sandbox_id: &str, port: u16, cloud_url: &str) -> Result<String, String> {
    logging::info(&format!("[heyvm] bind_port: sandbox={}, port={}", sandbox_id, port));
    run("bind", heyvm_cmd().args([
        "bind",
        sandbox_id,
        &port.to_string(),
        "--cloud-url", cloud_url,
    ]))
}

/// Replace a deployed sandbox's mount contents from an archive.
pub fn update_sandbox(sandbox_id: &str, archive_id: &str, mount_path: &str, cloud_url: &str) -> Result<String, String> {
    logging::info(&format!("[heyvm] update_sandbox: sandbox={}, archive={}", sandbox_id, archive_id));
    run("update", heyvm_cmd().args([
        "update",
        "--archive", archive_id,
        "--mount-path", mount_path,
        "--cloud-url", cloud_url,
        sandbox_id,
    ]))
}

// ── snapshot ──

#[derive(serde::Serialize)]
pub struct SnapshotResult {
    pub image_name: String,
    pub image_path: String,
    pub size_bytes: u64,
}

pub fn snapshot(name: &str, snapshot_name: &str) -> Result<SnapshotResult, String> {
    let raw = run("snapshot", heyvm_cmd().args(["snapshot", "--format", "json", "--name", snapshot_name, name]))?;

    #[derive(serde::Deserialize)]
    struct JsonOut {
        image_name: String,
        image_path: String,
        size_bytes: u64,
    }

    let parsed: JsonOut = serde_json::from_str(raw.trim())
        .map_err(|e| format!("snapshot: failed to parse output: {} (raw: {})", e, raw.trim()))?;

    Ok(SnapshotResult {
        image_name: parsed.image_name,
        image_path: parsed.image_path,
        size_bytes: parsed.size_bytes,
    })
}
