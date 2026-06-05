use crate::models::agent::{AcpRequest, AcpResponse, AgentMessage};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

fn next_id() -> u64 {
    REQUEST_ID.fetch_add(1, Ordering::Relaxed)
}

/// One pooled HTTP client for the whole process. Connections are kept warm and
/// reused across requests — the main perf win for Deployed (HTTPS) and P2P
/// (localhost→iroh tunnel) modes, where reconnecting per call would be costly.
/// Per-request timeouts are set on each RequestBuilder, since a single client
/// can't carry both the long RPC deadline and the short health-check deadline.
pub fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(4)
            .tcp_keepalive(Duration::from_secs(30))
            .build()
            .expect("failed to build pooled HTTP client")
    })
}

pub async fn send_rpc(
    agent_url: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<AcpResponse, String> {
    let request = AcpRequest::new(method, params, next_id());

    let response = http_client()
        .post(format!("{}/rpc", agent_url))
        .timeout(Duration::from_secs(120))
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("RPC request failed: {}", e))?;

    let acp_response: AcpResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse RPC response: {}", e))?;

    Ok(acp_response)
}

pub async fn send_chat_message(
    agent_url: &str,
    message: &str,
) -> Result<AgentMessage, String> {
    let params = serde_json::json!({
        "message": message,
    });

    let response = send_rpc(agent_url, "agent/chat", params).await?;

    if let Some(error) = response.error {
        return Err(error.message);
    }

    let result = response.result.ok_or("Empty response from agent")?;
    let msg: AgentMessage =
        serde_json::from_value(result).map_err(|e| format!("Failed to parse message: {}", e))?;

    Ok(msg)
}

pub async fn check_health(agent_url: &str) -> bool {
    http_client()
        .get(format!("{}/health", agent_url))
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}
