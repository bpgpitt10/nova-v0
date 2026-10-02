use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, create_dir_all};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const RESOURCE_DIR: &str = "auto-aim-toolkit";
const RUNTIME_DIR: &str = "auto-aim";
const CONTEXT_FILE: &str = "looper_auto_aim_context.json";
const LAUNCHER_FILE: &str = "run_auto_aim_windows.ps1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoAimCommandResult {
    pub ok: bool,
    pub status: String,
    pub stdout: String,
    pub stderr: String,
    pub vector_error_yds: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoAimContext {
    course_id: String,
    hole_number: u8,
    tee_x: f64,
    tee_y: f64,
}

fn copy_runtime_tree(source: &Path, destination: &Path) -> Result<(), String> {
    create_dir_all(destination).map_err(|error| {
        format!(
            "failed to create Auto Aim runtime directory {}: {error}",
            destination.display()
        )
    })?;

    for entry in fs::read_dir(source)
        .map_err(|error| format!("failed to read Auto Aim resource {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("failed to read Auto Aim resource entry: {error}"))?;
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if matches!(name_text.as_ref(), ".venv" | "output" | "__pycache__") {
            continue;
        }

        let source_path = entry.path();
        let destination_path = destination.join(&name);
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect {}: {error}", source_path.display()))?;
        if file_type.is_dir() {
            copy_runtime_tree(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "failed to copy Auto Aim resource {} to {}: {error}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        }
    }
    Ok(())
}

fn resolve_toolkit_source(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(path) = app.path().resolve(RESOURCE_DIR, BaseDirectory::Resource) {
        candidates.push(path);
    }
    if let Ok(path) = app
        .path()
        .resolve(format!("resources/{RESOURCE_DIR}"), BaseDirectory::Resource)
    {
        candidates.push(path);
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
            .join("tools")
            .join("minimap_probe"),
    );

    candidates
        .into_iter()
        .find(|candidate| candidate.join(LAUNCHER_FILE).exists())
        .ok_or_else(|| "bundled Auto Aim toolkit was not found".to_string())
}

fn prepare_runtime(app: &AppHandle) -> Result<PathBuf, String> {
    let source = resolve_toolkit_source(app)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve app data directory: {error}"))?;
    let runtime = app_data.join(RUNTIME_DIR);
    copy_runtime_tree(&source, &runtime)?;
    if !runtime.join(LAUNCHER_FILE).exists() {
        return Err(format!(
            "Auto Aim launcher is missing after runtime preparation: {}",
            runtime.join(LAUNCHER_FILE).display()
        ));
    }
    Ok(runtime)
}

fn run_launcher(runtime: &Path, args: &[String]) -> Result<(bool, String, String), String> {
    if !cfg!(windows) {
        return Err("GSPro Auto Aim is only available in the Windows desktop app".to_string());
    }

    let launcher = runtime.join(LAUNCHER_FILE);
    let mut command = Command::new("powershell");
    command
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&launcher)
        .args(args)
        .current_dir(runtime)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let output = command
        .output()
        .map_err(|error| format!("failed to launch Auto Aim PowerShell runner: {error}"))?;
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
        String::from_utf8_lossy(&output.stderr).trim().to_string(),
    ))
}

fn context_path(runtime: &Path) -> PathBuf {
    runtime.join(CONTEXT_FILE)
}

fn save_context(runtime: &Path, context: &AutoAimContext) -> Result<(), String> {
    let text = serde_json::to_string_pretty(context)
        .map_err(|error| format!("failed to serialize Auto Aim context: {error}"))?;
    fs::write(context_path(runtime), text)
        .map_err(|error| format!("failed to save Auto Aim context: {error}"))
}

fn load_matching_context(runtime: &Path, course_id: &str, hole_number: u8) -> Result<AutoAimContext, String> {
    let path = context_path(runtime);
    let text = fs::read_to_string(&path).map_err(|_| {
        "Auto Aim has not been calibrated for this hole. Arm the tee-shot recommendation first.".to_string()
    })?;
    let context: AutoAimContext = serde_json::from_str(&text)
        .map_err(|error| format!("saved Auto Aim hole context is invalid: {error}"))?;
    if context.course_id != course_id || context.hole_number != hole_number {
        return Err(format!(
            "Auto Aim tee calibration belongs to {} hole {}, not {} hole {}. Refusing to click.",
            context.course_id, context.hole_number, course_id, hole_number
        ));
    }
    Ok(context)
}

fn latest_vector_error(runtime: &Path) -> Option<f64> {
    let path = runtime
        .join("output")
        .join("auto_aim")
        .join("latest_auto_aim_result.json");
    let text = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value.get("vector_error_yds").and_then(Value::as_f64)
}

fn coordinate(value: f64, label: &str) -> Result<f64, String> {
    if value.is_finite() {
        Ok(value)
    } else {
        Err(format!("Auto Aim {label} coordinate is not finite"))
    }
}

fn calibrate_tee_inner(
    app: AppHandle,
    course_id: String,
    hole_number: u8,
    par: u8,
    tee_x: f64,
    tee_y: f64,
    monitor: Option<u8>,
) -> Result<AutoAimCommandResult, String> {
    if !(1..=18).contains(&hole_number) {
        return Err("Auto Aim hole number must be 1-18".to_string());
    }
    if !(3..=5).contains(&par) {
        return Err("Auto Aim tee calibration requires par 3, 4, or 5".to_string());
    }
    let tee_x = coordinate(tee_x, "tee X")?;
    let tee_y = coordinate(tee_y, "tee Y")?;
    let runtime = prepare_runtime(&app)?;
    let args = vec![
        "-Monitor".to_string(),
        monitor.unwrap_or(1).to_string(),
        "-CalibrateTee".to_string(),
        "-Par".to_string(),
        par.to_string(),
    ];
    let (ok, stdout, stderr) = run_launcher(&runtime, &args)?;
    if !ok {
        return Ok(AutoAimCommandResult {
            ok: false,
            status: "CALIBRATION_FAILED".to_string(),
            stdout,
            stderr,
            vector_error_yds: None,
        });
    }

    save_context(
        &runtime,
        &AutoAimContext {
            course_id,
            hole_number,
            tee_x,
            tee_y,
        },
    )?;

    Ok(AutoAimCommandResult {
        ok: true,
        status: "CALIBRATED".to_string(),
        stdout,
        stderr,
        vector_error_yds: None,
    })
}

fn target_inner(
    app: AppHandle,
    course_id: String,
    hole_number: u8,
    pin_x: f64,
    pin_y: f64,
    target_x: f64,
    target_y: f64,
    monitor: Option<u8>,
) -> Result<AutoAimCommandResult, String> {
    let pin_x = coordinate(pin_x, "pin X")?;
    let pin_y = coordinate(pin_y, "pin Y")?;
    let target_x = coordinate(target_x, "target X")?;
    let target_y = coordinate(target_y, "target Y")?;
    let runtime = prepare_runtime(&app)?;
    let context = load_matching_context(&runtime, &course_id, hole_number)?;
    let args = vec![
        "-Monitor".to_string(),
        monitor.unwrap_or(1).to_string(),
        "-TeeCourse".to_string(),
        format!("{:.6},{:.6}", context.tee_x, context.tee_y),
        "-PinCourse".to_string(),
        format!("{pin_x:.6},{pin_y:.6}"),
        "-TargetCourse".to_string(),
        format!("{target_x:.6},{target_y:.6}"),
        "-Click".to_string(),
    ];
    let (ok, stdout, stderr) = run_launcher(&runtime, &args)?;
    let vector_error_yds = latest_vector_error(&runtime);
    Ok(AutoAimCommandResult {
        ok,
        status: if ok { "PASS" } else { "FAILED" }.to_string(),
        stdout,
        stderr,
        vector_error_yds,
    })
}

#[tauri::command]
pub async fn gspro_auto_aim_calibrate_tee(
    app: AppHandle,
    course_id: String,
    hole_number: u8,
    par: u8,
    tee_x: f64,
    tee_y: f64,
    monitor: Option<u8>,
) -> Result<AutoAimCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        calibrate_tee_inner(app, course_id, hole_number, par, tee_x, tee_y, monitor)
    })
    .await
    .map_err(|error| format!("Auto Aim calibration task failed: {error}"))?
}

#[tauri::command]
pub async fn gspro_auto_aim_target(
    app: AppHandle,
    course_id: String,
    hole_number: u8,
    pin_x: f64,
    pin_y: f64,
    target_x: f64,
    target_y: f64,
    monitor: Option<u8>,
) -> Result<AutoAimCommandResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        target_inner(
            app,
            course_id,
            hole_number,
            pin_x,
            pin_y,
            target_x,
            target_y,
            monitor,
        )
    })
    .await
    .map_err(|error| format!("Auto Aim target task failed: {error}"))?
}
