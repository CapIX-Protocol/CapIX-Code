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
        "API_KEY",
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
        "CAPIX_API_KEY",
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

fn run_engine(root: &Path, args: &[String]) -> Result<ExitCode, String> {
    let engine = engine_path(root);
    if !engine.is_file() {
        return Err(format!("bundled engine missing: {}", engine.display()));
    }
    let runtime = root.join("runtime");
    let mut config: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("config/defaults.json"))
            .map_err(|e| format!("cannot read bundled Capix config: {e}"))?,
    )
    .map_err(|e| format!("invalid bundled Capix config: {e}"))?;
    config["plugin"] = serde_json::json!([runtime.join("src/plugin.ts").to_string_lossy()]);
    let config_content = serde_json::to_string(&config)
        .map_err(|e| format!("cannot encode bundled Capix config: {e}"))?;
    let mut command = ProcessCommand::new(&engine);
    command
        .args(args)
        .env("CAPIX_CODE_BUNDLED_RUNTIME", &runtime)
        .env("CAPIX_CODE_PLUGIN", runtime.join("src/plugin.ts"))
        .env(
            "CAPIX_CODE_DEFAULT_CONFIG",
            root.join("config/defaults.json"),
        )
        // The pinned engine's reviewed configuration contract. The content is
        // generated from our immutable bundled config and points to the exact
        // bundled plugin; no user-global predecessor configuration is loaded.
        .env("OPENCODE_CONFIG_CONTENT", config_content)
        .env("CAPIX_BASE_URL", "https://www.capix.network/api/v1")
        .env(
            "CAPIX_INFERENCE_BASE_URL",
            "https://www.capix.network/api/v1",
        );
    scrub_environment(&mut command);
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
    println!("Signed in to Capix Code.");
    Ok(ExitCode::SUCCESS)
}

fn access_token() -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|e| e.to_string())?;
    let refresh = entry
        .get_password()
        .map_err(|_| "not signed in; run `capix-code login`".to_string())?;
    let token: TokenResponse = runtime()?.block_on(async {
        reqwest::Client::new()
            .post(format!("{WEB_ORIGIN}/oauth/token"))
            .form(&[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.as_str()),
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
    entry
        .set_password(&token.refresh_token)
        .map_err(|e| e.to_string())?;
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

fn unavailable(command: &str) -> Result<ExitCode, String> {
    Err(format!("`capix-code {command}` is not available in this release; use https://www.capix.network/cloud. No request was sent."))
}

fn doctor(root: &Path) -> Result<(), String> {
    let required = [
        engine_path(root),
        root.join("runtime/src/plugin.ts"),
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
        Command::LlmRun { prompt } => {
            if prompt.is_empty() {
                Err("a prompt is required".into())
            } else {
                run_engine(
                    &root,
                    &[
                        vec!["run".into(), "--model".into(), "capix/auto".into()],
                        prompt,
                    ]
                    .concat(),
                )
            }
        }
        Command::GpuStatus => unavailable("gpu-status"),
        Command::Account => api_get("/api/v1/me"),
        Command::Project => api_get("/api/v1/me"),
        Command::Status => api_get("/api/v1/billing"),
        Command::Attach { workspace_id } => unavailable(&format!("attach {workspace_id}")),
        Command::Operations => unavailable("operations"),
        Command::Receipts => unavailable("receipts"),
        Command::Usage => api_get("/api/v1/billing"),
        Command::Invoices => api_get("/api/v1/invoices"),
    };
    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("capix-code: {e}");
            ExitCode::FAILURE
        }
    }
}
