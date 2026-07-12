use base64::Engine as _;
use clap::{Parser, Subcommand};
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, ExitCode};
use std::time::Duration;

#[cfg(unix)]
fn set_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[derive(Parser)]
#[command(
    name = "capix-code",
    version,
    about = "Capix Code — customer coding agent"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[arg(last = true)]
    engine_args: Vec<String>,
}

#[derive(Subcommand)]
enum Command {
    Run,
    RunAgent,
    /// Run remote inference through the Capix compute network
    LlmRun {
        prompt: Vec<String>,
    },
    /// Show Capix remote GPU capacity without supplier disclosure
    GpuStatus,
    Login,
    Logout,
    Doctor,
    Account,
    Project,
    Status,
    Attach {
        workspace_id: String,
    },
    Operations,
    Receipts,
    Usage,
    Invoices,
    /// Authentication management
    Auth {
        #[command(subcommand)]
        subcommand: AuthCommand,
    },
}

#[derive(Subcommand)]
enum AuthCommand {
    /// Show current authentication status
    Status,
    /// Clear all credentials and force re-authentication
    Reset,
}

fn install_root() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("cannot locate launcher: {e}"))?;
    // User-local installs expose the launcher through a PATH symlink. Resolve
    // that link before locating the sibling engine/runtime/config bundle.
    let exe = std::fs::canonicalize(&exe)
        .map_err(|e| format!("cannot resolve launcher path {}: {e}", exe.display()))?;
    let bin = exe.parent().ok_or("launcher has no parent directory")?;
    Ok(if bin.file_name().and_then(|x| x.to_str()) == Some("bin") {
        bin.parent().unwrap_or(bin).to_path_buf()
    } else {
        bin.to_path_buf()
    })
}

fn engine_path(root: &Path) -> PathBuf {
    if let Some(path) = std::env::var_os("CAPIX_CODE_ENGINE") {
        return PathBuf::from(path);
    }
    root.join("engine").join(if cfg!(windows) {
        "capix-engine.exe"
    } else {
        "capix-engine"
    })
}

fn scrub_environment(command: &mut ProcessCommand) {
    const PREFIXES: &[&str] = &[
        "AWS_",
        "AZURE_",
        "GOOGLE_",
        "GCLOUD_",
        "OPENAI_",
        "ANTHROPIC_",
        "SSH_",
        "WALLET_",
        "SOLANA_",
        "PRIVATE_",
        "SECRET_",
        "VAST_",
        "HETZNER_",
    ];
    const EXACT: &[&str] = &[
        "TOKEN",
        "APIKEY",
        "REFRESH_TOKEN",
        "ACCESS_TOKEN",
        "PASSPHRASE",
        "PASSWORD",
        "PRIVATE_KEY",
        "BEARER",
        "AUTHORIZATION",
        "CAPIX_ACCESS_TOKEN",
        "CAPIX_REFRESH_TOKEN",
        "CAPIX_OPERATOR_TOKEN",
        "CAPIX_TREASURY_SECRET_KEY",
    ];
    for (key, _) in std::env::vars() {
        let upper = key.to_uppercase();
        if PREFIXES.iter().any(|p| upper.starts_with(p)) || EXACT.iter().any(|e| upper == *e) {
            command.env_remove(key);
        }
    }
}

/// Compute the release identity for this build.
///
/// Precedence:
/// 1. `CAPIX_RELEASE_ID` env var (set by packaging/CI)
/// 2. `capix-code-1.1.0` (package.json version baked at compile time)
///
/// The launcher cannot call `git` at runtime, so this is a compile-time
/// constant fallback. The env-var override lets release pipelines stamp
/// the exact `capix-code-{version}-{git_sha}` identity they shipped.
fn release_id() -> String {
    std::env::var("CAPIX_RELEASE_ID")
        .unwrap_or_else(|_| "capix-code-1.1.0".to_string())
}

fn run_engine(root: &Path, args: &[String]) -> Result<ExitCode, String> {
    let engine = engine_path(root);
    if !engine.is_file() {
        return Err(format!("bundled engine missing: {}", engine.display()));
    }
    let runtime_dir = root.join("runtime");
    let mut config: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("config/defaults.json"))
            .map_err(|e| format!("cannot read bundled Capix config: {e}"))?,
    )
    .map_err(|e| format!("invalid bundled Capix config: {e}"))?;
    let mut command = ProcessCommand::new(&engine);
    // Strip all inherited secrets first, then inject only the freshly rotated,
    // short-lived Capix access token into the child provider. Refresh material
    // never leaves the native keychain boundary.
    scrub_environment(&mut command);
    let access = access_token()?;
    let canonical = runtime()?.block_on(async {
        let client = reqwest::Client::new();
        let models_response = client
            .get(format!("{WEB_ORIGIN}/api/v1/models"))
            .bearer_auth(&access)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let models_status = models_response.status();
        let models_text = models_response.text().await.map_err(|e| e.to_string())?;
        if !models_status.is_success() {
            return Err(format!(
                "Capix model catalog unavailable ({models_status}): {models_text}"
            ));
        }
        let models: serde_json::Value =
            serde_json::from_str(&models_text).map_err(|e| e.to_string())?;
        let billing_response = client
            .get(format!("{WEB_ORIGIN}/api/v1/billing"))
            .bearer_auth(&access)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let billing_status = billing_response.status();
        let billing_text = billing_response.text().await.map_err(|e| e.to_string())?;
        if !billing_status.is_success() {
            return Err(format!(
                "Capix billing unavailable ({billing_status}): {billing_text}"
            ));
        }
        let billing: serde_json::Value =
            serde_json::from_str(&billing_text).map_err(|e| e.to_string())?;
        Ok::<_, String>((models, billing))
    })?;
    let mut engine_models = serde_json::Map::new();
    engine_models.insert(
        "auto".into(),
        serde_json::json!({
            "name": "Capix Auto · smart routed",
            "limit": {"context": 128000, "output": 64000}
        }),
    );
    if let Some(models) = canonical.0.get("models").and_then(|v| v.as_array()) {
        for model in models.iter().filter(|m| {
            m.get("available")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        }) {
            let Some(id) = model.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let label = model.get("label").and_then(|v| v.as_str()).unwrap_or(id);
            let context = model
                .get("contextWindow")
                .and_then(|v| v.as_u64())
                .unwrap_or(32768);
            engine_models.insert(
                id.to_string(),
                serde_json::json!({
                    "name": format!("Capix · {label}"),
                    "limit": {"context": context, "output": context.min(32768)}
                }),
            );
        }
    }
    config["provider"]["capix"]["models"] = serde_json::Value::Object(engine_models);
    config["enabled_providers"] = serde_json::json!(["capix"]);
    config["model"] = serde_json::json!("capix/auto");
    config["plugin"] = serde_json::json!([
        runtime_dir.join("src/native-bridge.ts").to_string_lossy(),
        runtime_dir.join("src/plugin.ts").to_string_lossy()
    ]);
    let config_content = serde_json::to_string(&config)
        .map_err(|e| format!("cannot encode bundled Capix config: {e}"))?;
    let available = canonical
        .1
        .pointer("/balances/USDC/available")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    eprintln!(
        "Capix connected · USDC balance {} · model Capix Auto",
        available
    );
    command
        .args(args)
        .env("CAPIX_CODE_BUNDLED_RUNTIME", &runtime_dir)
        .env("CAPIX_CODE_PLUGIN", runtime_dir.join("src/plugin.ts"))
        .env(
            "CAPIX_CODE_DEFAULT_CONFIG",
            root.join("config/defaults.json"),
        )
        // The rebranded engine reads CAPIX_CODE_CONFIG_CONTENT (not
        // OPENCODE_CONFIG_CONTENT) at config.ts:468. This carries the
        // opencode-schema config with the plugin path so the engine
        // actually loads the Capix provider, auth and sandbox.
        .env("CAPIX_CODE_CONFIG_CONTENT", config_content)
        .env("CAPIX_BASE_URL", "https://www.capix.network/api/v1")
        .env(
            "CAPIX_INFERENCE_BASE_URL",
            "https://www.capix.network/api/v1",
        )
        .env("CAPIX_API_KEY", access)
        .env("CAPIX_RELEASE_ID", release_id())
        .env("CAPIX_CODE_RELEASE_ID", release_id());
    let status = command
        .status()
        .map_err(|e| format!("failed to launch engine: {e}"))?;
    Ok(ExitCode::from(status.code().unwrap_or(1) as u8))
}

const WEB_ORIGIN: &str = "https://www.capix.network";
const KEYRING_SERVICE: &str = "capix-code";
const KEYRING_ACCOUNT: &str = "oauth-refresh-token";

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
}

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Runtime::new().map_err(|e| format!("cannot start secure network runtime: {e}"))
}

fn open_browser(url: &str) -> Result<(), String> {
    let status = if cfg!(target_os = "macos") {
        ProcessCommand::new("open").arg(url).status()
    } else if cfg!(windows) {
        ProcessCommand::new("cmd")
            .args(["/C", "start", "", url])
            .status()
    } else {
        ProcessCommand::new("xdg-open").arg(url).status()
    }
    .map_err(|e| format!("cannot open browser: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("browser did not open; copy the displayed URL manually".into())
    }
}

fn login() -> Result<ExitCode, String> {
    let listener =
        TcpListener::bind("127.0.0.1:0").map_err(|e| format!("cannot bind OAuth callback: {e}"))?;
    listener.set_nonblocking(false).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let mut verifier_bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut verifier_bytes);
    let verifier = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(verifier_bytes);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    let mut state_bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut state_bytes);
    let state = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(state_bytes);
    let mut authorize =
        url::Url::parse(&format!("{WEB_ORIGIN}/oauth/authorize")).map_err(|e| e.to_string())?;
    authorize
        .query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", "capix-code")
        .append_pair("redirect_uri", &redirect)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state)
        .append_pair("scope", "openid account");
    println!("Opening Capix sign-in in your browser…\n{}", authorize);
    open_browser(authorize.as_str())?;
    let (mut stream, _) = listener
        .accept()
        .map_err(|e| format!("OAuth callback failed: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(180)))
        .map_err(|e| e.to_string())?;
    let mut request = [0u8; 8192];
    let n = stream.read(&mut request).map_err(|e| e.to_string())?;
    let first = String::from_utf8_lossy(&request[..n])
        .lines()
        .next()
        .unwrap_or("")
        .to_string();
    let target = first
        .split_whitespace()
        .nth(1)
        .ok_or("invalid OAuth callback")?;
    let callback =
        url::Url::parse(&format!("http://127.0.0.1{target}")).map_err(|e| e.to_string())?;
    let code = callback
        .query_pairs()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.into_owned())
        .ok_or("OAuth code missing")?;
    let returned_state = callback
        .query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
        .ok_or("OAuth state missing")?;
    if returned_state != state {
        return Err("OAuth state mismatch".into());
    }
    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<h1>Capix Code connected</h1><p>You can return to your terminal.</p>");
    let token: TokenResponse = runtime()?.block_on(async {
        reqwest::Client::new()
            .post(format!("{WEB_ORIGIN}/oauth/token"))
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code.as_str()),
                ("code_verifier", verifier.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("client_id", "capix-code"),
            ])
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json::<TokenResponse>()
            .await
            .map_err(|e| e.to_string())
    })?;
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| e.to_string())?
        .set_password(&token.refresh_token)
        .map_err(|e| format!("OS credential store rejected token: {e}"))?;

    // Also write to the file-based bridge store so the in-process
    // CredentialBroker (running inside the Bun engine) can read it via
    // globalThis.capixSecureStore without direct keyring access.
    let cred_dir = std::env::var("HOME")
        .map(|h| std::path::PathBuf::from(h).join(".capix-code"))
        .unwrap_or_else(|_| std::path::PathBuf::from(".capix-code"));
    let _ = std::fs::create_dir_all(&cred_dir);
    let cred_file = cred_dir.join("credentials.json");
    let mut creds: serde_json::Value = std::fs::read(&cred_file)
        .ok()
        .and_then(|d| serde_json::from_slice(&d).ok())
        .unwrap_or(serde_json::json!({}));
    if let Some(obj) = creds.as_object_mut() {
        obj.insert(
            format!("{KEYRING_SERVICE}:{KEYRING_ACCOUNT}"),
            serde_json::Value::String(token.refresh_token.clone()),
        );
    }
    let _ = std::fs::write(
        &cred_file,
        serde_json::to_vec_pretty(&creds).unwrap_or_default(),
    );
    let _ = set_permissions(&cred_file);

    println!("Signed in to Capix Code.");
    Ok(ExitCode::SUCCESS)
}

fn access_token() -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())?;
    let refresh = entry
        .get_password()
        .map_err(|e| format!("not signed in; run `capix-code login` ({e})"))?;
    let token_result: Result<TokenResponse, String> = runtime()?.block_on(async {
        let response = reqwest::Client::new()
            .post(format!("{WEB_ORIGIN}/oauth/token"))
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.as_str()),
                ("client_id", "capix-code"),
            ])
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err("Capix session expired".into());
        }
        response
            .json::<TokenResponse>()
            .await
            .map_err(|e| e.to_string())
    });
    let token = match token_result {
        Ok(value) => value,
        Err(_) => {
            let _ = entry.delete_credential();
            return Err("session expired; run `capix-code login`".into());
        }
    };
    // Delete the old credential before setting the rotated one.
    let _ = entry.delete_credential();
    entry
        .set_password(&token.refresh_token)
        .map_err(|e| e.to_string())?;

    // Sync the rotated refresh token to the file-based bridge store.
    if let Ok(home) = std::env::var("HOME") {
        let cred_file = std::path::PathBuf::from(home).join(".capix-code/credentials.json");
        let mut creds: serde_json::Value = std::fs::read(&cred_file)
            .ok()
            .and_then(|d| serde_json::from_slice(&d).ok())
            .unwrap_or(serde_json::json!({}));
        if let Some(obj) = creds.as_object_mut() {
            obj.insert(
                format!("{KEYRING_SERVICE}:{KEYRING_ACCOUNT}"),
                serde_json::Value::String(token.refresh_token.clone()),
            );
        }
        let _ = std::fs::write(
            &cred_file,
            serde_json::to_vec_pretty(&creds).unwrap_or_default(),
        );
        let _ = set_permissions(&cred_file);
    }

    Ok(token.access_token)
}

fn api_get(path: &str) -> Result<ExitCode, String> {
    let token = access_token()?;
    let body = runtime()?.block_on(async {
        let response = reqwest::Client::new()
            .get(format!("{WEB_ORIGIN}{path}"))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("Capix API returned {status}: {text}"));
        }
        let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        serde_json::to_string_pretty(&json).map_err(|e| e.to_string())
    })?;
    println!("{body}");
    Ok(ExitCode::SUCCESS)
}

fn llm_run(prompt: &[String]) -> Result<ExitCode, String> {
    if prompt.is_empty() {
        return Err("a prompt is required".into());
    }
    let token = access_token()?;
    let request_id = format!(
        "capix-code-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    let payload = serde_json::json!({
        "model": "auto",
        "messages": [{"role": "user", "content": prompt.join(" ")}],
        "stream": false,
        "max_tokens": 256
    });
    let body: serde_json::Value = runtime()?.block_on(async {
        let response = reqwest::Client::new()
            .post(format!("{WEB_ORIGIN}/api/v1/chat/completions"))
            .bearer_auth(token)
            .header("idempotency-key", request_id)
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("Capix inference returned {status}: {text}"));
        }
        serde_json::from_str(&text).map_err(|e| e.to_string())
    })?;
    let content = body
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .or_else(|| body.get("output_text").and_then(|v| v.as_str()))
        .ok_or_else(|| "Capix inference response did not contain assistant content".to_string())?;
    println!("{content}");
    if let Some(receipt) = body.pointer("/capix/receiptId").and_then(|v| v.as_str()) {
        eprintln!("receipt: {receipt}");
    }
    Ok(ExitCode::SUCCESS)
}

/// Fetch `/api/v1/me` and display the project-scoped view (project id,
/// project name, role). The `account` command shows the same endpoint but
/// renders the raw JSON; `project` emphasises the project context.
fn project_info() -> Result<ExitCode, String> {
    let token = access_token()?;
    let me: serde_json::Value = runtime()?.block_on(async {
        let response = reqwest::Client::new()
            .get(format!("{WEB_ORIGIN}/api/v1/me"))
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("Capix API returned {status}: {text}"));
        }
        serde_json::from_str(&text).map_err(|e| e.to_string())
    })?;
    println!("Capix project context");
    println!("─────────────────────");
    let project_id = me
        .get("project_id")
        .or_else(|| me.pointer("/project/id"))
        .map(|v| v.to_string())
        .unwrap_or_else(|| "(not assigned)".to_string());
    println!("project_id : {project_id}");
    println!(
        "account    : {}",
        me.get("email")
            .or_else(|| me.get("handle"))
            .and_then(|v| v.as_str())
            .unwrap_or("(unknown)")
    );
    println!(
        "role       : {}",
        me.get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("(unknown)")
    );
    println!("\n(full response):");
    let body = serde_json::to_string_pretty(&me).map_err(|e| e.to_string())?;
    println!("{body}");
    Ok(ExitCode::SUCCESS)
}

/// Fetch `/api/v1/deployments` and render the `route_receipt_ids` from each
/// deployment as a receipts listing. There is no list-all-receipts endpoint,
/// so deployments are the source of receipt references.
fn receipts() -> Result<ExitCode, String> {
    let token = access_token()?;
    let deployments: serde_json::Value = runtime()?.block_on(async {
        let response = reqwest::Client::new()
            .get(format!("{WEB_ORIGIN}/api/v1/deployments"))
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("Capix API returned {status}: {text}"));
        }
        serde_json::from_str(&text).map_err(|e| e.to_string())
    })?;
    let entries = deployments
        .get("deployments")
        .and_then(|v| v.as_array())
        .or_else(|| deployments.as_array())
        .map(|v| v.as_slice())
        .unwrap_or(&[]);
    if entries.is_empty() {
        println!("No deployments — no route receipts.");
        return Ok(ExitCode::SUCCESS);
    }
    println!("Capix route receipts");
    println!("────────────────────");
    let mut count = 0usize;
    for dep in entries {
        let dep_id = dep
            .get("id")
            .map(|v| v.to_string())
            .unwrap_or_else(|| "(no id)".to_string());
        let ids = dep.get("route_receipt_ids").and_then(|v| v.as_array());
        if let Some(ids) = ids {
            for rid in ids {
                let rid_str = rid.as_str().map(|s| s.to_string()).unwrap_or_else(|| rid.to_string());
                println!("deployment {dep_id} → receipt {rid_str}");
                count += 1;
            }
        } else {
            println!("deployment {dep_id} → (no receipts)");
        }
    }
    println!("────────────────────");
    println!("{count} receipt(s) across {} deployment(s).", entries.len());
    Ok(ExitCode::SUCCESS)
}

fn unavailable(command: &str) -> Result<ExitCode, String> {
    Err(format!("`capix-code {command}` is not available in this release; use https://www.capix.network/cloud. No request was sent."))
}

fn auth_status() -> Result<ExitCode, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string());
    match entry.and_then(|e| e.get_password().map_err(|e| e.to_string())) {
        Ok(_) => {
            println!("Signed in to Capix Code.");
            if let Err(e) = api_get("/api/v1/me") {
                eprintln!("capix-code: could not fetch account info: {e}");
            }
            Ok(ExitCode::SUCCESS)
        }
        Err(_) => {
            println!("Not signed in. Run `capix-code login` to authenticate.");
            Ok(ExitCode::SUCCESS)
        }
    }
}

fn auth_reset() -> Result<ExitCode, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string());
    let _ = entry.and_then(|e| e.delete_credential().map_err(|e| e.to_string()));
    if let Ok(home) = std::env::var("HOME") {
        let cred_file = std::path::PathBuf::from(home).join(".capix-code/credentials.json");
        let _ = std::fs::remove_file(&cred_file);
    }
    println!("Capix Code credentials cleared. Run `capix-code login` to authenticate.");
    Ok(ExitCode::SUCCESS)
}

fn doctor(root: &Path) -> Result<(), String> {
    let required = [
        engine_path(root),
        root.join("runtime/src/plugin.ts"),
        root.join("runtime/src/native-bridge.ts"),
        root.join("runtime/src/capix-provider.ts"),
        root.join("runtime/src/broker.ts"),
        root.join("runtime/src/sandbox.ts"),
        root.join("runtime/src/ai-sdk-provider.ts"),
        root.join("runtime/node_modules/@capix/runtime-provider/package.json"),
        root.join("config/capix-defaults.json"),
    ];
    let missing: Vec<_> = required.iter().filter(|p| !p.exists()).collect();
    if !missing.is_empty() {
        return Err(format!(
            "installation incomplete; missing: {}",
            missing
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    println!(
        "Capix Code installation: OK\nroot: {}\nengine: {}",
        root.display(),
        engine_path(root).display()
    );
    Ok(())
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let root = match install_root() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("capix-code: {e}");
            return ExitCode::FAILURE;
        }
    };
    let result = match cli.command.unwrap_or(Command::Run) {
        Command::Doctor => doctor(&root).map(|_| ExitCode::SUCCESS),
        Command::Login => login(),
        Command::Logout => {
            let entry =
                keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string());
            match entry.and_then(|e| e.delete_credential().map_err(|e| e.to_string())) {
                Ok(_) => {
                    // Also clean up the file-based bridge store
                    if let Ok(home) = std::env::var("HOME") {
                        let cred_file =
                            std::path::PathBuf::from(home).join(".capix-code/credentials.json");
                        let _ = std::fs::remove_file(&cred_file);
                    }
                    println!("Signed out of Capix Code.");
                    Ok(ExitCode::SUCCESS)
                }
                Err(e) => Err(e),
            }
        }
        Command::Run => run_engine(&root, &cli.engine_args),
        Command::RunAgent => {
            let mut a = vec!["run".into()];
            a.extend(cli.engine_args);
            run_engine(&root, &a)
        }
        Command::LlmRun { prompt } => llm_run(&prompt),
        Command::GpuStatus => api_get("/api/v1/gpu"),
        Command::Account => api_get("/api/v1/me"),
        Command::Project => project_info(),
        Command::Status => api_get("/api/v1/billing"),
        Command::Attach { workspace_id } => unavailable(&format!("attach {workspace_id}")),
        Command::Operations => api_get("/api/v1/deployments"),
        Command::Receipts => receipts(),
        Command::Usage => api_get("/api/v1/billing"),
        Command::Invoices => api_get("/api/v1/invoices"),
        Command::Auth { subcommand } => match subcommand {
            AuthCommand::Status => auth_status(),
            AuthCommand::Reset => auth_reset(),
        },
    };
    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("capix-code: {e}");
            ExitCode::FAILURE
        }
    }
}
