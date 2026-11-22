//! Canonical, noninteractive actions.json command surface.
//!
//! This module is intentionally a thin adapter. It parses protocol-v1 input,
//! ensures the same executable's resident is available, and sends canonical
//! operation envelopes over protected per-user IPC. It never calls MCP or the
//! compatibility HTTP API.

pub mod exit;
pub mod io;

use std::{
    ffi::OsString,
    fs,
    io::{self as stdio, BufRead, Read},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::resident::{self, Client, IngressAdapter, IpcRequest, ResidentConfig};
use exit::Outcome;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_CLI_RECORD_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_INLINE_LIMIT: u64 = 262_144;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    protocol_version: u32,
    operation: String,
    arguments: Value,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    profile: Option<ProfileRef>,
    #[serde(default)]
    target: Option<TargetRef>,
    #[serde(default)]
    expected_catalog_revision: Option<String>,
    #[serde(default)]
    output: Option<OutputPolicy>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    lease_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileRef {
    name: String,
    token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct TargetRef {
    #[serde(default)]
    target_id: Option<String>,
    #[serde(default)]
    runtime_id: Option<String>,
    #[serde(default)]
    url_contains: Option<String>,
    #[serde(default)]
    target_generation: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct OutputPolicy {
    mode: String,
    #[serde(default)]
    path: Option<PathBuf>,
    #[serde(default)]
    max_inline_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
struct ProtocolResult {
    protocol_version: u32,
    ok: bool,
    outcome: Outcome,
    operation_id: Option<String>,
    request_id: Option<String>,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    catalog_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mutation_revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    interference: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    spill: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retention_deadline: Option<i64>,
}

impl ProtocolResult {
    fn success(result: Value, request_id: Option<String>) -> Self {
        let operation_id = string_at(
            &result,
            &[
                "operation_id",
                "call_id",
                "/admission/operation_id",
                "/operation/operation_id",
            ],
        );
        let request_id =
            request_id.or_else(|| string_at(&result, &["request_id", "/operation/request_id"]));
        let status = string_at(&result, &["status", "/operation/state"])
            .unwrap_or_else(|| "terminal".into());
        Self {
            protocol_version: PROTOCOL_VERSION,
            ok: true,
            outcome: Outcome::Success,
            operation_id,
            request_id,
            status,
            target_generation: string_at(
                &result,
                &[
                    "target_generation",
                    "/target/target_generation",
                    "/catalog/target_generation",
                ],
            ),
            catalog_revision: string_at(
                &result,
                &[
                    "catalog_revision",
                    "/target/catalog_revision",
                    "/catalog/catalog_revision",
                ],
            ),
            mutation_revision: integer_at(
                &result,
                &["mutation_revision", "/coordination/current_revision"],
            ),
            interference: result
                .get("interference")
                .cloned()
                .or_else(|| result.pointer("/coordination/notices").cloned()),
            spill: result
                .get("spill")
                .cloned()
                .or_else(|| result.pointer("/operation/spill").cloned()),
            retention_deadline: integer_at(
                &result,
                &["retention_deadline", "/operation/retention_deadline_ms"],
            ),
            result: Some(result),
            error: None,
        }
    }

    fn failure(
        outcome: Outcome,
        code: &str,
        message: impl Into<String>,
        request_id: Option<String>,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            ok: false,
            outcome,
            operation_id: None,
            request_id,
            status: if outcome == Outcome::TransportFailure {
                "not_accepted"
            } else {
                "terminal"
            }
            .into(),
            result: None,
            error: Some(json!({"code":code,"message":message.into()})),
            target_generation: None,
            catalog_revision: None,
            mutation_revision: None,
            interference: None,
            spill: None,
            retention_deadline: None,
        }
    }

    fn from_raw(raw: Value, request_id: Option<String>) -> Self {
        if raw.get("ok").and_then(Value::as_bool) != Some(false) {
            return Self::success(raw, request_id);
        }
        let code = raw
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("operation_failed");
        let message = raw
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or(code);
        let outcome = classify_code(code, &raw);
        let mut result = Self::failure(outcome, code, message, request_id);
        result.operation_id = string_at(
            &raw,
            &[
                "operation_id",
                "/admission/operation_id",
                "/operation/operation_id",
            ],
        );
        result.status =
            string_at(&raw, &["status", "/operation/state"]).unwrap_or_else(|| "terminal".into());
        if result.status == "accepted" && result.outcome == Outcome::TransportFailure {
            result.operation_id = string_at(&raw, &["operation_id", "/admission/operation_id"]);
        }
        result.error = raw.get("error").cloned().or(result.error);
        result
    }
}

#[derive(Debug, Clone)]
struct Config {
    state_dir: PathBuf,
    executable_version: String,
    timeout: Duration,
    actions: Option<PathBuf>,
    bind: Option<String>,
    storage_root: Option<PathBuf>,
    configuration_id: String,
    install_config_path: Option<PathBuf>,
    install_config_present: bool,
    configuration_source: &'static str,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)] // Credential fields are consumed by the bridge, not the CLI adapter.
struct InstallConfig {
    #[serde(default = "default_install_config_schema_version")]
    schema_version: u32,
    #[serde(default)]
    state_dir: Option<PathBuf>,
    #[serde(default)]
    actions: Option<PathBuf>,
    #[serde(default)]
    bind: Option<String>,
    #[serde(default)]
    storage_root: Option<PathBuf>,
    #[serde(default)]
    bridge_handshake_secret: Option<String>,
    #[serde(default)]
    bridge_pairing_revoked: Option<bool>,
    #[serde(default)]
    extension_ids: Option<Vec<String>>,
    #[serde(default)]
    openai_api_key: Option<String>,
    #[serde(default)]
    protoface_api_key: Option<String>,
    #[serde(default)]
    livekit_url: Option<String>,
    #[serde(default)]
    livekit_api_key: Option<String>,
    #[serde(default)]
    livekit_api_secret: Option<String>,
}

fn default_install_config_schema_version() -> u32 {
    1
}

impl Config {
    fn load(skip_project_pin: bool) -> Result<Self, ProtocolResult> {
        let installed = load_install_config()?;
        let environment_override = [
            "ACTIONS_JSON_STATE_DIR",
            "ACTIONS_JSON_ACTIONS",
            "ACTIONS_JSON_BIND",
            "ACTIONS_JSON_STORAGE_ROOT",
        ]
        .into_iter()
        .any(|name| std::env::var_os(name).is_some());
        let install_config_present = installed.is_some();
        let configuration_source = match (environment_override, install_config_present) {
            (true, true) => "mixed",
            (true, false) => "environment_override",
            (false, true) => "config_file",
            (false, false) => "default",
        };
        let state_dir = std::env::var_os("ACTIONS_JSON_STATE_DIR")
            .map(PathBuf::from)
            .or_else(|| installed.as_ref().and_then(|value| value.state_dir.clone()))
            .or_else(default_state_dir)
            .ok_or_else(|| {
                ProtocolResult::failure(
                    Outcome::Unavailable,
                    "state_directory_unavailable",
                    "cannot determine per-user state directory",
                    None,
                )
            })?;
        let executable_version = env!("CARGO_PKG_VERSION").to_string();
        if !skip_project_pin {
            verify_project_pin(&executable_version)?;
        }
        let actions = std::env::var_os("ACTIONS_JSON_ACTIONS")
            .map(PathBuf::from)
            .or_else(|| installed.as_ref().and_then(|value| value.actions.clone()));
        let bind = std::env::var("ACTIONS_JSON_BIND")
            .ok()
            .or_else(|| installed.as_ref().and_then(|value| value.bind.clone()));
        let bind = match bind {
            Some(value) => match value.parse::<std::net::SocketAddr>() {
                Ok(address) => Some(address.to_string()),
                _ => {
                    return Err(ProtocolResult::failure(
                        Outcome::InvalidInput,
                        "install_config_invalid_bind",
                        "bridge bind must be an IP socket address",
                        None,
                    ));
                }
            },
            None => None,
        };
        let storage_root = std::env::var_os("ACTIONS_JSON_STORAGE_ROOT")
            .map(PathBuf::from)
            .or_else(|| {
                installed
                    .as_ref()
                    .and_then(|value| value.storage_root.clone())
            });
        let configuration_id = resident::configuration_id(
            actions.as_deref(),
            bind.as_deref(),
            &[],
            storage_root.as_deref(),
        );
        Ok(Self {
            state_dir,
            executable_version,
            timeout: Duration::from_millis(DEFAULT_TIMEOUT_MS),
            actions,
            bind,
            storage_root,
            configuration_id,
            install_config_path: install_config_path(),
            install_config_present,
            configuration_source,
        })
    }

    fn resident(&self) -> ResidentConfig {
        ResidentConfig {
            state_dir: self.state_dir.clone(),
            executable_version: self.executable_version.clone(),
            configuration_id: Some(self.configuration_id.clone()),
            startup_timeout: Duration::from_secs(8),
        }
    }
}

pub async fn run_process(arguments: Vec<OsString>) -> i32 {
    let result = run_process_inner(arguments).await;
    let exit = result.outcome.exit_code();
    if result.status == "stream_complete" {
        return exit;
    }
    match io::write_json(&serde_json::to_value(&result).unwrap_or_else(|_| json!({"protocol_version":1,"ok":false,"outcome":"failed","operation_id":null,"request_id":null,"status":"terminal","error":{"code":"serialization_failure"}}))) {
        Ok(false) => 0,
        Ok(true) => exit,
        Err(_) => 7,
    }
}

async fn run_process_inner(arguments: Vec<OsString>) -> ProtocolResult {
    let args = match utf8_arguments(arguments) {
        Ok(args) => args,
        Err(result) => return result,
    };
    if args.first().is_some_and(|value| value == "stream") {
        return run_stream(&args[1..]).await;
    }
    let command = match parse_command(&args) {
        Ok(value) => value,
        Err(error) => return error,
    };
    let skip_project_pin = matches!(command, CommandSpec::Local(LocalCommand::Update { .. }));
    let config = match Config::load(skip_project_pin) {
        Ok(value) => value,
        Err(error) => return error,
    };
    match command {
        CommandSpec::Envelope(envelope) => execute(&config, envelope).await,
        CommandSpec::Local(command) => execute_local(&config, command).await,
    }
}

async fn run_stream(args: &[String]) -> ProtocolResult {
    if !args.is_empty() {
        return ProtocolResult::failure(
            Outcome::InvalidInput,
            "unexpected_argument",
            "stream accepts NDJSON on stdin and no positional arguments",
            None,
        );
    }
    let config = match Config::load(false) {
        Ok(value) => value,
        Err(error) => return error,
    };
    let stdin = stdio::stdin();
    let mut saw_record = false;
    let mut worst = Outcome::Success;
    let mut reader = stdin.lock();
    loop {
        let line = match read_bounded_stream_record(&mut reader, MAX_CLI_RECORD_BYTES) {
            Ok(StreamRecord::Eof) => break,
            Ok(StreamRecord::TooLarge) => {
                saw_record = true;
                let result = invalid(
                    "payload_too_large",
                    format!("stream record exceeds {MAX_CLI_RECORD_BYTES} bytes"),
                );
                if result.outcome.exit_code() > worst.exit_code() {
                    worst = result.outcome;
                }
                if !matches!(
                    io::write_json(&serde_json::to_value(&result).unwrap()),
                    Ok(true)
                ) {
                    return result;
                }
                continue;
            }
            Ok(StreamRecord::Data(value)) => value,
            Err(error) => {
                let result = ProtocolResult::failure(
                    Outcome::InvalidInput,
                    "stdin_read_failed",
                    error.to_string(),
                    None,
                );
                let _ = io::write_json(&serde_json::to_value(&result).unwrap());
                return result;
            }
        };
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        saw_record = true;
        let result = match std::str::from_utf8(&line)
            .map_err(|error| invalid("invalid_envelope", error.to_string()))
            .and_then(parse_envelope)
        {
            Ok(value) => execute(&config, value).await,
            Err(value) => value,
        };
        if result.outcome.exit_code() > worst.exit_code() {
            worst = result.outcome;
        }
        match io::write_json(&serde_json::to_value(&result).unwrap()) {
            Ok(true) => {}
            Ok(false) => {
                return ProtocolResult::success(
                    json!({"records_written":0,"pipe_closed":true}),
                    None,
                )
            }
            Err(error) => {
                return ProtocolResult::failure(
                    Outcome::TransportFailure,
                    "stdout_write_failed",
                    error.to_string(),
                    None,
                )
            }
        }
    }
    // run_process writes one final object, but stream's contract is exactly one
    // result per nonempty line. Return a sentinel consumed by run_process.
    ProtocolResult {
        status: "stream_complete".into(),
        result: Some(json!({"records_seen":saw_record})),
        outcome: worst,
        ok: worst == Outcome::Success,
        protocol_version: 1,
        operation_id: None,
        request_id: None,
        error: None,
        target_generation: None,
        catalog_revision: None,
        mutation_revision: None,
        interference: None,
        spill: None,
        retention_deadline: None,
    }
}

enum CommandSpec {
    Envelope(Envelope),
    Local(LocalCommand),
}
enum LocalCommand {
    Version,
    Status,
    Doctor,
    Logs,
    Shutdown,
    Pair { action: String, reveal: bool },
    Update { action: String },
}

fn parse_command(args: &[String]) -> Result<CommandSpec, ProtocolResult> {
    if args.is_empty() || args.first().is_some_and(|value| value == "run") {
        if args.len() > 1 {
            return Err(invalid(
                "unexpected_argument",
                "run accepts its envelope on stdin",
            ));
        }
        return read_stdin()
            .and_then(|text| parse_envelope(&text))
            .map(CommandSpec::Envelope);
    }
    match args[0].as_str() {
        "version" | "--version" => no_extra(args, LocalCommand::Version),
        "status" => no_extra(args, LocalCommand::Status),
        "doctor" => no_extra(args, LocalCommand::Doctor),
        "logs" => no_extra(args, LocalCommand::Logs),
        "shutdown" => no_extra(args, LocalCommand::Shutdown),
        "pair" => {
            let action = args.get(1).cloned().unwrap_or_else(|| "inspect".into());
            if !matches!(action.as_str(), "create" | "inspect" | "rotate" | "revoke") {
                return Err(invalid(
                    "invalid_pair_action",
                    "pair action must be create, inspect, rotate, or revoke",
                ));
            }
            let reveal = args.iter().skip(2).any(|value| value == "--reveal-secret");
            if args.iter().skip(2).any(|value| value != "--reveal-secret") {
                return Err(invalid(
                    "unexpected_argument",
                    "pair accepts only --reveal-secret",
                ));
            }
            Ok(CommandSpec::Local(LocalCommand::Pair { action, reveal }))
        }
        "update" => {
            let action = args.get(1).cloned().unwrap_or_else(|| "check".into());
            if !matches!(action.as_str(), "check" | "apply" | "recover") || args.len() > 2 {
                return Err(invalid(
                    "invalid_update_action",
                    "update action must be check, apply, or recover",
                ));
            }
            Ok(CommandSpec::Local(LocalCommand::Update { action }))
        }
        "list" => {
            let values = flags(&args[1..])?;
            Ok(CommandSpec::Envelope(control(
                "resident.catalog.list",
                selector_arguments(values)?,
            )?))
        }
        "describe" => {
            let operation = args.get(1).ok_or_else(|| {
                invalid("missing_operation", "describe requires an operation name")
            })?;
            let mut body = selector_arguments(flags(&args[2..])?)?
                .as_object()
                .cloned()
                .unwrap();
            body.insert("operation".into(), json!(operation));
            Ok(CommandSpec::Envelope(control(
                "resident.catalog.describe",
                Value::Object(body),
            )?))
        }
        "profile" => parse_profile(args),
        "target" => parse_target(args),
        "lease" => parse_lease(args),
        "operation" => parse_operation_status(args),
        operation => {
            let mut values = flags(&args[1..])?;
            let arguments: Value = read_stdin().and_then(|value| {
                serde_json::from_str(&value)
                    .map_err(|error| invalid("invalid_json", error.to_string()))
            })?;
            if !arguments.is_object() {
                return Err(invalid(
                    "invalid_arguments",
                    "shorthand stdin must be a JSON object",
                ));
            }
            let profile = match (values.remove("profile"), values.remove("profile-token")) {
                (Some(name), Some(token)) => Some(ProfileRef {
                    name: name.as_str().unwrap().into(),
                    token: token.as_str().unwrap().into(),
                }),
                (None, None) => None,
                _ => {
                    return Err(invalid(
                        "invalid_profile",
                        "--profile and --profile-token must be supplied together",
                    ))
                }
            };
            let target = {
                let target_id = string_value(values.remove("target-id"));
                let runtime_id = string_value(values.remove("runtime-id"));
                let url_contains = string_value(values.remove("url-contains"));
                let target_generation = string_value(values.remove("target-generation"));
                if [
                    target_id.as_ref(),
                    runtime_id.as_ref(),
                    url_contains.as_ref(),
                    target_generation.as_ref(),
                ]
                .iter()
                .any(|v| v.is_some())
                {
                    Some(TargetRef {
                        target_id,
                        runtime_id,
                        url_contains,
                        target_generation,
                    })
                } else {
                    None
                }
            };
            let expected_catalog_revision = string_value(values.remove("catalog-revision"));
            let request_id = string_value(values.remove("request-id"));
            let timeout_ms = parse_u64(values.remove("timeout-ms"), "timeout-ms")?;
            let lease_token = string_value(values.remove("lease-token"));
            let output = if let Some(mode) = string_value(values.remove("output-mode")) {
                Some(OutputPolicy {
                    mode,
                    path: string_value(values.remove("output-path")).map(PathBuf::from),
                    max_inline_bytes: parse_u64(
                        values.remove("max-inline-bytes"),
                        "max-inline-bytes",
                    )?,
                })
            } else if values.contains_key("output-path") || values.contains_key("max-inline-bytes")
            {
                return Err(invalid(
                    "output_mode_required",
                    "--output-mode is required with output controls",
                ));
            } else {
                None
            };
            reject_remaining(values)?;
            Ok(CommandSpec::Envelope(Envelope {
                protocol_version: 1,
                operation: operation.into(),
                arguments,
                request_id,
                profile,
                target,
                expected_catalog_revision,
                output,
                timeout_ms,
                lease_token,
            }))
        }
    }
}

fn parse_profile(args: &[String]) -> Result<CommandSpec, ProtocolResult> {
    let action = args.get(1).ok_or_else(|| {
        invalid(
            "missing_profile_action",
            "profile requires create, inspect, list, rotate, or delete",
        )
    })?;
    let mut values = flags(&args[2..])?;
    let (operation, body) = match action.as_str() {
        "list" if values.is_empty() => ("resident.profile.list", json!({})),
        "create" => (
            "resident.profile.create",
            json!({"name":take(&mut values,"name")?,"label":values.remove("label")}),
        ),
        "inspect" => (
            "resident.profile.status",
            json!({"name":take(&mut values,"name")?,"token":take(&mut values,"token")?}),
        ),
        "rotate" => (
            "resident.profile.rotate",
            json!({"name":take(&mut values,"name")?,"token":take(&mut values,"token")?}),
        ),
        "delete" => (
            "resident.profile.delete",
            json!({"name":take(&mut values,"name")?,"token":take(&mut values,"token")?}),
        ),
        _ => {
            return Err(invalid(
                "invalid_profile_action",
                "profile requires create, inspect, list, rotate, or delete",
            ))
        }
    };
    reject_remaining(values)?;
    Ok(CommandSpec::Envelope(control(operation, body)?))
}

fn parse_target(args: &[String]) -> Result<CommandSpec, ProtocolResult> {
    let action = args
        .get(1)
        .ok_or_else(|| invalid("missing_target_action", "target requires get, set, or list"))?;
    let mut values = flags(&args[2..])?;
    let (operation, body) = match action.as_str() {
        "list" if values.is_empty() => ("resident.target.list", json!({})),
        "get" => (
            "resident.profile.status",
            json!({"name":take(&mut values,"profile")?,"token":take(&mut values,"profile-token")?}),
        ),
        "set" => (
            "resident.target.select",
            json!({"name":take(&mut values,"profile")?,"token":take(&mut values,"profile-token")?,"target_id":take(&mut values,"target-id")?}),
        ),
        _ => {
            return Err(invalid(
                "invalid_target_action",
                "target requires get, set, or list",
            ))
        }
    };
    reject_remaining(values)?;
    Ok(CommandSpec::Envelope(control(operation, body)?))
}

fn parse_lease(args: &[String]) -> Result<CommandSpec, ProtocolResult> {
    let action = args.get(1).ok_or_else(|| {
        invalid(
            "missing_lease_action",
            "lease requires acquire, release, or inspect",
        )
    })?;
    let mut values = flags(&args[2..])?;
    let operation = match action.as_str() {
        "acquire" => "resident.lease.acquire",
        "release" => "resident.lease.release",
        "inspect" => "resident.lease.inspect",
        _ => {
            return Err(invalid(
                "invalid_lease_action",
                "lease requires acquire, release, or inspect",
            ))
        }
    };
    let mut body = Map::new();
    for key in [
        "profile",
        "profile-token",
        "target-id",
        "lease-token",
        "duration-ms",
    ] {
        if let Some(value) = values.remove(key) {
            body.insert(
                key.replace('-', "_"),
                if key == "duration-ms" {
                    json!(value
                        .as_str()
                        .and_then(|v| v.parse::<i64>().ok())
                        .ok_or_else(|| invalid(
                            "invalid_duration",
                            "duration-ms must be an integer"
                        ))?)
                } else {
                    value
                },
            );
        }
    }
    reject_remaining(values)?;
    Ok(CommandSpec::Envelope(control(
        operation,
        Value::Object(body),
    )?))
}

fn parse_operation_status(args: &[String]) -> Result<CommandSpec, ProtocolResult> {
    if args.get(1).map(String::as_str) != Some("status") {
        return Err(invalid(
            "invalid_operation_action",
            "operation requires status",
        ));
    }
    let mut values = flags(&args[2..])?;
    let id = take(&mut values, "operation-id")?;
    reject_remaining(values)?;
    Ok(CommandSpec::Envelope(control(
        "resident.operation.status",
        json!({"operation_id":id}),
    )?))
}

async fn execute(config: &Config, mut envelope: Envelope) -> ProtocolResult {
    if envelope.protocol_version != PROTOCOL_VERSION {
        return invalid(
            "unsupported_protocol_version",
            format!("expected protocol_version {PROTOCOL_VERSION}"),
        );
    }
    if envelope.operation.trim().is_empty() || !envelope.arguments.is_object() {
        return invalid(
            "invalid_envelope",
            "operation must be nonempty and arguments must be an object",
        );
    }
    if let Some(output) = &envelope.output {
        if !matches!(output.mode.as_str(), "auto" | "inline" | "file") {
            return invalid(
                "invalid_output_mode",
                "output.mode must be auto, inline, or file",
            );
        }
        if output.mode == "file" && output.path.is_none() {
            return invalid(
                "output_path_required",
                "output.path is required when mode is file",
            );
        }
        if output.max_inline_bytes == Some(0) {
            return invalid(
                "invalid_inline_limit",
                "max_inline_bytes must be greater than zero",
            );
        }
    }
    if envelope.request_id.is_none() {
        envelope.request_id = Some(format!("aj_{}", uuid::Uuid::new_v4().simple()));
    }
    let request_id = envelope.request_id.clone();
    let resident = match ensure(config).await {
        Ok(value) => value,
        Err(value) => return value,
    };
    let wire = wire_envelope(envelope);
    match resident
        .request(&IpcRequest::AdapterOperation {
            envelope: wire,
            adapter: IngressAdapter::Cli,
            client_version: Some(config.executable_version.clone()),
        })
        .await
    {
        Ok(response) if response.ok => response
            .result
            .map(|raw| ProtocolResult::from_raw(raw, request_id.clone()))
            .unwrap_or_else(|| {
                ProtocolResult::failure(
                    Outcome::TransportFailure,
                    "resident_result_missing",
                    "resident omitted operation result",
                    request_id,
                )
            }),
        Ok(response) => {
            let code = response
                .error
                .as_ref()
                .map(|e| e.code.clone())
                .unwrap_or_else(|| "resident_refused".into());
            let message = response
                .error
                .map(|e| e.message)
                .unwrap_or_else(|| "resident refused operation".into());
            ProtocolResult::failure(Outcome::TransportFailure, &code, message, request_id)
        }
        Err(error) => ProtocolResult::failure(
            Outcome::TransportFailure,
            "resident_transport_failure",
            error.to_string(),
            request_id,
        ),
    }
}

async fn execute_local(config: &Config, command: LocalCommand) -> ProtocolResult {
    match command {
        LocalCommand::Version => ProtocolResult::success(
            json!({"version":config.executable_version,"protocol_version":PROTOCOL_VERSION}),
            None,
        ),
        LocalCommand::Status => {
            let resident = resident::probe_status_any(&config.resident())
                .await
                .ok()
                .flatten();
            let extension = if resident.is_some() {
                Client::new(config.resident().endpoint(), config.timeout)
                    .request(&IpcRequest::AdapterOperation {
                        envelope: json!({"name":"resident.system.status","arguments":{}}),
                        adapter: IngressAdapter::Cli,
                        client_version: Some(config.executable_version.clone()),
                    })
                    .await
                    .ok()
                    .and_then(|response| response.result)
            } else {
                None
            };
            let result = json!({"installed_version":config.executable_version,"resident":resident,"extension":extension,"state_dir":config.state_dir,"paired":pairing_secret(config).is_some(),"diagnostic":"bounded"});
            ProtocolResult::success(result, None)
        }
        LocalCommand::Doctor => doctor_command(config).await,
        LocalCommand::Logs => {
            execute(
                config,
                control("resident.audit.list", json!({"limit":50}))
                    .expect("static control envelope"),
            )
            .await
        }
        LocalCommand::Shutdown => match resident::stop_resident(&config.resident()).await {
            Ok(status) => {
                ProtocolResult::success(json!({"stopped":status.is_some(),"resident":status}), None)
            }
            Err(error) => ProtocolResult::failure(
                Outcome::TransportFailure,
                "shutdown_failed",
                error.to_string(),
                None,
            ),
        },
        LocalCommand::Pair { action, reveal } => pair_command(config, &action, reveal).await,
        LocalCommand::Update { action } => update_command(config, &action).await,
    }
}

async fn doctor_command(config: &Config) -> ProtocolResult {
    let executable = std::env::current_exe().ok();
    let executable_ready = executable
        .as_ref()
        .and_then(|path| fs::metadata(path).ok())
        .is_some_and(|metadata| metadata.is_file());
    let state_metadata = fs::metadata(&config.state_dir).ok();
    let state_exists = state_metadata.as_ref().is_some_and(|value| value.is_dir());
    let state_protected = state_metadata
        .as_ref()
        .is_some_and(|metadata| permissions_are_private(metadata));
    let pairing_configured = pairing_secret(config).is_some();

    let resident_status = resident::probe_status_any(&config.resident())
        .await
        .ok()
        .flatten();
    let resident_code = resident_health_code(resident_status.as_ref(), config);
    let resident_ready = resident_code == "resident_ready";

    let runtime_status = if resident_ready {
        Client::new(config.resident().endpoint(), config.timeout)
            .request(&IpcRequest::AdapterOperation {
                envelope: json!({"name":"resident.system.status","arguments":{}}),
                adapter: IngressAdapter::Cli,
                client_version: Some(config.executable_version.clone()),
            })
            .await
            .ok()
            .and_then(|response| response.result)
    } else {
        None
    };
    let runtimes = runtime_status
        .as_ref()
        .and_then(|value| value.pointer("/extension/runtimes"))
        .and_then(Value::as_array);
    let runtime_count = runtimes.map_or(0, Vec::len);
    let runtime_code = if !resident_ready {
        "runtime_check_not_available"
    } else if runtime_status.is_none() {
        "runtime_status_unavailable"
    } else if runtime_count == 0 {
        "runtime_not_connected"
    } else {
        "runtime_connected"
    };
    let runtime_summary = runtimes
        .into_iter()
        .flatten()
        .map(|runtime| {
            json!({
                "runtime_id": runtime.get("runtime_id"),
                "extension_version": runtime.get("extension_version"),
                "connected_at_ms": runtime.get("connected_at_ms"),
                "last_seen_ms": runtime.get("last_seen_ms"),
            })
        })
        .collect::<Vec<_>>();

    let healthy = executable_ready
        && state_exists
        && state_protected
        && pairing_configured
        && resident_ready
        && runtime_count > 0;
    let mut next_actions = Vec::new();
    if !pairing_configured {
        next_actions.push("run `aj pair create` and paste the secret directly into the extension; do not pass it through an agent");
    }
    if !resident_ready {
        next_actions.push("run any `aj` operation to start the resident, then rerun `aj doctor`");
    } else if runtime_count == 0 {
        next_actions.push("verify the extension uses the configured bridge address and pairing secret, then reconnect it");
    }
    ProtocolResult::success(
        json!({
            "diagnostic": "doctor",
            "bounded": true,
            "redacted": true,
            "healthy": healthy,
            "installation": {
                "ok": executable_ready,
                "code": if executable_ready { "installed_executable_ready" } else { "installed_executable_unavailable" },
                "version": config.executable_version,
                "protocol_version": PROTOCOL_VERSION,
                "executable": executable,
            },
            "state": {
                "ok": state_exists && state_protected,
                "code": if !state_exists { "state_directory_missing" } else if !state_protected { "state_directory_not_private" } else { "state_directory_ready" },
                "path": config.state_dir,
                "private": state_protected,
            },
            "configuration": {
                "ok": true,
                "code": "effective_configuration_loaded",
                "persisted": config.install_config_present,
                "path": config.install_config_path,
                "source": config.configuration_source,
                "precedence": ["environment_override", "config_file", "default"],
                "actions": config.actions,
                "bind": config.bind,
                "storage_root": config.storage_root,
            },
            "pairing": {
                "ok": pairing_configured,
                "code": if pairing_configured { "pairing_configured" } else { "pairing_not_configured" },
                "secret": Value::Null,
            },
            "resident": {
                "ok": resident_ready,
                "code": resident_code,
                "status": resident_status,
            },
            "runtime": {
                "ok": runtime_count > 0,
                "code": runtime_code,
                "count": runtime_count,
                "runtimes": runtime_summary,
            },
            "next_actions": next_actions,
        }),
        None,
    )
}

fn resident_health_code(
    status: Option<&resident::ResidentStatus>,
    config: &Config,
) -> &'static str {
    match status {
        None => "resident_not_running",
        Some(status) if status.protocol != resident::IPC_PROTOCOL_VERSION => {
            "resident_protocol_mismatch"
        }
        Some(status) if status.executable_version != config.executable_version => {
            "resident_version_mismatch"
        }
        Some(status)
            if status.configuration_id.as_deref() != Some(config.configuration_id.as_str()) =>
        {
            "resident_configuration_mismatch"
        }
        Some(_) => "resident_ready",
    }
}

#[cfg(unix)]
fn permissions_are_private(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o077 == 0
}

#[cfg(not(unix))]
fn permissions_are_private(_metadata: &fs::Metadata) -> bool {
    true
}

async fn update_command(config: &Config, action: &str) -> ProtocolResult {
    let update_dir = config.state_dir.join("updates");
    let candidate_executable = update_dir.join(if cfg!(windows) {
        "actions-json.exe"
    } else {
        "actions-json"
    });
    let candidate_version_path = update_dir.join("candidate.version");
    let candidate_version = fs::read_to_string(&candidate_version_path)
        .ok()
        .map(|value| value.trim().to_string());
    if action == "check" {
        return ProtocolResult::success(
            json!({
                "installed_version": config.executable_version,
                "candidate_version": candidate_version,
                "candidate_ready": candidate_executable.is_file(),
                "update_dir": update_dir,
                "project_pin": find_upward(".actions-json-version").and_then(|path| fs::read_to_string(path).ok()).map(|value| value.trim().to_string()),
            }),
            None,
        );
    }
    let Some(candidate_version) = candidate_version else {
        return ProtocolResult::failure(
            Outcome::Unavailable,
            "verified_update_absent",
            "no verified staged update is available",
            None,
        );
    };
    let active_executable = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            return ProtocolResult::failure(
                Outcome::Unavailable,
                "executable_unavailable",
                error.to_string(),
                None,
            )
        }
    };
    let active_store = config.state_dir.join("state.sqlite3");
    let candidate_store = update_dir.join("state.sqlite3.candidate");
    if !active_store.exists() {
        if let Err(error) = crate::state::store::StateStore::open(&active_store) {
            return ProtocolResult::failure(
                Outcome::Unavailable,
                "update_store_prepare_failed",
                error.to_string(),
                None,
            );
        }
    }
    let _ = fs::remove_file(&candidate_store);
    if let Err(error) = resident::copy_on_write_migrate(&active_store, &candidate_store, |_| Ok(()))
    {
        return ProtocolResult::failure(
            Outcome::Unavailable,
            "update_migration_failed",
            error.to_string(),
            None,
        );
    }
    if let Err(error) = resident::stop_resident(&config.resident()).await {
        return ProtocolResult::failure(
            Outcome::Unavailable,
            "update_shutdown_failed",
            error.to_string(),
            None,
        );
    }
    let proof_version = candidate_version.clone();
    let fence = match resident::begin_fenced_update(
        &active_executable,
        &candidate_executable,
        &active_store,
        &candidate_store,
        move |executable, _| {
            let output = Command::new(executable).arg("version").output()?;
            let reported_version = serde_json::from_slice::<Value>(&output.stdout)
                .ok()
                .and_then(|value| {
                    value
                        .pointer("/result/version")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                });
            if !output.status.success() || reported_version.as_deref() != Some(&proof_version) {
                anyhow::bail!("candidate executable did not prove exact version {proof_version}");
            }
            Ok(())
        },
    ) {
        Ok(fence) => fence,
        Err(error) => {
            return ProtocolResult::failure(
                Outcome::Unavailable,
                "update_fence_failed",
                error.to_string(),
                None,
            )
        }
    };
    let mut candidate_config = config.clone();
    candidate_config.executable_version = candidate_version.clone();
    let resident_config = ResidentConfig {
        state_dir: config.state_dir.clone(),
        executable_version: candidate_version.clone(),
        configuration_id: Some(candidate_config.configuration_id.clone()),
        startup_timeout: Duration::from_secs(8),
    };
    let executable = active_executable.clone();
    let candidate_resident = Arc::new(Mutex::new(None));
    let spawned_resident = Arc::clone(&candidate_resident);
    let started = resident::ensure_resident(&resident_config, move || {
        let configuration_id = candidate_config.configuration_id.clone();
        let resident = launch_managed_resident(
            resident_command(executable, candidate_config),
            &configuration_id,
        )?;
        *spawned_resident
            .lock()
            .expect("candidate resident mutex poisoned") = Some(resident);
        Ok(())
    })
    .await;
    match started {
        Ok(_) => match fence.commit() {
            Ok(()) => {
                let _ = fs::remove_file(candidate_version_path);
                ProtocolResult::success(
                    json!({"updated":true,"version":candidate_version,"fenced":true}),
                    None,
                )
            }
            Err(error) => ProtocolResult::failure(
                Outcome::Unavailable,
                "update_commit_failed",
                error.to_string(),
                None,
            ),
        },
        Err(error) => {
            if let Some(mut resident) = candidate_resident
                .lock()
                .expect("candidate resident mutex poisoned")
                .take()
            {
                if let Err(cleanup_error) = resident.stop_and_wait() {
                    fence.retain_candidate();
                    return ProtocolResult::failure(
                        Outcome::Unavailable,
                        "update_candidate_cleanup_failed",
                        format!(
                            "{error}; candidate cleanup failed: {cleanup_error}; rollback=false"
                        ),
                        None,
                    );
                }
            }
            let rollback = fence.rollback();
            ProtocolResult::failure(
                Outcome::Unavailable,
                "update_candidate_not_ready",
                format!("{error}; rollback={}", rollback.is_ok()),
                None,
            )
        }
    }
}

async fn pair_command(config: &Config, action: &str, reveal: bool) -> ProtocolResult {
    let Some(path) = config.install_config_path.clone() else {
        return ProtocolResult::failure(
            Outcome::Unavailable,
            "pairing_storage_failed",
            "cannot determine the actions.json config path",
            None,
        );
    };
    let Some(parent) = path.parent() else {
        return ProtocolResult::failure(
            Outcome::Unavailable,
            "pairing_storage_failed",
            "actions.json config path has no parent directory",
            None,
        );
    };
    if let Err(error) = crate::state::store::create_protected_dir(parent) {
        return ProtocolResult::failure(
            Outcome::Unavailable,
            "pairing_storage_failed",
            error.to_string(),
            None,
        );
    }
    let mut value = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or_else(|| json!({}));
    let old = value
        .get("bridge_handshake_secret")
        .and_then(Value::as_str)
        .map(str::to_string);
    if action == "inspect" {
        return pairing_result(config, old, reveal, false);
    }
    if action == "create" && old.is_some() {
        return pairing_result(config, old, reveal, false);
    }
    if let Err(error) = resident::stop_resident(&config.resident()).await {
        return ProtocolResult::failure(
            Outcome::Unavailable,
            "pairing_resident_stop_failed",
            error.to_string(),
            None,
        );
    }
    if let Some(object) = value.as_object_mut() {
        if action == "revoke" {
            object.remove("bridge_handshake_secret");
            object.insert("bridge_pairing_revoked".into(), json!(true));
        } else {
            object.insert(
                "bridge_handshake_secret".into(),
                json!(format!("ajhs_{}", uuid::Uuid::new_v4().simple())),
            );
            object.remove("bridge_pairing_revoked");
        }
    }
    if let Err(error) = write_secret_config(&path, &value) {
        return ProtocolResult::failure(
            Outcome::Unavailable,
            "pairing_storage_failed",
            error.to_string(),
            None,
        );
    }
    if action == "revoke" {
        pairing_result(config, None, false, true)
    } else {
        pairing_result(
            config,
            value
                .get("bridge_handshake_secret")
                .and_then(Value::as_str)
                .map(str::to_string),
            reveal,
            action == "rotate",
        )
    }
}

fn pairing_result(
    config: &Config,
    secret: Option<String>,
    reveal: bool,
    changed: bool,
) -> ProtocolResult {
    let configured_bind = config.bind.as_deref().unwrap_or("127.0.0.1:17345");
    let client_bind = configured_bind
        .parse::<std::net::SocketAddr>()
        .map(|address| {
            if address.ip().is_unspecified() {
                std::net::SocketAddr::new(
                    std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
                    address.port(),
                )
            } else {
                address
            }
        })
        .map(|address| address.to_string())
        .unwrap_or_else(|_| configured_bind.to_string());
    let bridge_address = format!("ws://{client_bind}/extension");
    ProtocolResult::success(
        json!({"bridge_address":bridge_address,"pairing_identity":"default","secret_path":config.install_config_path,"paired":secret.is_some(),"changed":changed,"secret":if reveal { secret } else { None }}),
        None,
    )
}

async fn ensure(config: &Config) -> Result<Client, ProtocolResult> {
    let resident_config = config.resident();
    let executable = std::env::current_exe().map_err(|error| {
        ProtocolResult::failure(
            Outcome::Unavailable,
            "executable_unavailable",
            error.to_string(),
            None,
        )
    })?;
    let resident_launch = config.clone();
    resident::ensure_resident(&resident_config, move || {
        launch_resident(executable, resident_launch)
    })
    .await
    .map_err(|error| {
        ProtocolResult::failure(
            Outcome::Unavailable,
            "resident_unavailable",
            error.to_string(),
            None,
        )
    })?;
    let client = Client::new(resident_config.endpoint(), config.timeout);
    let status = client
        .handshake(&config.executable_version)
        .await
        .map_err(|error| {
            ProtocolResult::failure(
                Outcome::Unavailable,
                "resident_version_mismatch",
                error.to_string(),
                None,
            )
        })?;
    if status.executable_version != config.executable_version {
        return Err(ProtocolResult::failure(
            Outcome::Unavailable,
            "resident_version_mismatch",
            "installed and resident versions differ",
            None,
        ));
    }
    Ok(client)
}

fn launch_resident(executable: PathBuf, config: Config) -> anyhow::Result<()> {
    let configuration_id = config.configuration_id.clone();
    launch_managed_resident(resident_command(executable, config), &configuration_id).map(|_| ())
}

#[cfg(target_os = "linux")]
fn systemd_resident_command(
    direct_command: &Command,
    configuration_id: &str,
) -> anyhow::Result<SystemdLaunch> {
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(format!("/run/user/{}", unsafe { libc::geteuid() })));
    systemd_resident_command_at_runtime(direct_command, configuration_id, runtime_dir)
}

#[cfg(target_os = "linux")]
fn systemd_resident_command_at_runtime(
    direct_command: &Command,
    configuration_id: &str,
    runtime_dir: PathBuf,
) -> anyhow::Result<SystemdLaunch> {
    let bus = runtime_dir.join("bus");
    if !bus.exists() {
        anyhow::bail!(
            "resident_supervisor_unavailable: systemd user bus is absent at {}",
            bus.display()
        );
    }
    let configuration_suffix = configuration_id
        .trim_start_matches("sha256:")
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(12)
        .collect::<String>();
    let unit = format!(
        "actions-json-resident-{}-{}",
        configuration_suffix,
        std::process::id()
    );
    let working_directory = direct_command
        .get_current_dir()
        .map(Path::to_path_buf)
        .map(Ok)
        .unwrap_or_else(std::env::current_dir)?;
    let environment_file = write_resident_environment_file(&runtime_dir, &unit)?;
    let mut command = Command::new("systemd-run");
    command
        .arg("--user")
        .arg("--quiet")
        .arg("--collect")
        .arg("--property=Type=exec")
        .arg(format!("--unit={unit}"))
        .env("XDG_RUNTIME_DIR", &runtime_dir)
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={}", bus.display()),
        );
    if let Some(home) = std::env::var_os("HOME") {
        command.arg(format!("--setenv=HOME={}", PathBuf::from(home).display()));
    }
    command.arg(format!(
        "--working-directory={}",
        working_directory.display()
    ));
    if let Some(path) = environment_file.as_ref() {
        command.arg(format!("--property=EnvironmentFile={}", path.display()));
    }
    command.arg(direct_command.get_program());
    command.args(direct_command.get_args());
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    Ok(SystemdLaunch {
        command,
        unit,
        runtime_dir,
        environment_file,
    })
}

#[cfg(target_os = "linux")]
struct SystemdLaunch {
    command: Command,
    unit: String,
    runtime_dir: PathBuf,
    environment_file: Option<PathBuf>,
}

pub(crate) enum ManagedResident {
    Direct(Child),
    #[cfg(target_os = "linux")]
    Systemd {
        unit: String,
        runtime_dir: PathBuf,
    },
}

impl ManagedResident {
    fn stop_and_wait(&mut self) -> anyhow::Result<()> {
        match self {
            Self::Direct(child) => {
                child.kill()?;
                child.wait()?;
                Ok(())
            }
            #[cfg(target_os = "linux")]
            Self::Systemd { unit, runtime_dir } => {
                let mut command = systemctl_user_command(runtime_dir);
                command.arg("stop").arg(unit.as_str());
                let status = run_command_bounded(&mut command, Duration::from_secs(5))?;
                if !status.success() {
                    anyhow::bail!(
                        "resident_supervisor_stop_failed: systemctl exited with {status}"
                    );
                }
                Ok(())
            }
        }
    }
}

pub(crate) fn launch_managed_resident(
    mut direct_command: Command,
    configuration_id: &str,
) -> anyhow::Result<ManagedResident> {
    #[cfg(target_os = "linux")]
    if std::env::var_os("ACTIONS_JSON_RESIDENT_SUPERVISOR").as_deref()
        != Some(std::ffi::OsStr::new("direct"))
    {
        let mut launch = systemd_resident_command(&direct_command, configuration_id)?;
        let status = run_command_bounded(&mut launch.command, Duration::from_secs(10));
        if let Some(path) = launch.environment_file.take() {
            let _ = fs::remove_file(path);
        }
        let status = status.map_err(|error| {
            let mut stop = systemctl_user_command(&launch.runtime_dir);
            stop.arg("stop").arg(&launch.unit);
            let _ = run_command_bounded(&mut stop, Duration::from_secs(5));
            anyhow::anyhow!("start resident user service: {error}")
        })?;
        if !status.success() {
            let mut stop = systemctl_user_command(&launch.runtime_dir);
            stop.arg("stop").arg(&launch.unit);
            let _ = run_command_bounded(&mut stop, Duration::from_secs(5));
            anyhow::bail!("resident_supervisor_failed: systemd user service exited with {status}");
        }
        return Ok(ManagedResident::Systemd {
            unit: launch.unit,
            runtime_dir: launch.runtime_dir,
        });
    }

    direct_command
        .spawn()
        .map(ManagedResident::Direct)
        .map_err(Into::into)
}

fn run_command_bounded(command: &mut Command, timeout: Duration) -> anyhow::Result<ExitStatus> {
    let mut child = command.spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("resident_supervisor_timeout: command did not finish within {timeout:?}");
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[cfg(target_os = "linux")]
fn systemctl_user_command(runtime_dir: &Path) -> Command {
    let mut command = Command::new("systemctl");
    command
        .arg("--user")
        .env("XDG_RUNTIME_DIR", runtime_dir)
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={}", runtime_dir.join("bus").display()),
        );
    command
}

#[cfg(target_os = "linux")]
fn write_resident_environment_file(
    runtime_dir: &Path,
    unit: &str,
) -> anyhow::Result<Option<PathBuf>> {
    const FORWARDED: &[&str] = &[
        "ACTIONS_JSON_OPENAI_API_KEY",
        "ACTIONS_JSON_PROTOFACE_API_KEY",
        "ACTIONS_JSON_LIVEKIT_URL",
        "ACTIONS_JSON_LIVEKIT_API_KEY",
        "ACTIONS_JSON_LIVEKIT_API_SECRET",
        "ACTIONS_JSON_DURABLE_STATE_PATH",
    ];
    let values = FORWARDED
        .iter()
        .filter_map(|name| std::env::var(name).ok().map(|value| (*name, value)))
        .collect::<Vec<_>>();
    if values.is_empty() {
        return Ok(None);
    }
    write_resident_environment_values(runtime_dir, unit, &values).map(Some)
}

#[cfg(target_os = "linux")]
fn write_resident_environment_values(
    runtime_dir: &Path,
    unit: &str,
    values: &[(&str, String)],
) -> anyhow::Result<PathBuf> {
    let path = runtime_dir.join(format!("{unit}.environment"));
    let mut contents = String::new();
    for (name, value) in values {
        if value.contains(['\n', '\r']) {
            anyhow::bail!("resident_environment_invalid: {name} contains a newline");
        }
        let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
        contents.push_str(&format!("{name}=\"{escaped}\"\n"));
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)?;
        file.write_all(contents.as_bytes())?;
    }
    Ok(path)
}

fn resident_command(executable: PathBuf, config: Config) -> Command {
    let mut command = Command::new(executable);
    append_resident_args(&mut command, &config);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Direct mode is reserved for platforms without the Linux user-service
        // path and for explicitly isolated tests. Detach from terminal signals,
        // but do not mistake this for durable supervisor ownership.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    command
}

fn append_resident_args(command: &mut Command, config: &Config) {
    let actions = config
        .actions
        .clone()
        .unwrap_or_else(|| embedded_actions_path(&config.state_dir));
    command
        .arg("resident")
        .arg("--state-dir")
        .arg(&config.state_dir)
        .arg("--executable-version")
        .arg(&config.executable_version)
        .arg("--configuration-id")
        .arg(&config.configuration_id)
        .arg("--actions")
        .arg(actions);
    if let Some(bind) = &config.bind {
        command.arg("--bind").arg(bind);
    }
    if let Some(storage) = &config.storage_root {
        command.arg("--storage-root").arg(storage);
    }
}

fn embedded_actions_path(state_dir: &Path) -> PathBuf {
    const DEFAULT_ACTIONS: &[u8] = include_bytes!(
        "../../../../extensions/chrome-overlay-runtime/actions/overlay.actions.json"
    );
    let path = state_dir.join("bundled-overlay.actions.json");
    if fs::read(&path).ok().as_deref() != Some(DEFAULT_ACTIONS) {
        let _ = fs::create_dir_all(state_dir);
        let staging = state_dir.join("bundled-overlay.actions.json.new");
        if fs::write(&staging, DEFAULT_ACTIONS).is_ok() {
            let _ = fs::rename(staging, &path);
        }
    }
    path
}

fn wire_envelope(envelope: Envelope) -> Value {
    let mut value = json!({"name":envelope.operation,"arguments":envelope.arguments,"timeout_ms":envelope.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS)});
    let object = value.as_object_mut().unwrap();
    if let Some(id) = envelope.request_id {
        object.insert("request_id".into(), json!(id));
    }
    if let Some(profile) = envelope.profile {
        object.insert("profile".into(), json!(profile.name));
        object.insert("profile_token".into(), json!(profile.token));
    }
    if let Some(target) = envelope.target {
        if let Some(id) = target.target_id {
            object.insert("target_id".into(), json!(id));
        }
        if let Some(id) = target.runtime_id {
            object.insert("target_runtime_id".into(), json!(id));
        }
        if let Some(text) = target.url_contains {
            object.insert("target_url_contains".into(), json!(text));
        }
        if let Some(generation) = target.target_generation {
            object.insert("target_generation".into(), json!(generation));
        }
    }
    if let Some(revision) = envelope.expected_catalog_revision {
        object.insert("catalog_revision".into(), json!(revision));
    }
    if let Some(output) = envelope.output {
        object.insert("output_policy".into(),json!({"mode":output.mode,"path":output.path,"max_inline_bytes":output.max_inline_bytes.unwrap_or(DEFAULT_INLINE_LIMIT)}));
    }
    if let Some(token) = envelope.lease_token {
        object.insert("lease_token".into(), json!(token));
    }
    value
}

fn parse_envelope(text: &str) -> Result<Envelope, ProtocolResult> {
    serde_json::from_str(text).map_err(|error| invalid("invalid_envelope", error.to_string()))
}
fn control(operation: &str, arguments: Value) -> Result<Envelope, ProtocolResult> {
    Ok(Envelope {
        protocol_version: 1,
        operation: operation.into(),
        arguments,
        request_id: None,
        profile: None,
        target: None,
        expected_catalog_revision: None,
        output: None,
        timeout_ms: None,
        lease_token: None,
    })
}
fn read_stdin() -> Result<String, ProtocolResult> {
    let mut bytes = Vec::new();
    stdio::stdin()
        .lock()
        .take((MAX_CLI_RECORD_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| invalid("stdin_read_failed", error.to_string()))?;
    if bytes.len() > MAX_CLI_RECORD_BYTES {
        return Err(invalid(
            "payload_too_large",
            format!("input exceeds {MAX_CLI_RECORD_BYTES} bytes"),
        ));
    }
    let text =
        String::from_utf8(bytes).map_err(|error| invalid("invalid_envelope", error.to_string()))?;
    if text.trim().is_empty() {
        Err(invalid("empty_input", "expected JSON on stdin"))
    } else {
        Ok(text)
    }
}

enum StreamRecord {
    Eof,
    Data(Vec<u8>),
    TooLarge,
}

fn read_bounded_stream_record<R: BufRead>(
    reader: &mut R,
    max_bytes: usize,
) -> stdio::Result<StreamRecord> {
    let mut record = Vec::new();
    let mut too_large = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if record.is_empty() && !too_large {
                Ok(StreamRecord::Eof)
            } else if too_large {
                Ok(StreamRecord::TooLarge)
            } else {
                Ok(StreamRecord::Data(record))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.unwrap_or(available.len());
        if !too_large {
            let remaining = max_bytes.saturating_sub(record.len());
            if take > remaining {
                record.extend_from_slice(&available[..remaining]);
                too_large = true;
            } else {
                record.extend_from_slice(&available[..take]);
            }
        }
        reader.consume(take + usize::from(newline.is_some()));
        if newline.is_some() {
            if record.last() == Some(&b'\r') {
                record.pop();
            }
            return if too_large {
                Ok(StreamRecord::TooLarge)
            } else {
                Ok(StreamRecord::Data(record))
            };
        }
    }
}
fn utf8_arguments(arguments: Vec<OsString>) -> Result<Vec<String>, ProtocolResult> {
    arguments
        .into_iter()
        .map(|value| {
            value
                .into_string()
                .map_err(|_| invalid("invalid_argument_encoding", "arguments must be UTF-8"))
        })
        .collect()
}
fn no_extra(args: &[String], command: LocalCommand) -> Result<CommandSpec, ProtocolResult> {
    if args.len() == 1 {
        Ok(CommandSpec::Local(command))
    } else {
        Err(invalid(
            "unexpected_argument",
            "command accepts no arguments",
        ))
    }
}
fn flags(args: &[String]) -> Result<Map<String, Value>, ProtocolResult> {
    let mut out = Map::new();
    let mut i = 0;
    while i < args.len() {
        let key = args[i]
            .strip_prefix("--")
            .ok_or_else(|| invalid("invalid_flag", format!("expected flag, got {}", args[i])))?;
        let value = args
            .get(i + 1)
            .ok_or_else(|| invalid("missing_flag_value", format!("--{key} requires a value")))?;
        if out.insert(key.into(), json!(value)).is_some() {
            return Err(invalid("duplicate_flag", format!("--{key} repeated")));
        }
        i += 2;
    }
    Ok(out)
}
fn take(values: &mut Map<String, Value>, key: &str) -> Result<String, ProtocolResult> {
    values
        .remove(key)
        .and_then(|v| v.as_str().map(str::to_string))
        .ok_or_else(|| invalid("missing_flag", format!("--{key} is required")))
}
fn reject_remaining(values: Map<String, Value>) -> Result<(), ProtocolResult> {
    if let Some(key) = values.keys().next() {
        Err(invalid("unknown_flag", format!("unknown --{key}")))
    } else {
        Ok(())
    }
}
fn selector_arguments(mut values: Map<String, Value>) -> Result<Value, ProtocolResult> {
    let mut body = Map::new();
    for (key, wire) in [
        ("target-id", "target_id"),
        ("runtime-id", "runtime_id"),
        ("url-contains", "intent"),
    ] {
        if let Some(value) = values.remove(key) {
            body.insert(wire.into(), value);
        }
    }
    reject_remaining(values)?;
    Ok(Value::Object(body))
}
fn string_value(value: Option<Value>) -> Option<String> {
    value.and_then(|value| value.as_str().map(str::to_string))
}
fn parse_u64(value: Option<Value>, name: &str) -> Result<Option<u64>, ProtocolResult> {
    value
        .map(|value| {
            value
                .as_str()
                .and_then(|value| value.parse().ok())
                .ok_or_else(|| {
                    invalid(
                        "invalid_number",
                        format!("--{name} must be an unsigned integer"),
                    )
                })
        })
        .transpose()
}
fn invalid(code: &str, message: impl Into<String>) -> ProtocolResult {
    ProtocolResult::failure(Outcome::InvalidInput, code, message, None)
}
fn classify_code(code: &str, raw: &Value) -> Outcome {
    if raw.get("failure_class").and_then(Value::as_str) == Some("mutation_outcome_indeterminate")
        || raw.pointer("/error/failure_class").and_then(Value::as_str)
            == Some("mutation_outcome_indeterminate")
        || raw.get("outcome").and_then(Value::as_str) == Some("indeterminate")
    {
        return Outcome::Indeterminate;
    }
    match code {
        "invalid_argument_encoding"
        | "invalid_arguments"
        | "invalid_catalog"
        | "invalid_duration"
        | "invalid_envelope"
        | "invalid_flag"
        | "invalid_inline_limit"
        | "invalid_input"
        | "invalid_json"
        | "invalid_lease_action"
        | "invalid_lease_duration"
        | "invalid_number"
        | "invalid_operation_action"
        | "invalid_output_mode"
        | "invalid_pair_action"
        | "invalid_profile"
        | "invalid_profile_action"
        | "invalid_profile_name"
        | "invalid_request"
        | "invalid_target"
        | "invalid_target_action"
        | "invalid_update_action"
        | "missing_flag"
        | "missing_flag_value"
        | "missing_lease_action"
        | "missing_operation"
        | "missing_profile_action"
        | "missing_required"
        | "missing_target_action"
        | "output_mode_required"
        | "output_path_required"
        | "transfer_ack_invalid"
        | "transfer_chunk_invalid"
        | "transfer_download_url_invalid"
        | "transfer_file_input_missing"
        | "transfer_filename_invalid"
        | "transfer_id_invalid"
        | "transfer_metadata_invalid"
        | "transfer_origin_invalid"
        | "transfer_path_missing"
        | "unknown_action"
        | "unknown_control_operation"
        | "unknown_flag" => Outcome::InvalidInput,

        "executable_unavailable"
        | "lease_not_found"
        | "operation_not_found"
        | "pairing_storage_failed"
        | "profile_not_found"
        | "resident_authority_unavailable"
        | "resident_unavailable"
        | "runtime_id_not_found"
        | "runtime_not_found"
        | "runtime_url_missing"
        | "state_directory_unavailable"
        | "state_projection_not_found"
        | "storage_file_not_found"
        | "target_not_found"
        | "transfer_output_unavailable"
        | "update_candidate_not_ready"
        | "update_commit_failed"
        | "update_fence_failed"
        | "update_migration_failed"
        | "update_shutdown_failed"
        | "update_store_prepare_failed"
        | "verified_update_absent" => Outcome::Unavailable,

        "active_runtime_stale_id"
        | "bridge_secret_mismatch"
        | "bridge_secret_missing"
        | "browser_http_ingress_refused"
        | "explicit_target_required"
        | "handshake_secret_mismatch"
        | "handshake_secret_missing"
        | "lease_expired"
        | "lease_token_mismatch"
        | "lease_token_required"
        | "mutation_queue_wait_timeout"
        | "owner_runtime_required"
        | "permission_denied"
        | "policy_exception_report_required"
        | "profile_token_mismatch"
        | "protocol_mismatch"
        | "request_identity_conflict"
        | "snapshot_required"
        | "stale_catalog"
        | "stale_mutation_authority"
        | "stale_target"
        | "tab_locked"
        | "transfer_hash_mismatch"
        | "transfer_integrity_mismatch"
        | "transfer_local_replay_conflict"
        | "transfer_origin_mismatch"
        | "version_mismatch"
        | "version_pin_mismatch" => Outcome::Refused,

        "durable_dispatch_transition_indeterminate" | "mutation_outcome_indeterminate" => {
            Outcome::Indeterminate
        }

        "dispatch_timeout" | "resident_transport_failure" | "transport_failure" => {
            if raw.get("status").and_then(Value::as_str) == Some("accepted") {
                Outcome::Indeterminate
            } else {
                Outcome::TransportFailure
            }
        }

        // Unknown server codes are real operation failures. Classifying by a
        // suggestive substring can turn a future code into an unsafe retry.
        _ => Outcome::Failed,
    }
}
fn string_at(value: &Value, paths: &[&str]) -> Option<String> {
    paths.iter().find_map(|path| {
        if path.starts_with('/') {
            value.pointer(path)
        } else {
            value.get(*path)
        }
        .and_then(|v| {
            if let Some(s) = v.as_str() {
                Some(s.to_string())
            } else {
                None
            }
        })
    })
}
fn integer_at(value: &Value, paths: &[&str]) -> Option<i64> {
    paths.iter().find_map(|path| {
        if path.starts_with('/') {
            value.pointer(path)
        } else {
            value.get(*path)
        }
        .and_then(Value::as_i64)
    })
}
fn default_state_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|p| p.join("actions-json"))
    } else {
        std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .map(|p| p.join("actions-json"))
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(PathBuf::from)
                    .map(|p| p.join(".local/state/actions-json"))
            })
    }
}
fn install_config_path() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .map(|path| path.join(".actions-json/config.json"))
            .or_else(|| {
                std::env::var_os("LOCALAPPDATA")
                    .map(PathBuf::from)
                    .map(|path| path.join("ActionsJson/config.json"))
            })
    } else {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join(".actions-json/config.json"))
    }
}
fn load_install_config() -> Result<Option<InstallConfig>, ProtocolResult> {
    let Some(path) = install_config_path() else {
        return Ok(None);
    };
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(ProtocolResult::failure(
                Outcome::Unavailable,
                "install_config_unreadable",
                format!("{}: {error}", path.display()),
                None,
            ))
        }
    };
    let value: InstallConfig = serde_json::from_str(&text).map_err(|error| {
        ProtocolResult::failure(
            Outcome::InvalidInput,
            "install_config_invalid",
            format!("{}: {error}", path.display()),
            None,
        )
    })?;
    if value.schema_version != 1 {
        return Err(ProtocolResult::failure(
            Outcome::InvalidInput,
            "install_config_version_unsupported",
            format!("{}: expected schema_version 1", path.display()),
            None,
        ));
    }
    Ok(Some(value))
}
fn pairing_secret(config: &Config) -> Option<String> {
    let path = config
        .install_config_path
        .clone()
        .unwrap_or_else(|| config.state_dir.join(".actions-json.local.json"));
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| {
            value
                .get("bridge_handshake_secret")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}
fn write_secret_config(path: &Path, value: &Value) -> anyhow::Result<()> {
    crate::state::store::refuse_symlink(path)?;
    let temp = path.with_extension(format!("tmp.{}", uuid::Uuid::new_v4().simple()));
    fs::write(&temp, serde_json::to_vec_pretty(value)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(temp, path)?;
    Ok(())
}
fn verify_project_pin(installed: &str) -> Result<(), ProtocolResult> {
    let Some(path) = find_upward(".actions-json-version") else {
        return Ok(());
    };
    let expected = fs::read_to_string(&path)
        .map_err(|error| invalid("version_pin_unreadable", error.to_string()))?;
    if expected.trim() != installed {
        return Err(ProtocolResult::failure(
            Outcome::Unavailable,
            "version_pin_mismatch",
            format!("project expects {}, installed {installed}", expected.trim()),
            None,
        ));
    }
    Ok(())
}
fn find_upward(name: &str) -> Option<PathBuf> {
    let mut current = std::env::current_dir().ok()?;
    loop {
        let candidate = current.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
        if !current.pop() {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_resident_is_transferred_to_user_service_ownership() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("bus"), b"").unwrap();
        let config = Config {
            state_dir: root.path().join("state"),
            executable_version: "0.1.test".into(),
            timeout: Duration::from_millis(50),
            actions: Some(root.path().join("overlay.actions.json")),
            bind: Some("127.0.0.1:17345".into()),
            storage_root: Some(root.path().join("storage")),
            configuration_id: "sha256:abcdef1234567890".into(),
            install_config_path: None,
            install_config_present: true,
            configuration_source: "config_file",
        };
        let direct = resident_command(PathBuf::from("/opt/actions-json"), config.clone());
        let launch = systemd_resident_command_at_runtime(
            &direct,
            &config.configuration_id,
            root.path().to_path_buf(),
        )
        .unwrap();
        let command = launch.command;
        assert_eq!(command.get_program(), "systemd-run");
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args.contains(&"--user".into()));
        assert!(args.contains(&"--collect".into()));
        assert!(args.contains(&"--property=Type=exec".into()));
        assert!(args
            .iter()
            .any(|value| value.starts_with("--working-directory=")));
        assert!(args
            .iter()
            .any(|value| value.starts_with("--unit=actions-json-resident-abcdef123456-")));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--state-dir", config.state_dir.to_str().unwrap()]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--bind", "127.0.0.1:17345"]));
        assert!(!args.iter().any(|value| value.contains("secret")));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn resident_environment_file_is_private_and_escapes_values() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let path = write_resident_environment_values(
            root.path(),
            "actions-json-test",
            &[("ACTIONS_JSON_OPENAI_API_KEY", "quoted\"slash\\value".into())],
        )
        .unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "ACTIONS_JSON_OPENAI_API_KEY=\"quoted\\\"slash\\\\value\"\n"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn resident_environment_file_rejects_multiline_values() {
        let root = tempfile::tempdir().unwrap();
        let error = write_resident_environment_values(
            root.path(),
            "actions-json-test",
            &[("ACTIONS_JSON_OPENAI_API_KEY", "first\nsecond".into())],
        )
        .unwrap_err();
        assert!(error.to_string().contains("resident_environment_invalid"));
        assert!(!root.path().join("actions-json-test.environment").exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn supervisor_command_timeout_is_bounded() {
        let started = Instant::now();
        let mut command = Command::new("sleep");
        command.arg("2");
        let error = run_command_bounded(&mut command, Duration::from_millis(25)).unwrap_err();
        assert!(error.to_string().contains("resident_supervisor_timeout"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn unknown_protocol_fields_fail_closed() {
        assert!(parse_envelope(
            r#"{"protocol_version":1,"operation":"x","arguments":{},"surprise":1}"#
        )
        .is_err());
    }
    #[test]
    fn exits_are_stable() {
        assert_eq!(
            [
                Outcome::Success,
                Outcome::InvalidInput,
                Outcome::Unavailable,
                Outcome::Refused,
                Outcome::Failed,
                Outcome::Indeterminate,
                Outcome::TransportFailure
            ]
            .map(Outcome::exit_code),
            [0, 2, 3, 4, 5, 6, 7]
        );
    }
    #[test]
    fn stable_error_codes_are_classified_exactly_and_unknown_codes_fail_conservatively() {
        assert_eq!(
            classify_code("invalid_json", &json!({})),
            Outcome::InvalidInput
        );
        assert_eq!(
            classify_code("runtime_not_found", &json!({})),
            Outcome::Unavailable
        );
        assert_eq!(
            classify_code("lease_token_mismatch", &json!({})),
            Outcome::Refused
        );
        assert_eq!(
            classify_code("mutation_outcome_indeterminate", &json!({})),
            Outcome::Indeterminate
        );
        assert_eq!(
            classify_code(
                "resident_transport_failure",
                &json!({"status":"not_accepted"})
            ),
            Outcome::TransportFailure
        );
        assert_eq!(
            classify_code("resident_transport_failure", &json!({"status":"accepted"})),
            Outcome::Indeterminate
        );
        assert_eq!(
            classify_code("invalidated_remote_state", &json!({})),
            Outcome::Failed,
            "suggestive substrings must not create an unsafe classification"
        );
        assert_eq!(
            classify_code("future_transportish_code", &json!({})),
            Outcome::Failed
        );
    }
    #[test]
    fn bare_envelope_requires_object_arguments() {
        let value =
            parse_envelope(r#"{"protocol_version":1,"operation":"x","arguments":[]}"#).unwrap();
        assert!(!value.arguments.is_object());
    }
    #[test]
    fn version_is_a_local_command_for_installers() {
        assert!(matches!(
            parse_command(&["version".into()]),
            Ok(CommandSpec::Local(LocalCommand::Version))
        ));
        assert!(matches!(
            parse_command(&["--version".into()]),
            Ok(CommandSpec::Local(LocalCommand::Version))
        ));
    }
    #[tokio::test]
    async fn update_check_reports_only_a_staged_candidate() {
        let root = tempfile::tempdir().unwrap();
        let config = Config {
            state_dir: root.path().to_path_buf(),
            executable_version: "1.0.0".into(),
            timeout: Duration::from_millis(50),
            actions: None,
            bind: None,
            storage_root: None,
            configuration_id: resident::configuration_id(None, None, &[], None),
            install_config_path: None,
            install_config_present: false,
            configuration_source: "default",
        };
        let absent = serde_json::to_value(update_command(&config, "check").await).unwrap();
        assert_eq!(
            absent.pointer("/result/candidate_ready"),
            Some(&json!(false))
        );
        fs::create_dir_all(root.path().join("updates")).unwrap();
        fs::write(
            root.path().join("updates/actions-json"),
            b"verified candidate",
        )
        .unwrap();
        fs::write(root.path().join("updates/candidate.version"), "2.0.0\n").unwrap();
        let staged = serde_json::to_value(update_command(&config, "check").await).unwrap();
        assert_eq!(
            staged.pointer("/result/candidate_ready"),
            Some(&json!(true))
        );
        assert_eq!(
            staged.pointer("/result/candidate_version"),
            Some(&json!("2.0.0"))
        );
    }
    #[test]
    fn pairing_result_redacts_secret_by_default() {
        let config = Config {
            state_dir: "/tmp/example".into(),
            executable_version: "1".into(),
            timeout: Duration::from_secs(1),
            actions: None,
            bind: None,
            storage_root: None,
            configuration_id: resident::configuration_id(None, None, &[], None),
            install_config_path: None,
            install_config_present: false,
            configuration_source: "default",
        };
        let value = serde_json::to_value(pairing_result(
            &config,
            Some("super-private".into()),
            false,
            false,
        ))
        .unwrap();
        assert!(value.pointer("/result/secret").unwrap().is_null());
        assert!(!value.to_string().contains("super-private"));
    }

    #[test]
    fn pairing_result_reports_the_configured_bridge_address() {
        let config = Config {
            state_dir: "/tmp/example".into(),
            executable_version: "1".into(),
            timeout: Duration::from_secs(1),
            actions: None,
            bind: Some("127.0.0.1:18456".into()),
            storage_root: None,
            configuration_id: resident::configuration_id(None, Some("127.0.0.1:18456"), &[], None),
            install_config_path: None,
            install_config_present: true,
            configuration_source: "config_file",
        };
        let value = serde_json::to_value(pairing_result(&config, None, false, false)).unwrap();
        assert_eq!(
            value.pointer("/result/bridge_address"),
            Some(&json!("ws://127.0.0.1:18456/extension"))
        );
    }

    #[test]
    fn pairing_result_reports_loopback_client_address_for_wsl_listener() {
        let config = Config {
            state_dir: "/tmp/example".into(),
            executable_version: "1".into(),
            timeout: Duration::from_secs(1),
            actions: None,
            bind: Some("0.0.0.0:17345".into()),
            storage_root: None,
            configuration_id: resident::configuration_id(None, Some("0.0.0.0:17345"), &[], None),
            install_config_path: None,
            install_config_present: true,
            configuration_source: "config_file",
        };
        let value = serde_json::to_value(pairing_result(&config, None, false, false)).unwrap();
        assert_eq!(
            value.pointer("/result/bridge_address"),
            Some(&json!("ws://127.0.0.1:17345/extension"))
        );
    }

    #[tokio::test]
    async fn pairing_lifecycle_and_resident_auth_share_one_config() {
        let root = tempfile::tempdir().unwrap();
        let config = Config {
            state_dir: root.path().to_path_buf(),
            executable_version: env!("CARGO_PKG_VERSION").into(),
            timeout: Duration::from_millis(50),
            actions: None,
            bind: None,
            storage_root: None,
            configuration_id: resident::configuration_id(None, None, &[], None),
            install_config_path: Some(root.path().join(".actions-json/config.json")),
            install_config_present: true,
            configuration_source: "config_file",
        };
        assert!(pair_command(&config, "create", false).await.ok);
        let first = pairing_secret(&config).unwrap();
        assert_eq!(
            crate::ExtensionAuthConfig::load(Some(&root.path().join(".actions-json")))
                .handshake_secret(),
            first
        );
        assert!(pair_command(&config, "create", false).await.ok);
        assert_eq!(
            pairing_secret(&config).as_deref(),
            Some(first.as_str()),
            "create must not overwrite"
        );
        assert!(pair_command(&config, "rotate", false).await.ok);
        let second = pairing_secret(&config).unwrap();
        assert_ne!(first, second);
        assert_eq!(
            crate::ExtensionAuthConfig::load(Some(&root.path().join(".actions-json")))
                .handshake_secret(),
            second
        );
        assert!(pair_command(&config, "revoke", false).await.ok);
        assert!(pairing_secret(&config).is_none());
        let config_path = config.install_config_path.as_ref().unwrap();
        let before = fs::read(config_path).unwrap();
        let ephemeral = crate::ExtensionAuthConfig::load(Some(&root.path().join(".actions-json")))
            .handshake_secret()
            .to_string();
        assert_ne!(ephemeral, second);
        assert_eq!(
            fs::read(config_path).unwrap(),
            before,
            "revoked status must not silently regenerate persisted pairing"
        );
    }
}
