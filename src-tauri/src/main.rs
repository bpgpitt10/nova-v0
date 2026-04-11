#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::Value;
use flume::RecvTimeoutError;
use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

const HELPER_HOST: &str = "127.0.0.1";
const HELPER_PORT: u16 = 8787;
const HELPER_SERVICE_NAME: &str = "open-golf-coach-helper";
const HELPER_HEALTH_URL: &str = "http://127.0.0.1:8787/health";
const SIDECAR_BASE_NAME: &str = "open-golf-coach-helper";
const NOVA_WS_SERVICE_NAME: &str = "_openlaunch-ws._tcp.local.";

#[derive(Default)]
struct SidecarState {
    child: Mutex<Option<Child>>,
}

enum HelperProbe {
    CompatibleRunning,
    PortFree,
    IncompatibleService(String),
}

fn is_port_open(addr: &str) -> bool {
    let parsed_addr: SocketAddr = match addr.parse() {
        Ok(value) => value,
        Err(_) => return false,
    };

    TcpStream::connect_timeout(&parsed_addr, Duration::from_millis(400)).is_ok()
}

fn probe_helper() -> HelperProbe {
    let port_addr = format!("{HELPER_HOST}:{HELPER_PORT}");
    if !is_port_open(&port_addr) {
        return HelperProbe::PortFree;
    }

    let client = match Client::builder()
        .timeout(Duration::from_millis(1200))
        .build()
    {
        Ok(value) => value,
        Err(error) => {
            return HelperProbe::IncompatibleService(format!(
                "port is occupied and health check client failed: {error}"
            ))
        }
    };

    let response = match client.get(HELPER_HEALTH_URL).send() {
        Ok(value) => value,
        Err(error) => {
            return HelperProbe::IncompatibleService(format!(
                "port is occupied but health check failed: {error}"
            ))
        }
    };

    if !response.status().is_success() {
        return HelperProbe::IncompatibleService(format!(
            "port is occupied and /health returned status {}",
            response.status()
        ));
    }

    let payload: Value = match response.json() {
        Ok(value) => value,
        Err(error) => {
            return HelperProbe::IncompatibleService(format!(
                "port is occupied and /health payload is invalid JSON: {error}"
            ))
        }
    };

    let service_name = payload.get("service").and_then(Value::as_str);
    let status = payload.get("status").and_then(Value::as_str);

    if service_name == Some(HELPER_SERVICE_NAME) && status == Some("ok") {
        HelperProbe::CompatibleRunning
    } else {
        HelperProbe::IncompatibleService(format!(
            "port is occupied by incompatible service: {:?}",
            payload
        ))
    }
}

fn sidecar_executable_filename() -> String {
    let target_triple = option_env!("TAURI_ENV_TARGET_TRIPLE").unwrap_or("unknown-target");
    if cfg!(target_os = "windows") {
        format!("{SIDECAR_BASE_NAME}-{target_triple}.exe")
    } else {
        format!("{SIDECAR_BASE_NAME}-{target_triple}")
    }
}

fn resolve_sidecar_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let sidecar_filename = sidecar_executable_filename();
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource_path) = app_handle.path().resolve(
        format!("binaries/{sidecar_filename}"),
        BaseDirectory::Resource,
    ) {
        candidates.push(resource_path);
    }

    if let Ok(resource_path_flat) = app_handle
        .path()
        .resolve(&sidecar_filename, BaseDirectory::Resource)
    {
        candidates.push(resource_path_flat);
    }

    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(&sidecar_filename),
    );

    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(format!(
        "bundled OpenGolfCoach sidecar not found; expected file name {sidecar_filename}"
    ))
}

fn launch_sidecar(app_handle: &AppHandle) -> Result<Child, String> {
    let sidecar_path = resolve_sidecar_path(app_handle)?;

    println!(
        "[OpenGolfCoach sidecar] launching bundled helper: {}",
        sidecar_path.display()
    );

    Command::new(sidecar_path)
        .env("OPEN_GOLF_COACH_HOST", HELPER_HOST)
        .env("OPEN_GOLF_COACH_PORT", HELPER_PORT.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("failed to launch bundled helper sidecar: {error}"))
}

fn ensure_open_golf_coach_helper(app_handle: &AppHandle, sidecar_state: &SidecarState) {
    match probe_helper() {
        HelperProbe::CompatibleRunning => {
            println!(
        "[OpenGolfCoach sidecar] compatible helper already running at {HELPER_HEALTH_URL}; reusing existing process"
      );
        }
        HelperProbe::IncompatibleService(reason) => {
            eprintln!(
        "[OpenGolfCoach sidecar] cannot start bundled helper because 127.0.0.1:{HELPER_PORT} is occupied: {reason}"
      );
            eprintln!(
        "[OpenGolfCoach sidecar] leaving existing service untouched; enrichment will fail until port is freed or a compatible helper is running"
      );
        }
        HelperProbe::PortFree => {
            let mut guard = match sidecar_state.child.lock() {
                Ok(lock) => lock,
                Err(error) => {
                    eprintln!("[OpenGolfCoach sidecar] failed to acquire sidecar mutex: {error}");
                    return;
                }
            };

            if guard.is_some() {
                println!(
                    "[OpenGolfCoach sidecar] bundled helper already started in this app process"
                );
                return;
            }

            match launch_sidecar(app_handle) {
                Ok(child) => {
                    *guard = Some(child);
                    println!(
            "[OpenGolfCoach sidecar] bundled helper started on http://{HELPER_HOST}:{HELPER_PORT}"
          );
                }
                Err(error) => {
                    eprintln!("[OpenGolfCoach sidecar] {error}");
                }
            }
        }
    }
}

#[derive(Serialize, Clone)]
struct NovaDiscoveredEndpoint {
    service: String,
    host: String,
    port: u16,
    ws_url: String,
}

fn append_log_line(app: &tauri::AppHandle, file_name: &str, line: &str) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data dir: {error}"))?;
    let logs_dir = app_data_dir.join("logs");
    create_dir_all(&logs_dir).map_err(|error| format!("failed to create logs dir: {error}"))?;

    let log_file = logs_dir.join(file_name);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
        .map_err(|error| format!("failed to open log file {}: {error}", log_file.display()))?;

    writeln!(file, "{line}")
        .map_err(|error| format!("failed to write log line to {}: {error}", log_file.display()))?;
    Ok(())
}

#[tauri::command]
fn append_nova_log(app: tauri::AppHandle, line: String) -> Result<(), String> {
    append_log_line(&app, "nova-connection.log", &line)
}

#[tauri::command]
fn discover_nova_ws_endpoint(
    app: tauri::AppHandle,
    timeout_ms: Option<u64>,
) -> Result<Option<NovaDiscoveredEndpoint>, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(5000).clamp(5000, 10000));
    append_log_line(
        &app,
        "nova-connection.log",
        &format!(
            "[discovery] starting mDNS browse service={} timeout_ms={}",
            NOVA_WS_SERVICE_NAME,
            timeout.as_millis()
        ),
    )?;

    let mdns = ServiceDaemon::new().map_err(|error| format!("mdns start failed: {error}"))?;
    let receiver = mdns
        .browse(NOVA_WS_SERVICE_NAME)
        .map_err(|error| format!("mdns browse failed: {error}"))?;
    let deadline = Instant::now() + timeout;
    let mut discovered: Option<NovaDiscoveredEndpoint> = None;

    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(ServiceEvent::ServiceFound(service_type, fullname)) => {
                append_log_line(
                    &app,
                    "nova-connection.log",
                    &format!(
                        "[discovery] service_found type={} fullname={}",
                        service_type, fullname
                    ),
                )?;
                append_log_line(
                    &app,
                    "nova-connection.log",
                    &format!(
                        "[discovery] resolve_attempt fullname={} via_browse_auto_resolve=true",
                        fullname
                    ),
                )?;
                match mdns.verify(fullname.clone(), Duration::from_millis(1500)) {
                    Ok(_) => append_log_line(
                        &app,
                        "nova-connection.log",
                        &format!("[discovery] resolve_triggered fullname={}", fullname),
                    )?,
                    Err(error) => append_log_line(
                        &app,
                        "nova-connection.log",
                        &format!(
                            "[discovery] resolve_trigger_failed fullname={} error={}",
                            fullname, error
                        ),
                    )?,
                }
            }
            Ok(ServiceEvent::ServiceResolved(info)) => {
                append_log_line(
                    &app,
                    "nova-connection.log",
                    &format!(
                        "[discovery] service_resolved fullname={} hostname={} port={}",
                        info.get_fullname(),
                        info.get_hostname(),
                        info.get_port()
                    ),
                )?;
                let host = info
                    .get_addresses()
                    .iter()
                    .next()
                    .map(|ip| ip.to_string())
                    .or_else(|| {
                        let hostname = info.get_hostname().trim_end_matches('.');
                        if hostname.is_empty() {
                            None
                        } else {
                            Some(hostname.to_string())
                        }
                    });
                let Some(host) = host else {
                    continue;
                };

                let port = info.get_port();
                let ws_url = format!("ws://{host}:{port}");
                discovered = Some(NovaDiscoveredEndpoint {
                    service: NOVA_WS_SERVICE_NAME.to_string(),
                    host,
                    port,
                    ws_url,
                });
                break;
            }
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(error) => {
                append_log_line(
                    &app,
                    "nova-connection.log",
                    &format!("[discovery] receiver error: {error}"),
                )?;
                break;
            }
        }
    }

    let _ = mdns.shutdown();
    append_log_line(
        &app,
        "nova-connection.log",
        &format!(
            "[discovery] result={}",
            discovered
                .as_ref()
                .map(|value| value.ws_url.clone())
                .unwrap_or_else(|| "none".to_string())
        ),
    )?;
    Ok(discovered)
}

#[tauri::command]
fn append_enrichment_log(app: tauri::AppHandle, line: String) -> Result<(), String> {
    append_log_line(&app, "enrichment-pipeline.log", &line)
}

fn main() {
    let sidecar_state = SidecarState::default();

    tauri::Builder::default()
        .manage(sidecar_state)
        .invoke_handler(tauri::generate_handler![
            append_enrichment_log,
            append_nova_log,
            discover_nova_ws_endpoint
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();
            let sidecar_state = app_handle.state::<SidecarState>();
            ensure_open_golf_coach_helper(&app_handle, sidecar_state.inner());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
