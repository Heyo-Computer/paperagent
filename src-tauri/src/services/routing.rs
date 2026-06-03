//! Shared helpers for routing data commands through the sandbox agent.
//!
//! The sandbox is the single source of truth for user data — there is no local
//! filesystem fallback. `require_agent` returns the agent URL, waiting briefly
//! for the agent to finish starting (it auto-starts/provisions on launch) so
//! commands issued during boot block instead of failing.

use std::time::{Duration, Instant};

use crate::services::agent as agent_svc;
use crate::state::AppState;

/// How long a data command will wait for the agent to come up before erroring.
/// The frontend onboarding overlay normally holds data calls until the agent is
/// `running`; this is the backstop for calls that race the boot.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(300);

/// Current agent URL, if connected.
pub fn agent_url(state: &AppState) -> Option<String> {
    state.agent_url.lock().unwrap().clone()
}

/// Return the agent URL, waiting up to `READY_TIMEOUT` for it to become
/// available. Errors if the agent never comes up in that window.
pub async fn require_agent(state: &AppState) -> Result<String, String> {
    let start = Instant::now();
    loop {
        if let Some(url) = agent_url(state) {
            return Ok(url);
        }
        if start.elapsed() >= READY_TIMEOUT {
            return Err(
                "The sandbox agent isn't running yet. Check the agent status in Settings."
                    .to_string(),
            );
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

/// Call an agent JSON-RPC method and deserialize the result, surfacing any
/// JSON-RPC error as `Err`.
pub async fn agent_rpc<T: serde::de::DeserializeOwned>(
    url: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<T, String> {
    let resp = agent_svc::send_rpc(url, method, params).await?;
    if let Some(err) = resp.error {
        return Err(err.message);
    }
    let result = resp.result.ok_or("Empty response from agent")?;
    serde_json::from_value(result).map_err(|e| format!("Failed to parse: {}", e))
}
