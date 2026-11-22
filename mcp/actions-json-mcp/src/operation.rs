use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OperationRequest {
    pub name: String,
    #[serde(default)]
    pub arguments: Value,
    #[serde(default)]
    pub target_runtime_id: Option<String>,
    #[serde(default)]
    pub target_url_contains: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

impl OperationRequest {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            arguments: Value::Object(Map::new()),
            target_runtime_id: None,
            target_url_contains: None,
            timeout_ms: default_timeout_ms(),
        }
    }
}

fn default_timeout_ms() -> u64 {
    30_000
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ResolvedOperation {
    pub name: String,
    pub arguments: Value,
    pub target_runtime_id: Option<String>,
    pub target_url_contains: Option<String>,
    pub timeout_ms: u64,
    pub static_output: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    InvalidCatalog { message: String },
    UnknownOperation { name: String },
    InvalidArguments { name: String, message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CanonicalOutcome {
    Success,
    InvalidInput,
    Unavailable,
    Refused,
    Failed,
    Indeterminate,
}

/// Classify the legacy adapter result without changing its wire shape. A
/// dispatch timeout is indeterminate because the browser may have mutated the
/// page before post-mutation verification or delivery failed.
pub fn classify_legacy_result(status: u16, payload: &Value) -> CanonicalOutcome {
    if (200..300).contains(&status) && payload.get("ok").and_then(Value::as_bool) != Some(false) {
        return CanonicalOutcome::Success;
    }
    let code = payload
        .pointer("/error/code")
        .and_then(Value::as_str)
        .or_else(|| payload.get("code").and_then(Value::as_str));
    match (status, code) {
        (504, Some("dispatch_timeout")) => CanonicalOutcome::Indeterminate,
        (400 | 422, _) => CanonicalOutcome::InvalidInput,
        (404 | 502 | 503 | 504, _) => CanonicalOutcome::Unavailable,
        (401 | 403 | 409, _) => CanonicalOutcome::Refused,
        _ => CanonicalOutcome::Failed,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OperationDescription {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone)]
struct Registration {
    description: OperationDescription,
    handler: Option<String>,
    binding_arguments: Value,
    target_url_contains: Option<String>,
    static_output: Option<Value>,
}

/// The single catalog used for discovery and resolution. Keeping these in one
/// registry makes it impossible to advertise an operation that cannot enter
/// the canonical dispatch path.
#[derive(Debug, Clone, Default)]
pub struct OperationRegistry {
    entries: BTreeMap<String, Registration>,
}

impl OperationRegistry {
    pub fn from_manifest(manifest: &Value) -> Result<Self, ResolveError> {
        let tools = manifest
            .get("tools")
            .and_then(Value::as_array)
            .ok_or_else(|| ResolveError::InvalidCatalog {
                message: "manifest.tools must be an array".into(),
            })?;
        let mut entries = BTreeMap::new();
        for tool in tools {
            let name = tool
                .get("name")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .ok_or_else(|| ResolveError::InvalidCatalog {
                    message: "every tool needs a non-empty name".into(),
                })?;
            // Site-map overlays may deliberately contribute the same public
            // name so the higher routing layer can report target ambiguity.
            // Match legacy `find_tool` semantics here: registration keeps the
            // first declaration and does not pre-empt that richer refusal.
            if entries.contains_key(name) {
                continue;
            }
            let x = tool.get("x_actions");
            entries.insert(
                name.to_string(),
                Registration {
                    description: OperationDescription {
                        name: name.to_string(),
                        description: tool
                            .get("description")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        input_schema: tool
                            .get("input_schema")
                            .or_else(|| tool.get("inputSchema"))
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!({"type":"object"})),
                    },
                    handler: x
                        .and_then(|v| v.get("handler"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    binding_arguments: x
                        .and_then(|v| v.get("binding"))
                        .and_then(|v| v.get("arguments"))
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({})),
                    target_url_contains: x
                        .and_then(|v| v.get("binding"))
                        .and_then(|v| v.get("target_url_contains"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    static_output: x.and_then(|v| v.get("static_output")).cloned(),
                },
            );
        }
        Ok(Self { entries })
    }

    pub fn list(&self) -> Vec<OperationDescription> {
        self.entries
            .values()
            .map(|entry| entry.description.clone())
            .collect()
    }

    pub fn describe(&self, name: &str) -> Option<OperationDescription> {
        self.entries
            .get(name)
            .map(|entry| entry.description.clone())
    }

    pub fn resolve(&self, request: &OperationRequest) -> Result<ResolvedOperation, ResolveError> {
        let entry =
            self.entries
                .get(&request.name)
                .ok_or_else(|| ResolveError::UnknownOperation {
                    name: request.name.clone(),
                })?;
        let arguments = merge_objects(
            entry.binding_arguments.clone(),
            request.arguments.clone(),
            &request.name,
        )?;
        Ok(ResolvedOperation {
            name: entry
                .handler
                .clone()
                .unwrap_or_else(|| request.name.clone()),
            arguments,
            target_runtime_id: request.target_runtime_id.clone(),
            target_url_contains: request
                .target_url_contains
                .clone()
                .or_else(|| entry.target_url_contains.clone()),
            timeout_ms: request.timeout_ms,
            static_output: entry.static_output.clone(),
        })
    }
}

fn merge_objects(base: Value, supplied: Value, name: &str) -> Result<Value, ResolveError> {
    let mut base = base
        .as_object()
        .cloned()
        .ok_or_else(|| ResolveError::InvalidArguments {
            name: name.into(),
            message: "catalog binding arguments must be an object".into(),
        })?;
    let supplied = supplied
        .as_object()
        .ok_or_else(|| ResolveError::InvalidArguments {
            name: name.into(),
            message: "arguments must be an object".into(),
        })?;
    base.extend(supplied.clone());
    Ok(Value::Object(base))
}
