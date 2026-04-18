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
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use mdns_sd::{HostnameResolutionEvent, ServiceDaemon, ServiceEvent};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

const HELPER_HOST: &str = "127.0.0.1";
const HELPER_PORT: u16 = 8787;
const HELPER_SERVICE_NAME: &str = "open-golf-coach-helper";
const HELPER_HEALTH_URL: &str = "http://127.0.0.1:8787/health";
const HELPER_STARTUP_TIMEOUT_MS: u64 = 8000;
const HELPER_HEALTH_POLL_MS: u64 = 250;
const OGC_HELPER_LOG_FILE: &str = "open-golf-coach-helper.log";
const SIDECAR_BASE_NAME: &str = "open-golf-coach-helper";
const NOVA_WS_SERVICE_NAME: &str = "_openlaunch-ws._tcp.local.";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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

fn packaged_sidecar_executable_filename() -> String {
    if cfg!(target_os = "windows") {
        format!("{SIDECAR_BASE_NAME}.exe")
    } else {
        SIDECAR_BASE_NAME.to_string()
    }
}

fn resolve_sidecar_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let sidecar_filename = sidecar_executable_filename();
    let packaged_sidecar_filename = packaged_sidecar_executable_filename();
    let target_triple = option_env!("TAURI_ENV_TARGET_TRIPLE").unwrap_or("unknown-target");
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

    if packaged_sidecar_filename != sidecar_filename {
        if let Ok(resource_path) = app_handle.path().resolve(
            format!("binaries/{packaged_sidecar_filename}"),
            BaseDirectory::Resource,
        ) {
            candidates.push(resource_path);
        }

        if let Ok(resource_path_flat) = app_handle
            .path()
            .resolve(&packaged_sidecar_filename, BaseDirectory::Resource)
        {
            candidates.push(resource_path_flat);
        }
    }

    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(&sidecar_filename),
    );

    append_ogc_helper_log(
        app_handle,
        &format!(
            "[ogc.sidecar.resolve] attempt target_triple={} filename={} candidates={}",
            target_triple,
            sidecar_filename,
            candidates
                .iter()
                .map(|candidate| candidate.display().to_string())
                .collect::<Vec<_>>()
                .join(" | ")
        ),
    );

    for candidate in candidates {
        if candidate.exists() {
            append_ogc_helper_log(
                app_handle,
                &format!(
                    "[ogc.sidecar.resolve] selected path={}",
                    candidate.display()
                ),
            );
            return Ok(candidate);
        }
    }

    append_ogc_helper_log(
        app_handle,
        &format!(
            "[ogc.sidecar.resolve] failed expected_filename={}",
            sidecar_filename
        ),
    );

    Err(format!(
        "bundled OpenGolfCoach sidecar not found; expected file name {sidecar_filename}"
    ))
}

fn launch_sidecar(app_handle: &AppHandle) -> Result<Child, String> {
    let sidecar_path = resolve_sidecar_path(app_handle)?;
    let current_dir = std::env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|error| format!("unresolved: {error}"));

    println!(
        "[OpenGolfCoach sidecar] launching bundled helper: {}",
        sidecar_path.display()
    );
    append_ogc_helper_log(
        app_handle,
        &format!(
            "[ogc.sidecar.launch_attempt] path={} cwd={} host={} port={}",
            sidecar_path.display(),
            current_dir,
            HELPER_HOST,
            HELPER_PORT
        ),
    );

    let mut command = Command::new(&sidecar_path);

    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    match command
        .env("OPEN_GOLF_COACH_HOST", HELPER_HOST)
        .env("OPEN_GOLF_COACH_PORT", HELPER_PORT.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => {
            append_ogc_helper_log(
                app_handle,
                &format!("[ogc.sidecar.launch_spawned] pid={}", child.id()),
            );
            Ok(child)
        }
        Err(error) => {
            append_ogc_helper_log(
                app_handle,
                &format!(
                    "[ogc.sidecar.launch_failed] path={} error={}",
                    sidecar_path.display(),
                    error
                ),
            );
            Err(format!("failed to launch bundled helper sidecar: {error}"))
        }
    }
}

fn wait_for_helper_health(app_handle: &AppHandle, child: &mut Child) -> Result<(), String> {
    let client = Client::builder()
        .timeout(Duration::from_millis(200))
        .build()
        .map_err(|error| format!("failed to create helper health-check client: {error}"))?;
    let start = Instant::now();
    let timeout = Duration::from_millis(HELPER_STARTUP_TIMEOUT_MS);
    let mut attempt = 0;

    loop {
        attempt += 1;

        match child.try_wait() {
            Ok(Some(status)) => {
                let reason =
                    format!("helper process exited before health check succeeded: status={status}");
                append_ogc_helper_log(
                    app_handle,
                    &format!(
                        "[ogc.sidecar.health_failed] attempt={} elapsed_ms={} reason={}",
                        attempt,
                        start.elapsed().as_millis(),
                        reason
                    ),
                );
                return Err(reason);
            }
            Ok(None) => {}
            Err(error) => {
                append_ogc_helper_log(
                    app_handle,
                    &format!(
                        "[ogc.sidecar.health_child_status_error] attempt={} elapsed_ms={} error={}",
                        attempt,
                        start.elapsed().as_millis(),
                        error
                    ),
                );
            }
        }

        match client.get(HELPER_HEALTH_URL).send() {
            Ok(response) => {
                let status = response.status();
                if status.is_success() {
                    match response.json::<Value>() {
                        Ok(payload) => {
                            let service_name = payload.get("service").and_then(Value::as_str);
                            let health_status = payload.get("status").and_then(Value::as_str);
                            if service_name == Some(HELPER_SERVICE_NAME)
                                && health_status == Some("ok")
                            {
                                append_ogc_helper_log(
                                    app_handle,
                                    &format!(
                                        "[ogc.sidecar.health_success] attempt={} elapsed_ms={} service={:?} status={:?}",
                                        attempt,
                                        start.elapsed().as_millis(),
                                        service_name,
                                        health_status
                                    ),
                                );
                                return Ok(());
                            }

                            append_ogc_helper_log(
                                app_handle,
                                &format!(
                                    "[ogc.sidecar.health_attempt] attempt={} elapsed_ms={} http_status={} result=incompatible_payload payload={:?}",
                                    attempt,
                                    start.elapsed().as_millis(),
                                    status,
                                    payload
                                ),
                            );
                        }
                        Err(error) => {
                            append_ogc_helper_log(
                                app_handle,
                                &format!(
                                    "[ogc.sidecar.health_attempt] attempt={} elapsed_ms={} http_status={} result=invalid_json error={}",
                                    attempt,
                                    start.elapsed().as_millis(),
                                    status,
                                    error
                                ),
                            );
                        }
                    }
                } else {
                    append_ogc_helper_log(
                        app_handle,
                        &format!(
                            "[ogc.sidecar.health_attempt] attempt={} elapsed_ms={} http_status={} result=non_success",
                            attempt,
                            start.elapsed().as_millis(),
                            status
                        ),
                    );
                }
            }
            Err(error) => {
                append_ogc_helper_log(
                    app_handle,
                    &format!(
                        "[ogc.sidecar.health_attempt] attempt={} elapsed_ms={} result=request_failed error={}",
                        attempt,
                        start.elapsed().as_millis(),
                        error
                    ),
                );
            }
        }

        if start.elapsed() >= timeout {
            let reason = format!(
                "helper health check timed out after {}ms",
                HELPER_STARTUP_TIMEOUT_MS
            );
            append_ogc_helper_log(
                app_handle,
                &format!(
                    "[ogc.sidecar.health_timeout] attempts={} elapsed_ms={} reason={}",
                    attempt,
                    start.elapsed().as_millis(),
                    reason
                ),
            );
            return Err(reason);
        }

        std::thread::sleep(Duration::from_millis(HELPER_HEALTH_POLL_MS));
    }
}

fn ensure_open_golf_coach_helper(app_handle: &AppHandle, sidecar_state: &SidecarState) {
    match probe_helper() {
        HelperProbe::CompatibleRunning => {
            append_ogc_helper_log(
                app_handle,
                &format!(
                    "[ogc.sidecar.probe] result=compatible_running url={}",
                    HELPER_HEALTH_URL
                ),
            );
            println!(
        "[OpenGolfCoach sidecar] compatible helper already running at {HELPER_HEALTH_URL}; reusing existing process"
      );
        }
        HelperProbe::IncompatibleService(reason) => {
            append_ogc_helper_log(
                app_handle,
                &format!(
                    "[ogc.sidecar.probe] result=incompatible_service port={} reason={}",
                    HELPER_PORT, reason
                ),
            );
            eprintln!(
        "[OpenGolfCoach sidecar] cannot start bundled helper because 127.0.0.1:{HELPER_PORT} is occupied: {reason}"
      );
            eprintln!(
        "[OpenGolfCoach sidecar] leaving existing service untouched; enrichment will fail until port is freed or a compatible helper is running"
      );
        }
        HelperProbe::PortFree => {
            append_ogc_helper_log(
                app_handle,
                &format!(
                    "[ogc.sidecar.probe] result=port_free host={} port={}",
                    HELPER_HOST, HELPER_PORT
                ),
            );
            let mut guard = match sidecar_state.child.lock() {
                Ok(lock) => lock,
                Err(error) => {
                    append_ogc_helper_log(
                        app_handle,
                        &format!("[ogc.sidecar.mutex_failed] error={error}"),
                    );
                    eprintln!("[OpenGolfCoach sidecar] failed to acquire sidecar mutex: {error}");
                    return;
                }
            };

            if guard.is_some() {
                append_ogc_helper_log(
                    app_handle,
                    "[ogc.sidecar.launch_skipped] reason=already_started_in_process",
                );
                println!(
                    "[OpenGolfCoach sidecar] bundled helper already started in this app process"
                );
                return;
            }

            match launch_sidecar(app_handle) {
                Ok(mut child) => {
                    match wait_for_helper_health(app_handle, &mut child) {
                        Ok(()) => {
                            println!(
            "[OpenGolfCoach sidecar] bundled helper started on http://{HELPER_HOST}:{HELPER_PORT}"
          );
                        }
                        Err(error) => {
                            append_ogc_helper_log(
                                app_handle,
                                &format!("[ogc.sidecar.startup_failed] error={error}"),
                            );
                            eprintln!(
                                "[OpenGolfCoach sidecar] startup health check failed: {error}"
                            );
                        }
                    }
                    *guard = Some(child);
                }
                Err(error) => {
                    append_ogc_helper_log(
                        app_handle,
                        &format!("[ogc.sidecar.launch_error] error={error}"),
                    );
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

fn append_ogc_helper_log(app: &tauri::AppHandle, line: &str) {
    if let Err(error) = append_log_line(app, OGC_HELPER_LOG_FILE, line) {
        eprintln!("[OpenGolfCoach sidecar] failed to append helper log: {error}");
    }
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
    append_log_line(
        &app,
        "nova-connection.log",
        &format!("[discovery] browse_started ok service={}", NOVA_WS_SERVICE_NAME),
    )?;
    let deadline = Instant::now() + timeout;
    let mut discovered: Option<NovaDiscoveredEndpoint> = None;
    let mut found_count: u32 = 0;
    let mut resolved_count: u32 = 0;

    while Instant::now() < deadline {
        match receiver.recv_timeout(Duration::from_millis(250)) {
            Ok(ServiceEvent::ServiceFound(service_type, fullname)) => {
                found_count += 1;
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
                        "[discovery] explicit_resolve_fetch_attempt fullname={}",
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
                resolved_count += 1;
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
                let mut host = info
                    .get_addresses()
                    .iter()
                    .next()
                    .map(|ip| ip.to_string());

                if host.is_none() {
                    let hostname = info.get_hostname();
                    append_log_line(
                        &app,
                        "nova-connection.log",
                        &format!("[discovery] explicit_hostname_resolve_attempt hostname={}", hostname),
                    )?;
                    match mdns.resolve_hostname(hostname, Some(1500)) {
                        Ok(host_receiver) => {
                            let resolve_deadline = Instant::now() + Duration::from_millis(1750);
                            while Instant::now() < resolve_deadline {
                                match host_receiver.recv_timeout(Duration::from_millis(250)) {
                                    Ok(HostnameResolutionEvent::AddressesFound(_, addresses)) => {
                                        if let Some(address) = addresses.iter().next() {
                                            host = Some(address.to_string());
                                            append_log_line(
                                                &app,
                                                "nova-connection.log",
                                                &format!(
                                                    "[discovery] explicit_hostname_resolve_success hostname={} ip={}",
                                                    hostname, address
                                                ),
                                            )?;
                                            break;
                                        }
                                    }
                                    Ok(HostnameResolutionEvent::SearchTimeout(_))
                                    | Ok(HostnameResolutionEvent::SearchStopped(_)) => {
                                        break;
                                    }
                                    Ok(_) => {}
                                    Err(RecvTimeoutError::Timeout) => {}
                                    Err(error) => {
                                        append_log_line(
                                            &app,
                                            "nova-connection.log",
                                            &format!(
                                                "[discovery] explicit_hostname_resolve_error hostname={} error={}",
                                                hostname, error
                                            ),
                                        )?;
                                        break;
                                    }
                                }
                            }
                        }
                        Err(error) => {
                            append_log_line(
                                &app,
                                "nova-connection.log",
                                &format!(
                                    "[discovery] explicit_hostname_resolve_failed hostname={} error={}",
                                    hostname, error
                                ),
                            )?;
                        }
                    }
                }

                if host.is_none() {
                    let hostname = info.get_hostname().trim_end_matches('.');
                    if !hostname.is_empty() {
                        host = Some(hostname.to_string());
                    }
                }
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
            "[discovery] result={} found_count={} resolved_count={}",
            discovered
                .as_ref()
                .map(|value| value.ws_url.clone())
                .unwrap_or_else(|| "none".to_string()),
            found_count,
            resolved_count
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
            append_ogc_helper_log(
                &app_handle,
                &format!(
                    "[ogc.sidecar.setup] start host={} port={} health_url={}",
                    HELPER_HOST, HELPER_PORT, HELPER_HEALTH_URL
                ),
            );
            let sidecar_state = app_handle.state::<SidecarState>();
            ensure_open_golf_coach_helper(&app_handle, sidecar_state.inner());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
