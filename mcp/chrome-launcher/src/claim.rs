//! Headless tab-claim over CDP: make the self-installed extension take control of a target tab
//! with NO human popup click. Ported from `windows/claim_tab.mjs`.
//!
//! THE RECIPE (proven; see the extension self-install investigation): the extension is inert
//! until a tab is claimed and the MV3 service worker sleeps. Poking the SW directly fails
//! (it unloads between attach and eval). Instead we open the extension's OWN `popup.html` as a
//! real tab via `Target.createTarget` — that wakes the SW and, kept open, holds it alive via
//! the message port (what a human's popup click provides). From that popup page context we
//! `Runtime.evaluate` a script that finds the target tab, stores the bridge URL, and sends the
//! real `actions-json:authorize-tab` message, which runs the extension's claim path and opens
//! the bridge WS. The popup tab is left OPEN (closing it lets the SW sleep and drops the bridge).
//!
//! This drives raw CDP over the relay's WebSocket (`tokio-tungstenite`), matching claim_tab.mjs.

use crate::backend::{ClaimResult, LauncherError};
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::time::Duration;
use tokio_tungstenite::tungstenite::Message;

/// A minimal CDP-over-WebSocket client: send a command, await its response by id.
struct CdpWs {
    tx: futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        Message,
    >,
    rx: futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    >,
    next_id: i64,
    // Responses keyed by command id, drained as we await each.
    inbox: HashMap<i64, serde_json::Value>,
}

impl CdpWs {
    async fn connect(cdp_ws_url: &str) -> Result<Self, LauncherError> {
        let (stream, _) = tokio_tungstenite::connect_async(cdp_ws_url)
            .await
            .map_err(|e| LauncherError::Cdp { stage: "ws_connect", message: e.to_string() })?;
        let (tx, rx) = stream.split();
        Ok(Self { tx, rx, next_id: 0, inbox: HashMap::new() })
    }

    /// Send a CDP command (optionally on a flattened session) and await its response.
    async fn send(
        &mut self,
        method: &str,
        params: serde_json::Value,
        session_id: Option<&str>,
    ) -> Result<serde_json::Value, LauncherError> {
        self.next_id += 1;
        let id = self.next_id;
        let mut msg = serde_json::json!({ "id": id, "method": method, "params": params });
        if let Some(sid) = session_id {
            msg["sessionId"] = serde_json::Value::String(sid.to_string());
        }
        self.tx
            .send(Message::Text(msg.to_string()))
            .await
            .map_err(|e| LauncherError::Cdp { stage: "ws_send", message: e.to_string() })?;
        // Await the matching response id (buffering any others / events).
        loop {
            if let Some(v) = self.inbox.remove(&id) {
                return Ok(v);
            }
            let frame = tokio::time::timeout(Duration::from_secs(30), self.rx.next())
                .await
                .map_err(|_| LauncherError::Timeout { stage: "ws_recv", message: method.into() })?
                .ok_or_else(|| LauncherError::Cdp { stage: "ws_recv", message: "closed".into() })?
                .map_err(|e| LauncherError::Cdp { stage: "ws_recv", message: e.to_string() })?;
            if let Message::Text(t) = frame {
                if let Ok(d) = serde_json::from_str::<serde_json::Value>(&t) {
                    if let Some(rid) = d.get("id").and_then(|v| v.as_i64()) {
                        self.inbox.insert(rid, d);
                    }
                    // events (no id) are ignored for claim purposes
                }
            }
        }
    }
}

/// The popup-context script that finds the target tab, stores the bridge URL, and sends the
/// `authorize-tab` message. Returns a JSON string. Built to mirror claim_tab.mjs's expression.
fn build_claim_expression(target_url_contains: &str, bridge_url: &str) -> String {
    let needle = serde_json::to_string(target_url_contains).unwrap();
    let bridge = serde_json::to_string(bridge_url).unwrap();
    format!(
        "(async()=>{{ try {{ \
           const tabs = await chrome.tabs.query({{}}); \
           const needle = {needle}; \
           const target = tabs.find(t => (t.url||'').includes(needle)); \
           if (!target) return JSON.stringify({{ ok:false, error:'no tab matching '+needle }}); \
           const bridgeUrl = {bridge}; \
           await chrome.storage.local.set({{ bridgeUrl }}); \
           const response = await chrome.runtime.sendMessage({{ type:'actions-json:authorize-tab', tabId: target.id, bridgeUrl }}); \
           return JSON.stringify({{ ok: !!(response && response.ok), tabId: target.id, bridgeUrl, response }}); \
         }} catch (e) {{ return JSON.stringify({{ ok:false, error: String(e && e.message || e) }}); }} }})()"
    )
}

/// Drive the headless claim. `cdp_ws_url` is the relay/endpoint WS; `ext_id` the extension id;
/// `target_url_contains` a substring of the tab to claim; `bridge_url` the bridge WS the
/// extension should connect to. Returns the claimed tab id + registration ids.
pub async fn claim_tab(
    cdp_ws_url: &str,
    ext_id: &str,
    target_url_contains: &str,
    bridge_url: &str,
) -> Result<ClaimResult, LauncherError> {
    let mut cdp = CdpWs::connect(cdp_ws_url).await?;

    // 1) Open the extension popup as a real tab (wakes + holds the SW).
    let popup_url = format!("chrome-extension://{ext_id}/popup.html");
    let created = cdp
        .send("Target.createTarget", serde_json::json!({ "url": popup_url }), None)
        .await?;
    let popup_target_id = created["result"]["targetId"].as_str().ok_or_else(|| LauncherError::Cdp {
        stage: "open_popup",
        message: created["error"].to_string(),
    })?;

    // 2) Attach (flatten) to eval in the popup context.
    let attached = cdp
        .send(
            "Target.attachToTarget",
            serde_json::json!({ "targetId": popup_target_id, "flatten": true }),
            None,
        )
        .await?;
    let sid = attached["result"]["sessionId"].as_str().ok_or_else(|| LauncherError::Cdp {
        stage: "attach_popup",
        message: attached["error"].to_string(),
    })?;
    let sid = sid.to_string();
    cdp.send("Runtime.enable", serde_json::json!({}), Some(&sid)).await?;
    tokio::time::sleep(Duration::from_millis(600)).await; // let popup.js load

    // 3) From the popup context, find target tab, store bridgeUrl, send authorize-tab.
    let expr = build_claim_expression(target_url_contains, bridge_url);
    let evaled = cdp
        .send(
            "Runtime.evaluate",
            serde_json::json!({ "expression": expr, "returnByValue": true, "awaitPromise": true }),
            Some(&sid),
        )
        .await?;
    if let Some(exc) = evaled["result"]["exceptionDetails"].as_object() {
        return Err(LauncherError::Cdp {
            stage: "eval",
            message: format!("popup eval threw: {exc:?}"),
        });
    }
    let raw = evaled["result"]["result"]["value"].as_str().ok_or_else(|| LauncherError::Cdp {
        stage: "eval_value",
        message: "no string value from popup eval".into(),
    })?;
    let result: serde_json::Value = serde_json::from_str(raw).map_err(|e| LauncherError::Cdp {
        stage: "eval_parse",
        message: e.to_string(),
    })?;
    // Leave the popup tab OPEN (closing it lets the SW sleep and drops the bridge).
    if result["ok"].as_bool() != Some(true) {
        return Err(LauncherError::Cdp {
            stage: "authorize",
            message: result["error"].to_string(),
        });
    }
    let response = &result["response"];
    Ok(ClaimResult {
        tab_id: result["tabId"].as_i64().unwrap_or(-1),
        runtime_key: response["runtimeKey"].as_str().unwrap_or("").to_string(),
        authorization_id: response["authorizationId"].as_str().unwrap_or("").to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_expression_embeds_needle_and_bridge() {
        let e = build_claim_expression("docs.google.com/document/d/", "ws://127.0.0.1:17346/extension");
        assert!(e.contains("docs.google.com/document/d/"));
        assert!(e.contains("ws://127.0.0.1:17346/extension"));
        assert!(e.contains("actions-json:authorize-tab"));
        assert!(e.contains("chrome.tabs.query"));
    }

    #[test]
    fn claim_expression_escapes_injection() {
        // A needle with a quote must be JSON-escaped, not break the expression.
        let e = build_claim_expression("a\"b", "ws://x");
        assert!(e.contains("a\\\"b"));
    }
}
