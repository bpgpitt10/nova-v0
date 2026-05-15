#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::Value;
use flume::RecvTimeoutError;
use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use mdns_sd::{HostnameResolutionEvent, ServiceDaemon, ServiceEvent};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

const HELPER_HOST: &str = "127.0.0.1";
const HELPER_PORT: u16 = 8787;
const HELPER_SERVICE_NAME: &str = "open-golf-coach-helper";
const HELPER_HEALTH_URL: &str = "http://127.0.0.1:8787/health";
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

    let mut command = Command::new(sidecar_path);

    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    command
        .env("OPEN_GOLF_COACH_HOST", HELPER_HOST)
        .env("OPEN_GOLF_COACH_PORT", HELPER_PORT.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("failed to launch bundled helper sidecar: {error}"))
}

fn ensure_open_golf_coach_helper(app_handle: &AppHandle, sidecar_state: &SidecarState) {
    #[cfg(windows)]
    log_windows_helper_processes("before-launch-probe", resolve_sidecar_path(app_handle).ok().as_deref());

    match probe_helper() {
        HelperProbe::CompatibleRunning => {
            println!(
        "[OpenGolfCoach sidecar] compatible helper already running at {HELPER_HEALTH_URL}; reusing existing process"
      );
            #[cfg(windows)]
            log_windows_helper_processes("compatible-helper-reused", resolve_sidecar_path(app_handle).ok().as_deref());
        }
        HelperProbe::IncompatibleService(reason) => {
            eprintln!(
        "[OpenGolfCoach sidecar] cannot start bundled helper because 127.0.0.1:{HELPER_PORT} is occupied: {reason}"
      );
            eprintln!(
        "[OpenGolfCoach sidecar] leaving existing service untouched; enrichment will fail until port is freed or a compatible helper is running"
      );
            #[cfg(windows)]
            log_windows_helper_processes("incompatible-service-detected", resolve_sidecar_path(app_handle).ok().as_deref());
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
                    #[cfg(windows)]
                    log_windows_helper_processes("after-launch", resolve_sidecar_path(app_handle).ok().as_deref());
                }
                Err(error) => {
                    eprintln!("[OpenGolfCoach sidecar] {error}");
                }
            }
        }
    }
}

fn shutdown_sidecar(app_handle: &AppHandle, sidecar_state: &SidecarState) {
    println!("[OpenGolfCoach sidecar] shutdown_sidecar invoked");

    let mut guard = match sidecar_state.child.lock() {
        Ok(lock) => lock,
        Err(error) => {
            eprintln!("[OpenGolfCoach sidecar] failed to acquire sidecar mutex during shutdown: {error}");
            return;
        }
    };

    let Some(mut child) = guard.take() else {
        println!("[OpenGolfCoach sidecar] no tracked bundled helper child was present during shutdown");
        return;
    };

    println!(
        "[OpenGolfCoach sidecar] tracked bundled helper child found with pid {}",
        child.id()
    );

    match child.try_wait() {
        Ok(Some(status)) => {
            println!(
                "[OpenGolfCoach sidecar] bundled helper already exited with status {status}"
            );
            return;
        }
        Ok(None) => {
            println!("[OpenGolfCoach sidecar] bundled helper is still running; attempting kill");
        }
        Err(error) => {
            eprintln!("[OpenGolfCoach sidecar] failed to query bundled helper status: {error}");
        }
    }

    match child.kill() {
        Ok(()) => {
            println!("[OpenGolfCoach sidecar] kill signal sent to bundled helper");
        }
        Err(error) => {
            eprintln!("[OpenGolfCoach sidecar] failed to terminate bundled helper: {error}");
        }
    }

    match child.wait() {
        Ok(status) => {
            println!(
                "[OpenGolfCoach sidecar] bundled helper terminated during app shutdown with status {status}"
            );
        }
        Err(error) => {
            eprintln!("[OpenGolfCoach sidecar] failed to reap bundled helper: {error}");
        }
    }

    #[cfg(windows)]
    cleanup_matching_windows_helper_processes(app_handle);
}

#[cfg(windows)]
#[derive(Debug)]
struct WindowsHelperProcessInfo {
    pid: u32,
    name: String,
    executable_path: Option<PathBuf>,
}

#[cfg(windows)]
fn normalized_path_string(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").to_ascii_lowercase()
}

#[cfg(windows)]
fn list_windows_helper_processes() -> Vec<WindowsHelperProcessInfo> {
    let script = "Get-CimInstance Win32_Process -Filter \"Name LIKE 'open-golf-coach-helper%'\" | ForEach-Object { $exe = if ($_.ExecutablePath) { $_.ExecutablePath } else { '' }; Write-Output (\"$($_.ProcessId)`t$($_.Name)`t$exe\") }";

    let output = match Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
    {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[OpenGolfCoach sidecar] failed to enumerate helper processes via PowerShell: {error}");
            return Vec::new();
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!(
            "[OpenGolfCoach sidecar] helper process enumeration failed with status {}: {}",
            output.status,
            stderr.trim()
        );
        return Vec::new();
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let pid = parts.next()?.trim().parse::<u32>().ok()?;
            let name = parts.next()?.trim().to_string();
            let executable_path = parts
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from);

            Some(WindowsHelperProcessInfo {
                pid,
                name,
                executable_path,
            })
        })
        .collect()
}

#[cfg(windows)]
fn log_windows_helper_processes(context: &str, bundled_helper_path: Option<&Path>) {
    let bundled_helper_path = bundled_helper_path.map(normalized_path_string);
    let processes = list_windows_helper_processes();

    if processes.is_empty() {
        println!("[OpenGolfCoach sidecar] helper process snapshot ({context}): none");
        return;
    }

    println!(
        "[OpenGolfCoach sidecar] helper process snapshot ({context}): {} process(es)",
        processes.len()
    );
    for process in processes {
        let path_display = process
            .executable_path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "<unknown>".to_string());
        let matches_bundled = process
            .executable_path
            .as_ref()
            .map(|path| normalized_path_string(path))
            .and_then(|path| bundled_helper_path.as_ref().map(|bundled| path == *bundled))
            .unwrap_or(false);

        println!(
            "[OpenGolfCoach sidecar] helper process snapshot ({context}): pid={} name={} path={} matches_bundled={}",
            process.pid,
            process.name,
            path_display,
            matches_bundled
        );
    }
}

#[cfg(windows)]
fn cleanup_matching_windows_helper_processes(app_handle: &AppHandle) {
    let bundled_helper_path = match resolve_sidecar_path(app_handle) {
        Ok(path) => path,
        Err(error) => {
            eprintln!("[OpenGolfCoach sidecar] could not resolve bundled helper path during cleanup: {error}");
            return;
        }
    };

    let bundled_helper_path_normalized = normalized_path_string(&bundled_helper_path);
    let processes = list_windows_helper_processes();

    if processes.is_empty() {
        println!("[OpenGolfCoach sidecar] no helper processes remain after tracked child shutdown");
        return;
    }

    println!(
        "[OpenGolfCoach sidecar] helper processes remaining after tracked child shutdown: {}",
        processes.len()
    );

    for process in processes {
        let Some(executable_path) = process.executable_path.as_ref() else {
            println!(
                "[OpenGolfCoach sidecar] leaving helper pid={} name={} untouched because executable path is unknown",
                process.pid, process.name
            );
            continue;
        };

        let normalized_process_path = normalized_path_string(executable_path);
        let matches_bundled = normalized_process_path == bundled_helper_path_normalized;

        println!(
            "[OpenGolfCoach sidecar] remaining helper pid={} name={} path={} matches_bundled={}",
            process.pid,
            process.name,
            executable_path.display(),
            matches_bundled
        );

        if !matches_bundled {
            continue;
        }

        match Command::new("taskkill")
            .args(["/PID", &process.pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
        {
            Ok(output) if output.status.success() => {
                println!(
                    "[OpenGolfCoach sidecar] terminated matching bundled helper cleanup pid={}",
                    process.pid
                );
            }
            Ok(output) => {
                eprintln!(
                    "[OpenGolfCoach sidecar] failed to terminate matching bundled helper cleanup pid={} status={} stderr={}",
                    process.pid,
                    output.status,
                    String::from_utf8_lossy(&output.stderr).trim()
                );
            }
            Err(error) => {
                eprintln!(
                    "[OpenGolfCoach sidecar] failed to invoke taskkill for bundled helper cleanup pid={}: {}",
                    process.pid, error
                );
            }
        }
    }

    log_windows_helper_processes("post-cleanup", Some(&bundled_helper_path));
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

#[tauri::command]
fn export_shots_csv(suggested_filename: String, csv: String) -> Result<bool, String> {
    let Some(path) = rfd::FileDialog::new()
        .add_filter("CSV", &["csv"])
        .set_file_name(&suggested_filename)
        .save_file()
    else {
        return Ok(false);
    };

    std::fs::write(&path, csv)
        .map_err(|error| format!("failed to write CSV export to {}: {error}", path.display()))?;
    Ok(true)
}

fn main() {
    let sidecar_state = SidecarState::default();

    tauri::Builder::default()
        .manage(sidecar_state)
        .invoke_handler(tauri::generate_handler![
            append_enrichment_log,
            append_nova_log,
            discover_nova_ws_endpoint,
            export_shots_csv
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                println!(
                    "[OpenGolfCoach sidecar] main window close requested for label {}",
                    window.label()
                );
                let sidecar_state = window.state::<SidecarState>();
                shutdown_sidecar(window.app_handle(), sidecar_state.inner());
                println!("[OpenGolfCoach sidecar] requesting full app exit after window close");
                window.app_handle().exit(0);
            }
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            let sidecar_state = app_handle.state::<SidecarState>();
            ensure_open_golf_coach_helper(&app_handle, sidecar_state.inner());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            match event {
                RunEvent::ExitRequested { .. } => {
                    println!("[OpenGolfCoach sidecar] RunEvent::ExitRequested fired");
                    let sidecar_state = app_handle.state::<SidecarState>();
                    shutdown_sidecar(app_handle, sidecar_state.inner());
                }
                RunEvent::Exit => {
                    println!("[OpenGolfCoach sidecar] RunEvent::Exit fired");
                    let sidecar_state = app_handle.state::<SidecarState>();
                    shutdown_sidecar(app_handle, sidecar_state.inner());
                }
                _ => {}
            }
        })
}
