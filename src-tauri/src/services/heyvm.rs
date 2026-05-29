use std::process::Command;
use crate::logging;

fn heyvm_cmd() -> Command {
    Command::new("heyvm")
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

// ── Sandbox lifecycle ──

pub fn list_sandboxes() -> Result<String, String> {
    run("list", heyvm_cmd().arg("list"))
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

pub fn create_sandbox_with_backend(
    name: &str,
    backend: &str,
    data_dir: &str,
    image: Option<&str>,
    open_ports: &[PortSpec],
) -> Result<CreateResult, String> {
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

pub fn exec_in_sandbox(name: &str, cmd: &[&str]) -> Result<String, String> {
    let mut args = vec!["exec", "--stdout-only", name, "--"];
    args.extend_from_slice(cmd);
    logging::info(&format!("[heyvm] exec: sandbox={}, cmd={:?}", name, cmd));
    run("exec", heyvm_cmd().args(&args))
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

    let raw = run("exec_json", heyvm_cmd().args(&args))?;

    #[derive(serde::Deserialize)]
    struct JsonOut {
        stdout: String,
        stderr: String,
        exit_code: i32,
    }

    let parsed: JsonOut = serde_json::from_str(raw.trim())
        .map_err(|e| format!("exec_json: failed to parse output: {} (raw: {})", e, raw.trim()))?;

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
    logging::info(&format!("[heyvm] create_cloud_sandbox: name={}, backend={}, cloud_url={}",
        opts.name, opts.backend, opts.cloud_url));
    let mut cmd = heyvm_cmd();
    cmd.args([
        "create",
        "--format", "json",
        "--name", opts.name,
        "--backend-type", opts.backend,
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
