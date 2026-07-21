mod format;
mod merkle_verify;
mod new_command;

use base64::Engine as _;
use clap::{Parser, Subcommand};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
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
    /// Launch the engine (default). With --auto, run a fully non-interactive
    /// autonomous task for A2A task machines.
    Run {
        /// Fully non-interactive autonomous run: all tool approvals are
        /// auto-accepted within a bounded sandbox; anything requiring a human
        /// becomes a typed skip in the transcript. Ends with a machine-readable
        /// CAPIX_RUN_RESULT JSON line.
        #[arg(long)]
        auto: bool,
        /// Smart-router quality tier sent as X-Capix-Quality-Tier on every
        /// inference call (fast|balanced|best).
        #[arg(long, value_parser = ["fast", "balanced", "best"], default_value = "balanced")]
        tier: String,
        /// Hard spend budget for the whole run, in USD (e.g. 5 or 2.50).
        /// Accounting uses integer micro-USD minor units from the receipt
        /// stream; the run stops cleanly with status spend_cap_reached at 100%.
        #[arg(long)]
        spend_cap: Option<String>,
        /// Task brief. Required with --auto.
        brief: Vec<String>,
    },
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
    Usage,
    Invoices,
    /// Authentication management
    Auth {
        #[command(subcommand)]
        subcommand: AuthCommand,
    },
    /// Settlement epoch + proof inspection (CPX ledger roots)
    Settlement {
        #[command(subcommand)]
        subcommand: SettlementCommand,
    },
    /// Route / usage receipt verification (local Merkle check)
    Receipts {
        #[command(subcommand)]
        subcommand: ReceiptsCommand,
    },
    /// Dev-token work receipts (capix:dev:work:v1)
    Dev {
        #[command(subcommand)]
        subcommand: DevCommand,
    },
    /// MCP server management
    Mcp {
        #[command(subcommand)]
        subcommand: McpCommand,
    },
    /// Start the agent runtime in ACP (Agent Communication Protocol) mode
    AgentRuntime {
        /// Run in stdio mode for IDE communication
        #[arg(long)]
        stdio: bool,
    },
    /// Agent management
    Agent {
        #[command(subcommand)]
        subcommand: AgentCommand,
    },
    /// Solana transaction inspection (read-only; never holds keypairs)
    Solana {
        #[command(subcommand)]
        subcommand: SolanaCommand,
    },
    /// Balance inspection with per-asset display (USDC / CPX)
    Balance {
        #[arg(long)]
        asset: Option<String>,
    },
    /// Billing history with per-asset filtering
    Billing {
        #[command(subcommand)]
        subcommand: BillingCommand,
    },
    /// Request a price quote (POST /api/v1/quotes)
    Quote {
        /// Prompt / usage description to quote.
        prompt: Vec<String>,
        /// Asset to quote in (USDC | CPX).
        #[arg(long)]
        asset: Option<String>,
        /// Model id to quote against (optional; server default otherwise).
        #[arg(long)]
        model: Option<String>,
    },
    /// List available Capix models
    Models,
    /// List compute instances (deployments)
    Instances,
    /// Deploy a one-click LLM
    Deploy {
        #[command(subcommand)]
        subcommand: DeployCommand,
    },
    /// Train a specialized model (POST /api/v1/models/train)
    Train {
        /// Base model id to fine-tune
        #[arg(long)]
        model: String,
        /// Path to the dataset file (.jsonl, .parquet, .csv, or text)
        #[arg(long)]
        dataset: String,
        /// Specialization prompt describing the behavior to train for
        #[arg(long)]
        specialize: String,
    },
    /// Destroy a deployment or GPU asset
    Destroy {
        /// Deployment or saga ID to destroy
        id: String,
    },
    /// Scaffold a new project from a template (capix new)
    New {
        /// Template id (omit to list available templates)
        template: Option<String>,
        /// Project name / target directory (defaults to the template id)
        name: Option<String>,
        /// Deploy after scaffolding (requires a pushed git remote)
        #[arg(long)]
        deploy: bool,
    },
}

#[derive(Subcommand)]
enum SettlementCommand {
    /// Current settlement epoch status (root, cluster, paused flag)
    Status,
    /// List recent settlement epochs
    Epochs,
    /// Fetch and verify a Merkle balance proof locally
    ProofBalance,
    /// Fetch and verify a Merkle usage proof for a receipt
    ProofUsage { receipt_id: String },
}

#[derive(Subcommand)]
enum ReceiptsCommand {
    /// List route receipts from deployments
    List,
    /// Verify a receipt's Merkle proof locally (no API trust for the check)
    Verify { receipt_id: String },
}

#[derive(Subcommand)]
enum DevCommand {
    /// Fetch and display a dev-token work proof
    Proof { award_id: String },
}

#[derive(Subcommand)]
enum SolanaCommand {
    /// Display a Solana transaction by signature (read-only)
    Transaction { signature: String },
}

#[derive(Subcommand)]
enum BillingCommand {
    /// Billing history with optional CPX/USDC filtering
    History {
        #[arg(long)]
        asset: Option<String>,
    },
}

#[derive(Subcommand)]
enum DeployCommand {
    /// Deploy a one-click LLM (POST /api/v1/llm/deploy)
    Llm {
        /// Model ID to deploy
        #[arg(long)]
        model: String,
        /// Quote ID for this deployment
        #[arg(long)]
        quote: String,
    },
}

#[derive(Subcommand)]
enum AuthCommand {
    /// Show current authentication status
    Status,
    /// Clear all credentials and force re-authentication
    Reset,
    /// Print a fresh short-lived access token as JSON for trusted Capix
    /// clients (IDE, MCP) that broker credentials through this CLI
    Token,
}

#[derive(Subcommand)]
enum AgentCommand {
    /// List available specialist agents
    List,
    /// List active sessions
    Sessions,
    /// Spawn a specialist agent
    Spawn {
        /// Agent role: explore, implement, test, review, security, deploy
        role: String,
        /// Task description
        #[arg(short, long)]
        task: String,
    },
    /// Resume a session
    Resume { session_id: String },
    /// Cancel a running session
    Cancel { session_id: String },
}

#[derive(Subcommand)]
enum McpCommand {
    /// Check MCP server status
    Status,
    /// Run MCP diagnostics
    Doctor,
    /// Restart the MCP server
    Reconnect,
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
/// 2. `capix-code-2.3.1` (package.json version baked at compile time)
fn release_id() -> String {
    std::env::var("CAPIX_RELEASE_ID").unwrap_or_else(|_| "capix-code-2.3.10".to_string())
}

/// Configuration for `capix-code run` produced by the CLI surface.
///
/// `tier` is always set (default balanced) and exported as
/// `CAPIX_QUALITY_TIER` so the provider layer stamps `X-Capix-Quality-Tier`
/// on every inference call. `auto` switches the engine invocation to the
/// bundled autonomous driver (`runtime/src/auto-run.ts`), which enforces the
/// approval sandbox and the spend cap and prints the machine-readable result
/// line.
struct RunConfig {
    auto: bool,
    tier: String,
    brief: String,
    /// USD spend cap converted to integer micro-USD minor units (scale 6).
    spend_cap_minor: Option<String>,
}

impl RunConfig {
    /// Plain engine launch (TUI or passthrough) with the default tier.
    fn default_interactive() -> Self {
        RunConfig {
            auto: false,
            tier: "balanced".to_string(),
            brief: String::new(),
            spend_cap_minor: None,
        }
    }

    /// The subcommand used when `capix-code` is invoked with no subcommand.
    fn default_command() -> Command {
        Command::Run {
            auto: false,
            tier: "balanced".to_string(),
            spend_cap: None,
            brief: Vec::new(),
        }
    }
}

/// Convert a decimal USD amount ("5", "2.50", "0.000001") to integer
/// micro-USD minor units (scale 6) as a decimal string. Rejects anything
/// that is not a non-negative decimal with at most 6 fractional digits —
/// spend-cap accounting must never round a customer's budget.
fn parse_spend_cap_minor(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("spend cap must be a non-negative USD amount".into());
    }
    if trimmed.starts_with('-') || trimmed.starts_with('+') {
        return Err(format!("spend cap must be a plain non-negative decimal: {raw}"));
    }
    let (dollars, fraction) = match trimmed.split_once('.') {
        Some((d, f)) => (d, f),
        None => (trimmed, ""),
    };
    if dollars.is_empty() && fraction.is_empty() {
        return Err(format!("invalid spend cap: {raw}"));
    }
    if !dollars.chars().all(|c| c.is_ascii_digit())
        || !fraction.chars().all(|c| c.is_ascii_digit())
    {
        return Err(format!("invalid spend cap: {raw}"));
    }
    if fraction.len() > 6 {
        return Err(format!(
            "spend cap supports at most 6 fractional digits (micro-USD): {raw}"
        ));
    }
    let dollars = if dollars.is_empty() { "0" } else { dollars };
    let whole: u128 = dollars
        .parse()
        .map_err(|_| format!("invalid spend cap: {raw}"))?;
    let frac_padded = format!("{fraction:0<6}");
    let frac: u128 = if frac_padded.is_empty() {
        0
    } else {
        frac_padded
            .parse()
            .map_err(|_| format!("invalid spend cap: {raw}"))?
    };
    let minor = whole
        .checked_mul(1_000_000)
        .and_then(|w| w.checked_add(frac))
        .ok_or_else(|| format!("spend cap too large: {raw}"))?;
    if minor > u64::MAX as u128 {
        return Err(format!("spend cap too large: {raw}"));
    }
    Ok(minor.to_string())
}

fn run_engine(root: &Path, args: &[String], run: RunConfig) -> Result<ExitCode, String> {
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
        let client = http_client()?;
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
            "limit": {"context": 128000, "output": 64000},
            "api": {
                "url": "https://www.capix.network/api/v1",
                "npm": "@capix/runtime-provider"
            }
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
            // Per-million-token USD pricing so the TUI footer can render real
            // session spend (the engine derives cost from tokens × price).
            let pricing = model.get("pricing");
            let price = |names: &[&str]| -> f64 {
                pricing
                    .and_then(|p| {
                        names
                            .iter()
                            .find_map(|n| p.get(*n).and_then(|v| v.as_f64()))
                    })
                    .unwrap_or(0.0)
            };
            // Provider model keys are relative to `capix/`. Keeping the
            // canonical `capix/auto` id here creates a duplicate beside the
            // built-in `auto` entry in the model picker.
            let engine_id = id.strip_prefix("capix/").unwrap_or(id);
            engine_models.insert(
                engine_id.to_string(),
                serde_json::json!({
                    "name": format!("Capix · {label}"),
                    "limit": {"context": context, "output": context.min(32768)},
                    "cost": {
                        "input": price(&["input", "inputPerMillionTokens"]),
                        "output": price(&["output", "outputPerMillionTokens"]),
                        "cache_read": price(&["cache_read", "cacheRead"]),
                        "cache_write": price(&["cache_write", "cacheWrite"])
                    },
                    "api": {
                        "url": "https://www.capix.network/api/v1",
                        "npm": "@capix/runtime-provider"
                    }
                }),
            );
        }
    }
    config["provider"]["capix"]["models"] = serde_json::Value::Object(engine_models);
    let provider_entry = runtime_dir.join("packages/runtime-provider/src/index.ts");
    let provider_path = provider_entry.to_string_lossy().replace('\\', "/");
    let provider_url = if cfg!(windows) {
        format!("file:///{}", provider_path)
    } else {
        format!("file://{}", provider_path)
    };
    config["provider"]["capix"]["npm"] = serde_json::json!(provider_url);
    config["enabled_providers"] = serde_json::json!(["capix"]);
    config["model"] = serde_json::json!("capix/auto");
    config["lsp"] = serde_json::json!(true);
    config["plugin"] = serde_json::json!([
        runtime_dir.join("src/native-bridge.ts").to_string_lossy(),
        runtime_dir.join("src/plugin.ts").to_string_lossy()
    ]);
    config["mcp"]["capix"]["command"] = serde_json::json!([
        "node",
        root.join("mcp/capix-mcp.js").to_string_lossy(),
        "server",
        "--stdio"
    ]);
    config["mcp"]["capix"]["enabled"] = serde_json::json!(true);
    let config_content = serde_json::to_string(&config)
        .map_err(|e| format!("cannot encode bundled Capix config: {e}"))?;
    let config_file = root.join("config/runtime-config.json");
    let _ = std::fs::write(&config_file, &config_content);
    let available = canonical
        .1
        .pointer("/balances/USDC/available")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    eprintln!(
        "Capix connected · USDC balance {} · model Capix Auto",
        available
    );
    let engine_args: Vec<String> = if run.auto {
        // Autonomous mode: instead of the interactive engine entrypoint, eval
        // the bundled autonomous driver. The driver enforces the approval
        // sandbox and the spend cap and prints the machine-readable
        // CAPIX_RUN_RESULT line; the brief travels via the environment so no
        // shell quoting is involved.
        let auto_entry = runtime_dir.join("src/auto-run.ts");
        vec![
            "--eval".to_string(),
            format!(
                "import('{}').then(m=>m.autoRunMain())",
                auto_entry.display()
            ),
        ]
    } else if !run.brief.is_empty() {
        // Non-interactive engine run with the engine's own approval flow.
        let mut a = vec!["run".to_string(), run.brief.clone()];
        a.extend(args.iter().cloned());
        a
    } else {
        args.to_vec()
    };
    command
        .args(&engine_args)
        .env("CAPIX_CODE_BUNDLED_RUNTIME", &runtime_dir)
        .env("CAPIX_CODE_PLUGIN", runtime_dir.join("src/plugin.ts"))
        .env(
            "CAPIX_CODE_DEFAULT_CONFIG",
            root.join("config/defaults.json"),
        )
        .env("CAPIX_CODE_CONFIG_CONTENT", config_content.clone())
        .env("OPENCODE_CONFIG_CONTENT", config_content.clone())
        .env("OPENCODE_CONFIG", config_file)
        .env("CAPIX_BASE_URL", "https://www.capix.network/api/v1")
        .env(
            "CAPIX_INFERENCE_BASE_URL",
            "https://www.capix.network/api/v1",
        )
        .env("CAPIX_API_KEY", access)
        .env("CAPIX_QUALITY_TIER", &run.tier)
        .env("CAPIX_RELEASE_ID", release_id())
        .env("CAPIX_CODE_RELEASE_ID", release_id());
    if run.auto {
        command
            .env("CAPIX_AUTONOMOUS", "1")
            .env("CAPIX_AUTONOMOUS_BRIEF", &run.brief);
        if let Some(minor) = &run.spend_cap_minor {
            command.env("CAPIX_SPEND_CAP_USD_MINOR", minor);
        }
    }
    let status = command
        .status()
        .map_err(|e| format!("failed to launch engine: {e}"))?;
    Ok(ExitCode::from(status.code().unwrap_or(1) as u8))
}

const WEB_ORIGIN: &str = "https://www.capix.network";
const KEYRING_SERVICE: &str = "capix-code";
const KEYRING_ACCOUNT: &str = "oauth-refresh-token";

fn keyring_get_password() -> Result<String, String> {
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(|error| error.to_string())
            .and_then(|entry| entry.get_password().map_err(|error| error.to_string()));
        let _ = send.send(result);
    });
    receive.recv_timeout(Duration::from_secs(15)).map_err(|_| {
        "OS credential store approval timed out; run `capix-code login` or set CAPIX_API_KEY"
            .to_string()
    })?
}

fn keyring_set_password(value: String) -> Result<(), String> {
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(|error| error.to_string())
            .and_then(|entry| {
                entry
                    .set_password(&value)
                    .map_err(|error| error.to_string())
            });
        let _ = send.send(result);
    });
    receive
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| "OS credential store approval timed out".to_string())?
}

fn keyring_delete_password() -> Result<(), String> {
    let (send, receive) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(|error| error.to_string())
            .and_then(|entry| entry.delete_credential().map_err(|error| error.to_string()));
        let _ = send.send(result);
    });
    receive
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| "OS credential store approval timed out".to_string())?
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
}

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Runtime::new().map_err(|e| format!("cannot start secure network runtime: {e}"))
}

/// Build the bounded HTTPS client used by every customer-facing API path.
/// Commands must fail clearly when the network is unavailable; they must never
/// leave a terminal or release smoke test waiting indefinitely.
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("cannot initialize secure HTTP client: {e}"))
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
        http_client()?
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
    keyring_set_password(token.refresh_token.clone())
        .map_err(|e| format!("OS credential store rejected token: {e}"))?;
    remove_legacy_credentials_file();

    println!("Signed in to Capix Code.");
    Ok(ExitCode::SUCCESS)
}

fn access_token() -> Result<String, String> {
    // Project API keys are a supported noninteractive credential for CI,
    // headless hosts and unsigned preview builds where macOS may otherwise
    // display a Keychain ACL prompt. They are never persisted by the launcher.
    if let Ok(api_key) = std::env::var("CAPIX_API_KEY") {
        let api_key = api_key.trim();
        if !api_key.is_empty() {
            return Ok(api_key.to_string());
        }
    }
    // One-time migration for pre-2.2 installs. The plaintext compatibility
    // file is deleted immediately after importing the refresh token.
    let refresh = match keyring_get_password() {
        Ok(token) => token,
        Err(keyring_error) => match read_refresh_from_file() {
            Ok(token) => {
                keyring_set_password(token.clone()).map_err(|e| {
                    format!("could not migrate session to the OS credential store: {e}")
                })?;
                remove_legacy_credentials_file();
                token
            }
            Err(_) => {
                return Err(format!(
                    "not signed in; run `capix-code login` ({keyring_error})"
                ))
            }
        },
    };
    let token_result: Result<TokenResponse, String> = runtime()?.block_on(async {
        let response = http_client()?
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
            let _ = keyring_delete_password();
            return Err("session expired; run `capix-code login`".into());
        }
    };
    // `set_password` atomically replaces the existing credential. Never
    // delete the last known-good refresh token before the rotated value has
    // been durably accepted by the OS credential store.
    keyring_set_password(token.refresh_token.clone())
        .map_err(|error| format!("could not rotate the OS credential: {error}"))?;

    Ok(token.access_token)
}

fn remove_legacy_credentials_file() {
    if let Ok(home) = std::env::var("HOME") {
        let path = std::path::PathBuf::from(home).join(".capix-code/credentials.json");
        let _ = std::fs::remove_file(path);
    }
}

fn read_refresh_from_file() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let cred_file = std::path::PathBuf::from(home).join(".capix-code/credentials.json");
    let creds_bytes = std::fs::read(&cred_file)
        .map_err(|e| format!("not signed in; run `capix-code login` ({e})"))?;
    let creds: serde_json::Value = serde_json::from_slice(&creds_bytes)
        .map_err(|e| format!("invalid credentials file: {e}"))?;
    let key = format!("{}:{}", KEYRING_SERVICE, KEYRING_ACCOUNT);
    creds
        .get(&key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "not signed in; run `capix-code login`".to_string())
}

fn api_get(path: &str) -> Result<ExitCode, String> {
    let token = access_token()?;
    let body = runtime()?.block_on(async {
        let response = http_client()?
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

/// Submit a fine-tuning job. The dataset is referenced by `file://` URI with a
/// SHA-256 fingerprint; monitoring and catalog registration are handled by the
/// Capix Code plugin (`capix_train` tool), not the launcher.
fn train(model: &str, dataset: &str, specialize: &str) -> Result<ExitCode, String> {
    let dataset_path = std::fs::canonicalize(dataset)
        .map_err(|e| format!("cannot resolve dataset path {dataset}: {e}"))?;
    let bytes = std::fs::read(&dataset_path)
        .map_err(|e| format!("cannot read dataset {}: {e}", dataset_path.display()))?;
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let lower = dataset_path.to_string_lossy().to_lowercase();
    let format = if lower.ends_with(".jsonl") {
        "jsonl"
    } else if lower.ends_with(".parquet") {
        "parquet"
    } else if lower.ends_with(".csv") {
        "csv"
    } else {
        "text"
    };
    let token = access_token()?;
    let idempotency_key = format!("capix-code-train-{}", uuid());
    let body = runtime()?.block_on(async {
        let response = http_client()?
            .post(format!("{WEB_ORIGIN}/api/v1/models/train"))
            .bearer_auth(token)
            .header("idempotency-key", &idempotency_key)
            .header("content-type", "application/json")
            .body(
                serde_json::to_string(&serde_json::json!({
                    "baseModel": model,
                    "dataset": {
                        "uri": format!("file://{}", dataset_path.display()),
                        "format": format,
                        "sha256": sha256,
                        "bytes": bytes.len().to_string(),
                    },
                    "specializationPrompt": specialize,
                }))
                .map_err(|e| e.to_string())?,
            )
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("Capix train returned {status}: {text}"));
        }
        serde_json::to_string_pretty(
            &serde_json::from_str::<serde_json::Value>(&text).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    })?;
    println!("{body}");
    Ok(ExitCode::SUCCESS)
}

fn deploy_llm(model: &str, quote_id: &str) -> Result<ExitCode, String> {
    let token = access_token()?;
    let idempotency_key = format!("capix-code-deploy-{}", uuid());
    let body = runtime()?.block_on(async {
        let response = http_client()?
            .post(format!("{WEB_ORIGIN}/api/v1/llm/deploy"))
            .bearer_auth(token)
            .header("idempotency-key", &idempotency_key)
            .header("content-type", "application/json")
            .body(
                serde_json::to_string(&serde_json::json!({
                    "modelId": model,
                    "quoteId": quote_id,
                }))
                .map_err(|e| e.to_string())?,
            )
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("Capix deploy returned {status}: {text}"));
        }
        serde_json::to_string_pretty(
            &serde_json::from_str::<serde_json::Value>(&text).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    })?;
    println!("{body}");
    Ok(ExitCode::SUCCESS)
}

fn destroy(id: &str) -> Result<ExitCode, String> {
    let token = access_token()?;
    let idempotency_key = format!("capix-code-destroy-{}", uuid());
    let body = runtime()?.block_on(async {
        let endpoint = if id.starts_with("gpu_") {
            format!("{WEB_ORIGIN}/api/v1/gpu/{}", id)
        } else {
            format!("{WEB_ORIGIN}/api/v1/deployments/{}", id)
        };
        let response = http_client()?
            .delete(&endpoint)
            .bearer_auth(token)
            .header("idempotency-key", &idempotency_key)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("Capix destroy returned {status}: {text}"));
        }
        serde_json::to_string_pretty(
            &serde_json::from_str::<serde_json::Value>(&text).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    })?;
    println!("{body}");
    Ok(ExitCode::SUCCESS)
}

fn uuid() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

fn llm_run(prompt: &[String]) -> Result<ExitCode, String> {
    use std::io::{self, Write};

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
        "model": "capix/auto",
        "messages": [{"role": "user", "content": prompt.join(" ")}],
        "stream": true,
        "maxTokens": 4096
    });
    runtime()?.block_on(async {
        let mut response = http_client()?
            .post(format!("{WEB_ORIGIN}/api/v1/inference/chat/completions"))
            .bearer_auth(token)
            .header("idempotency-key", request_id)
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.map_err(|e| e.to_string())?;
            return Err(format!("Capix inference returned {status}: {text}"));
        }
        let mut buf: Vec<u8> = Vec::new();
        let stdout = io::stdout();
        let mut out = stdout.lock();
        let mut receipt: Option<String> = None;
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            buf.extend_from_slice(&chunk);
            while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                let mut line_bytes: Vec<u8> = buf.drain(..=pos).collect();
                line_bytes.pop();
                if line_bytes.last() == Some(&b'\r') {
                    line_bytes.pop();
                }
                if line_bytes.is_empty() {
                    continue;
                }
                let line = std::str::from_utf8(&line_bytes).map_err(|e| e.to_string())?;
                let data = match line
                    .strip_prefix("data: ")
                    .or_else(|| line.strip_prefix("data:"))
                {
                    Some(d) => d,
                    None => continue,
                };
                if data.trim() == "[DONE]" {
                    writeln!(out).map_err(|e| e.to_string())?;
                    out.flush().map_err(|e| e.to_string())?;
                    if let Some(r) = &receipt {
                        eprintln!("receipt: {r}");
                    }
                    return Ok(());
                }
                let v: serde_json::Value = serde_json::from_str(data).map_err(|e| e.to_string())?;
                if let Some(r) = v
                    .get("receiptId")
                    .or_else(|| v.pointer("/capix/receiptId"))
                    .and_then(|c| c.as_str())
                {
                    receipt = Some(r.to_string());
                }
                if v.get("type").and_then(|c| c.as_str()) == Some("capix.route") {
                    let model = v
                        .get("modelCapability")
                        .and_then(|c| c.as_str())
                        .unwrap_or("Capix Auto");
                    let region = v.get("region").and_then(|c| c.as_str()).unwrap_or("global");
                    writeln!(out, "\n[routed to {} in {}]\n", model, region)
                        .map_err(|e| e.to_string())?;
                    out.flush().map_err(|e| e.to_string())?;
                }
                if v.get("type").and_then(|c| c.as_str()) == Some("capix.usage") {
                    let input_t = v.get("inputUnits").and_then(|c| c.as_u64()).unwrap_or(0);
                    let output_t = v.get("outputUnits").and_then(|c| c.as_u64()).unwrap_or(0);
                    let cost = v
                        .pointer("/provisionalCost/amount")
                        .and_then(|c| c.as_str())
                        .unwrap_or("0");
                    let scale = v
                        .pointer("/provisionalCost/scale")
                        .and_then(|c| c.as_u64())
                        .unwrap_or(0)
                        .min(18) as u8;
                    let cost = format::format_scaled_amount(cost, scale)
                        .unwrap_or_else(|| "unknown".to_string());
                    let asset = v
                        .pointer("/provisionalCost/asset")
                        .and_then(|c| c.as_str())
                        .unwrap_or("USDC");
                    writeln!(
                        out,
                        "\n[usage: {} input, {} output, cost: {} {}]\n",
                        input_t, output_t, cost, asset
                    )
                    .map_err(|e| e.to_string())?;
                    out.flush().map_err(|e| e.to_string())?;
                }
                if v.get("type").and_then(|c| c.as_str()) == Some("capix.error") {
                    let message = v
                        .get("message")
                        .and_then(|c| c.as_str())
                        .unwrap_or("Capix inference failed");
                    return Err(message.to_string());
                }
                if let Some(content) = v.get("content").and_then(|c| c.as_str()).or_else(|| {
                    v.pointer("/choices/0/delta/content")
                        .and_then(|c| c.as_str())
                }) {
                    write!(out, "{content}").map_err(|e| e.to_string())?;
                    out.flush().map_err(|e| e.to_string())?;
                }
            }
        }
        writeln!(out).map_err(|e| e.to_string())?;
        out.flush().map_err(|e| e.to_string())?;
        if let Some(r) = &receipt {
            eprintln!("receipt: {r}");
        }
        Ok::<(), String>(())
    })?;
    Ok(ExitCode::SUCCESS)
}

/// Fetch `/api/v1/me` and display the project-scoped view (project id,
/// project name, role). The `account` command shows the same endpoint but
/// renders the raw JSON; `project` emphasises the project context.
fn project_info() -> Result<ExitCode, String> {
    let token = access_token()?;
    let me: serde_json::Value = runtime()?.block_on(async {
        let response = http_client()?
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
        let response = http_client()?
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
                let rid_str = rid
                    .as_str()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| rid.to_string());
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

/// Resolve the CPX mint + decimals from env (never prompts for keys).
/// Returns `(mint_hex, decimals)` for local display only.
fn cpx_config() -> (Option<String>, u8) {
    let mint = std::env::var("CAPIX_CPX_MINT")
        .ok()
        .filter(|s| !s.is_empty());
    let decimals = std::env::var("CAPIX_CPX_DECIMALS")
        .ok()
        .and_then(|s| s.parse::<u8>().ok())
        .unwrap_or(9);
    (mint, decimals)
}

/// Solana cluster for explorer URLs (env-overridable; default devnet).
fn solana_cluster() -> &'static str {
    match std::env::var("CAPIX_SOLANA_CLUSTER").as_deref() {
        Ok("mainnet-beta") => "mainnet-beta",
        Ok("testnet") => "testnet",
        _ => "devnet",
    }
}

/// Fetch JSON from the Capix API and return the parsed `serde_json::Value`.
/// Reused by settlement / proof / receipt commands that need to POST-process
/// the body rather than just print it.
fn api_get_json(path: &str) -> Result<serde_json::Value, String> {
    let token = access_token()?;
    runtime()?.block_on(async {
        let response = http_client()?
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
        serde_json::from_str(&text).map_err(|e| e.to_string())
    })
}

/// Fetch a proof package + expected root from the API, then VERIFY LOCALLY.
/// The Capix API is trusted only to deliver the proof package; the
/// cryptographic check (recompute leaf hash, walk sibling path, compare root)
/// is performed in-process by `merkle_verify::verify_locally`.
fn verify_receipt_proof(receipt_id: &str, category: &str) -> Result<ExitCode, String> {
    let proof_json = api_get_json(&format!("/api/v1/receipts/{receipt_id}/proof"))?;
    // The proof package carries its expected root (either inline or adjacent).
    // Prefer an explicit `root` field, then fall back to a sibling `expected_root`.
    let root_hex = proof_json
        .get("root")
        .or_else(|| proof_json.get("expected_root"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            "proof package did not include a Merkle root; cannot verify locally".to_string()
        })?;
    // The proof object itself may be nested under `proof` or be the top-level.
    let proof_obj = proof_json.get("proof").unwrap_or(&proof_json);
    let outcome = merkle_verify::verify_locally(proof_obj, root_hex, category)
        .ok_or_else(|| "malformed proof package: could not decode proof structure".to_string())?;
    println!("Capix receipt proof verification");
    println!("─────────────────────────────────");
    println!("receipt_id   : {receipt_id}");
    println!("leaf_category: {}", outcome.leaf_category);
    println!("root         : {}", outcome.root_hex);
    println!("verified     : {}", outcome.verified);
    // Optional Ed25519 route-receipt signature check. The proof package may
    // carry a `signature` (64-byte hex) + `signing_pubkey` (32-byte hex)
    // over the canonical receipt bytes. This is opt-in: when absent we skip
    // silently; when present we verify it locally with no API trust.
    let sig_hex = proof_json
        .get("signature")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let pk_hex = proof_json
        .get("signing_pubkey")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !sig_hex.is_empty() || !pk_hex.is_empty() {
        let msg = receipt_canonical_message(receipt_id, &outcome.root_hex);
        match verify_receipt_signature(&msg, pk_hex, sig_hex) {
            Ok(true) => println!("signature    : verified (Ed25519)"),
            Ok(false) => {
                println!("signature    : not present or did not verify");
            }
            Err(e) => println!("signature    : error ({e})"),
        }
    }
    if outcome.verified {
        println!("\nThe Merkle proof recomputes to the published root.");
        println!("The Capix API was used only to fetch the proof package; the");
        println!("cryptographic check ran locally.");
    } else {
        eprintln!("\nThe proof did NOT verify against the published root.");
    }
    if !outcome.verified {
        return Ok(ExitCode::from(1));
    }
    Ok(ExitCode::SUCCESS)
}

/// Verify an optional Ed25519 signature over a route receipt.
///
/// `message`    — the canonical message bytes the signature covers.
/// `pubkey_hex` — 32-byte Ed25519 verifying key as lowercase hex.
/// `signature_hex` — 64-byte Ed25519 signature as lowercase hex.
///
/// Returns `Ok(true)` only when the signature is present and valid;
/// `Ok(false)` when no signature is supplied (opt-in); `Err` on decode error.
fn verify_receipt_signature(
    message: &[u8],
    pubkey_hex: &str,
    signature_hex: &str,
) -> Result<bool, String> {
    if pubkey_hex.is_empty() || signature_hex.is_empty() {
        return Ok(false);
    }
    let pk_bytes =
        hex_decode_sig(pubkey_hex).ok_or_else(|| "invalid Ed25519 public key hex".to_string())?;
    let sig_bytes =
        hex_decode_sig(signature_hex).ok_or_else(|| "invalid Ed25519 signature hex".to_string())?;
    if pk_bytes.len() != 32 {
        return Err(format!(
            "Ed25519 public key must be 32 bytes (got {})",
            pk_bytes.len()
        ));
    }
    if sig_bytes.len() != 64 {
        return Err(format!(
            "Ed25519 signature must be 64 bytes (got {})",
            sig_bytes.len()
        ));
    }
    let mut pk_arr = [0u8; 32];
    pk_arr.copy_from_slice(&pk_bytes);
    let mut sig_arr = [0u8; 64];
    sig_arr.copy_from_slice(&sig_bytes);
    let verifying_key =
        VerifyingKey::from_bytes(&pk_arr).map_err(|e| format!("invalid Ed25519 key: {e}"))?;
    let signature = Signature::from_bytes(&sig_arr);
    match verifying_key.verify(message, &signature) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}

/// Minimal hex decoder for signature/key material (no external hex crate).
fn hex_decode_sig(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    let nibble = |c: u8| -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    };
    let bytes = hex.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = nibble(bytes[i])?;
        let lo = nibble(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Some(out)
}

/// Build the canonical message bytes an Ed25519 route-receipt signature
/// covers: `receipt_id ‖ ":" ‖ root_hex`. This is a stable, secret-free
/// canonicalisation so a third party can independently re-verify.
fn receipt_canonical_message(receipt_id: &str, root_hex: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(receipt_id.len() + 1 + root_hex.len());
    out.extend_from_slice(receipt_id.as_bytes());
    out.push(b':');
    out.extend_from_slice(root_hex.as_bytes());
    out
}

/// Settlement status — renders epoch / root / cluster / paused.
fn settlement_status() -> Result<ExitCode, String> {
    let json = api_get_json("/api/v1/settlement/status")?;
    println!("Capix settlement status");
    println!("───────────────────────");
    let epoch = json
        .get("epoch")
        .map(|v| v.to_string())
        .unwrap_or_else(|| "(unknown)".to_string());
    let root = json
        .get("root")
        .and_then(|v| v.as_str())
        .unwrap_or("(unknown)");
    let cluster = json
        .get("cluster")
        .and_then(|v| v.as_str())
        .unwrap_or("(unknown)");
    let paused = json
        .get("paused")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    println!("epoch  : {epoch}");
    println!("root   : {root}");
    println!("cluster: {cluster}");
    println!("paused : {paused}");
    println!("\nCPX is {}", format::CPX_BURN_NOTICE);
    Ok(ExitCode::SUCCESS)
}

/// Settlement epochs — list recent settlement epochs.
fn settlement_epochs() -> Result<ExitCode, String> {
    api_get("/api/v1/settlement/epochs")
}

/// Balance proof — fetch + verify a Merkle account-balance proof locally.
fn settlement_proof_balance() -> Result<ExitCode, String> {
    let payload = api_get_json("/api/v1/settlement/balance-proof")?;
    let root_hex = payload
        .get("root")
        .or_else(|| payload.get("expected_root"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "balance-proof response missing root".to_string())?;
    let proof_obj = payload.get("proof").unwrap_or(&payload);
    let outcome =
        merkle_verify::verify_locally(proof_obj, root_hex, merkle_verify::ROUTE_RECEIPT_CATEGORY)
            .or_else(|| {
                // Balance proofs use the account category; retry with it.
                merkle_verify::verify_locally(proof_obj, root_hex, "capix:settlement:account:v1")
            })
            .ok_or_else(|| "malformed balance proof package".to_string())?;
    println!("Capix balance proof verification");
    println!("─────────────────────────────────");
    println!("root         : {}", outcome.root_hex);
    println!("leaf_category: {}", outcome.leaf_category);
    println!("verified     : {}", outcome.verified);
    if outcome.verified {
        println!("\nLocal Merkle recomputation matches the published root.");
    } else {
        eprintln!("\nBalance proof did NOT verify locally.");
        return Ok(ExitCode::from(1));
    }
    Ok(ExitCode::SUCCESS)
}

/// Usage proof — fetch + verify a Merkle usage proof for a receipt.
fn settlement_proof_usage(receipt_id: &str) -> Result<ExitCode, String> {
    let payload = api_get_json(&format!("/api/v1/settlement/usage-proof/{receipt_id}"))?;
    let root_hex = payload
        .get("root")
        .or_else(|| payload.get("expected_root"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "usage-proof response missing root".to_string())?;
    let proof_obj = payload.get("proof").unwrap_or(&payload);
    let outcome = merkle_verify::verify_locally(proof_obj, root_hex, "capix:settlement:usage:v1")
        .ok_or_else(|| "malformed usage proof package".to_string())?;
    println!("Capix usage proof verification");
    println!("─────────────────────────────────");
    println!("receipt_id   : {receipt_id}");
    println!("root         : {}", outcome.root_hex);
    println!("leaf_category: {}", outcome.leaf_category);
    println!("verified     : {}", outcome.verified);
    if outcome.verified {
        println!("\nLocal Merkle recomputation matches the published root.");
    } else {
        eprintln!("\nUsage proof did NOT verify locally.");
        return Ok(ExitCode::from(1));
    }
    Ok(ExitCode::SUCCESS)
}

/// Dev-token work proof — fetch + display (capix:dev:work:v1).
fn dev_proof(award_id: &str) -> Result<ExitCode, String> {
    let json = api_get_json(&format!("/api/v1/dev-tokens/proof/{award_id}"))?;
    println!("Capix dev-token work proof");
    println!("───────────────────────────");
    println!("award_id: {award_id}");
    if let Some(cat) = json.get("leaf_category").and_then(|v| v.as_str()) {
        println!("category: {cat}");
    }
    if let Some(root) = json
        .get("root")
        .or_else(|| json.get("expected_root"))
        .and_then(|v| v.as_str())
    {
        println!("root    : {root}");
        // Best-effort local verification if a proof body is present.
        if let Some(proof_obj) = json.get("proof") {
            match merkle_verify::verify_locally(proof_obj, root, "capix:dev:work:v1") {
                Some(outcome) => println!("verified : {}", outcome.verified),
                None => println!("verified : (malformed proof body — cannot decode)"),
            }
        }
    }
    println!("\n(full proof package):");
    let body = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;
    println!("{body}");
    Ok(ExitCode::SUCCESS)
}

/// Solana transaction inspection — read-only. Validates the signature is a
/// well-formed base58 string and formats the explorer URL. Never holds a
/// keypair and never prompts for private keys.
fn solana_transaction(signature: &str) -> Result<ExitCode, String> {
    if signature.is_empty() {
        return Err("a transaction signature is required".into());
    }
    // Validate base58 + 64-byte length without pulling in the full Solana SDK.
    // bs58 is a tiny, macOS-friendly crate. If it fails to decode we still
    // surface the explorer URL so the user can inspect manually.
    let decoded = bs58::decode(signature).into_vec();
    let byte_len = decoded.as_ref().map(|b| b.len()).unwrap_or(0);
    let valid = decoded.as_ref().map(|b| b.len() == 64).unwrap_or(false);
    let cluster = solana_cluster();
    let explorer = format!("https://explorer.solana.com/tx/{signature}?cluster={cluster}");
    println!("Capix Solana transaction (read-only)");
    println!("─────────────────────────────────────");
    println!("signature   : {signature}");
    println!("decoded_len : {byte_len} bytes");
    println!("valid       : {valid}");
    println!("cluster     : {cluster}");
    println!("explorer    : {explorer}");
    println!("\nThe Capix CLI never holds Solana keypairs; signing is delegated");
    println!("to your web wallet. This command performs a read-only inspection.");
    if let Ok(rpc) = std::env::var("CAPIX_SOLANA_RPC") {
        if !rpc.is_empty() {
            println!("rpc         : {rpc}");
        }
    }
    Ok(ExitCode::SUCCESS)
}

/// Balance inspection with per-asset display. `--asset CPX` surfaces the CPX
/// balance from `/api/v1/billing` with integer-only formatting and the
/// settlement-burn notice. No asset flag falls back to the raw JSON view.
fn balance(asset: Option<&str>) -> Result<ExitCode, String> {
    let billing = api_get_json("/api/v1/billing")?;
    match asset.map(|s| s.to_uppercase()).as_deref() {
        Some("CPX") => {
            let (mint, decimals) = cpx_config();
            let cpx = billing
                .pointer("/balances/CPX")
                .or_else(|| billing.pointer("/balances/cpx"));
            println!("Capix CPX balance");
            println!("─────────────────");
            if let Some(cpx) = cpx {
                let available_minor = cpx
                    .get("available")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<u64>().ok())
                    .or_else(|| cpx.get("available").and_then(|v| v.as_u64()))
                    .unwrap_or(0);
                let held_minor = cpx
                    .get("held")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<u64>().ok())
                    .or_else(|| cpx.get("held").and_then(|v| v.as_u64()))
                    .unwrap_or(0);
                println!(
                    "available : {}",
                    format::format_cpx_display(available_minor, decimals)
                );
                println!(
                    "held      : {}",
                    format::format_cpx_display(held_minor, decimals)
                );
                if let Some(mint) = mint {
                    println!("mint      : {mint}");
                }
                println!("decimals  : {decimals}");
                // USD reference (integer-only) when the API supplies a price.
                let price_usd_minor = cpx
                    .get("priceUsdMinor")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<u64>().ok())
                    .or_else(|| cpx.get("priceUsdMinor").and_then(|v| v.as_u64()))
                    .unwrap_or(0);
                if price_usd_minor > 0 {
                    println!(
                        "reference : {}",
                        format::format_usd_reference(available_minor, decimals, price_usd_minor)
                    );
                }
            } else {
                println!("(no CPX balance on this account)");
            }
            println!("\nCPX is {}", format::CPX_BURN_NOTICE);
        }
        Some(other) => {
            return Err(format!(
                "unsupported asset '{other}'; use --asset CPX (or omit for raw billing view)"
            ));
        }
        None => {
            let body = serde_json::to_string_pretty(&billing).map_err(|e| e.to_string())?;
            println!("{body}");
        }
    }
    Ok(ExitCode::SUCCESS)
}

/// Billing history with optional CPX filtering.
fn billing_history(asset: Option<&str>) -> Result<ExitCode, String> {
    let json = api_get_json("/api/v1/billing/history")?;
    match asset.map(|s| s.to_uppercase()).as_deref() {
        Some("CPX") => {
            println!("Capix CPX billing history");
            println!("─────────────────────────");
            let entries = json
                .get("entries")
                .or_else(|| json.get("history"))
                .and_then(|v| v.as_array())
                .map(|v| v.as_slice())
                .unwrap_or(&[]);
            if entries.is_empty() {
                println!("(no CPX billing history)");
            } else {
                let mut shown = 0usize;
                let (_, decimals) = cpx_config();
                for entry in entries {
                    let asset = entry.get("asset").and_then(|v| v.as_str()).unwrap_or("");
                    if asset.eq_ignore_ascii_case("CPX") {
                        let amount_minor = entry
                            .get("amountMinor")
                            .and_then(|v| v.as_str())
                            .and_then(|s| s.parse::<u64>().ok())
                            .or_else(|| entry.get("amountMinor").and_then(|v| v.as_u64()))
                            .unwrap_or(0);
                        let ts = entry
                            .get("timestamp")
                            .and_then(|v| v.as_str())
                            .unwrap_or("?");
                        let kind = entry.get("kind").and_then(|v| v.as_str()).unwrap_or("?");
                        println!(
                            "{ts}  {kind}  {}",
                            format::format_cpx_display(amount_minor, decimals)
                        );
                        shown += 1;
                    }
                }
                println!("─────────────────────────");
                println!("{shown} CPX entr(y/ies).");
            }
            println!("\nCPX is {}", format::CPX_BURN_NOTICE);
        }
        Some(other) => {
            return Err(format!("unsupported asset '{other}'; use --asset CPX"));
        }
        None => {
            let body = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?;
            println!("{body}");
        }
    }
    Ok(ExitCode::SUCCESS)
}

/// Request a quote. POSTs to `/api/v1/quotes` with the asset field so the
/// server can return a CPX- or USDC-denominated quote.
fn quote(prompt: &[String], asset: Option<&str>, model: Option<&str>) -> Result<ExitCode, String> {
    if prompt.is_empty() {
        return Err("a prompt is required for a quote".into());
    }
    let token = access_token()?;
    let request_id = format!(
        "capix-code-quote-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos()
    );
    let asset_value = asset.unwrap_or("USDC");
    let mut payload = serde_json::json!({
        "prompt": prompt.join(" "),
        "asset": asset_value,
    });
    if let Some(model) = model {
        payload["model"] = serde_json::json!(model);
    }
    let body: serde_json::Value = runtime()?.block_on(async {
        let response = http_client()?
            .post(format!("{WEB_ORIGIN}/api/v1/quotes"))
            .bearer_auth(&token)
            .header("idempotency-key", &request_id)
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("Capix quote returned {status}: {text}"));
        }
        serde_json::from_str(&text).map_err(|e| e.to_string())
    })?;
    println!("Capix quote ({asset_value})");
    println!("───────────────────────");
    let body_pretty = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
    println!("{body_pretty}");
    if asset_value.eq_ignore_ascii_case("CPX") {
        println!("\nCPX is {}", format::CPX_BURN_NOTICE);
    }
    Ok(ExitCode::SUCCESS)
}

/// Emit a fresh access token for trusted Capix clients (IDE, MCP) that use
/// this CLI as the native credential broker. The token is short-lived; the
/// refresh credential never leaves the OS keychain. Output is a single JSON
/// object on stdout so callers can parse it without scraping prose.
fn auth_token() -> Result<ExitCode, String> {
    match access_token() {
        Ok(token) => {
            println!(
                "{}",
                serde_json::json!({ "access_token": token, "token_type": "Bearer" })
            );
            Ok(ExitCode::SUCCESS)
        }
        Err(error) => {
            eprintln!("capix-code: {error}");
            Ok(ExitCode::FAILURE)
        }
    }
}

fn auth_status() -> Result<ExitCode, String> {
    if std::env::var("CAPIX_API_KEY")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        println!("Authenticated with a Capix project API key.");
        if let Err(e) = api_get("/api/v1/me") {
            eprintln!("capix-code: the project API key could not fetch account info: {e}");
            return Ok(ExitCode::FAILURE);
        }
        return Ok(ExitCode::SUCCESS);
    }
    match keyring_get_password() {
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
    let _ = keyring_delete_password();
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
        root.join("runtime/src/credential-constants.ts"),
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

/// Check MCP server status
fn mcp_status(root: &std::path::Path) -> Result<ExitCode, String> {
    let mcp_path = root.join("mcp").join("capix-mcp.js");
    if !mcp_path.is_file() {
        println!(
            "MCP: Not installed (bundled path missing: {})",
            mcp_path.display()
        );
        return Ok(ExitCode::FAILURE);
    }
    let token = access_token().ok();
    if token.is_none() {
        println!("MCP: Not authenticated");
        return Ok(ExitCode::FAILURE);
    }
    println!("MCP: Installed at {}", mcp_path.display());
    println!("MCP: Authenticated");
    println!("MCP: Start with: capix-code mcp reconnect");
    Ok(ExitCode::SUCCESS)
}

/// Run MCP diagnostics
fn mcp_doctor(root: &std::path::Path) -> Result<ExitCode, String> {
    println!("=== Capix MCP Doctor ===");
    // 1. Check bundled MCP exists
    let mcp_path = root.join("mcp").join("capix-mcp.js");
    if mcp_path.is_file() {
        println!("✓ MCP bundled: {}", mcp_path.display());
    } else {
        println!("✗ MCP not bundled: {}", mcp_path.display());
        return Ok(ExitCode::FAILURE);
    }
    // 2. Check auth
    match access_token() {
        Ok(_) => println!("✓ Authenticated"),
        Err(e) => {
            println!("✗ Not authenticated: {}", e);
            return Ok(ExitCode::FAILURE);
        }
    }
    // 3. Check node
    match std::process::Command::new("node").arg("--version").output() {
        Ok(o) if o.status.success() => {
            let v = String::from_utf8_lossy(&o.stdout);
            println!("✓ Node.js: {}", v.trim());
        }
        _ => {
            println!("✗ Node.js not found");
            return Ok(ExitCode::FAILURE);
        }
    }
    // 4. Check MCP dependencies
    let sdk_path = root
        .join("mcp")
        .join("node_modules")
        .join("@modelcontextprotocol");
    if sdk_path.is_dir() {
        println!("✓ MCP SDK present");
    } else {
        println!("✗ MCP SDK missing");
        return Ok(ExitCode::FAILURE);
    }
    let zod_path = root.join("mcp").join("node_modules").join("zod");
    if zod_path.is_dir() {
        println!("✓ Zod present");
    } else {
        println!("✗ Zod missing");
        return Ok(ExitCode::FAILURE);
    }
    println!("");
    println!("MCP health: OK");
    Ok(ExitCode::SUCCESS)
}

/// Reconnect MCP server
fn mcp_reconnect(root: &std::path::Path) -> Result<ExitCode, String> {
    let mcp_path = root.join("mcp").join("capix-mcp.js");
    if !mcp_path.is_file() {
        return Err("MCP not bundled. Run capix-code doctor for diagnostics.".into());
    }
    let token = access_token()?;
    // Start MCP server in a subprocess
    let env_token = std::env::var("CAPIX_API_KEY").unwrap_or_default();
    let child = std::process::Command::new("node")
        .arg(mcp_path)
        .arg("server")
        .arg("--stdio")
        .env(
            "CAPIX_API_KEY",
            if env_token.is_empty() {
                token
            } else {
                env_token
            },
        )
        .env("CAPIX_BASE_URL", WEB_ORIGIN)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to start MCP: {e}"))?;
    println!("MCP server started (PID: {})", child.id());
    // In production, this would be supervised with bounded restart/backoff:
    // - Restart attempts: 0 1 2 (max 3)
    // - Backoff: 5s, 15s, 60s
    // - After max attempts: mark as Degraded
    // The VS Code MCP host handles actual process supervision for stdio servers.
    Ok(ExitCode::SUCCESS)
}

// ── IPC Credential Broker ─────────────────────────────────────────────────
// A Unix domain socket server (macOS/Linux) or named pipe (Windows) that
// provides cross-process access to the credential store with single-flight
// refresh. Only the current user can connect (0600 socket permissions).

const BROKER_SOCKET_PATH: &str = "/tmp/capix-code-broker.sock";
const BROKER_PID_FILE: &str = "/tmp/capix-code-broker.pid";
#[cfg(windows)]
const BROKER_PIPE_NAME: &str = r"\\.\pipe\capix-code-broker";

#[cfg(windows)]
fn serve_windows_broker() {
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows_sys::Win32::Storage::FileSystem::{
        FlushFileBuffers, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE,
        PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };

    let pipe_name: Vec<u16> = BROKER_PIPE_NAME.encode_utf16().chain(Some(0)).collect();
    // Protected DACL: grant Generic All only to the object owner. Named-pipe
    // objects are owned by the creating process token's user, so this excludes
    // other interactive users. PIPE_REJECT_REMOTE_CLIENTS separately prevents
    // network clients from reaching the endpoint.
    let sddl: Vec<u16> = "D:P(A;;GA;;;OW)\0".encode_utf16().collect();

    loop {
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        let converted = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            )
        };
        if converted == 0 || descriptor.is_null() {
            return;
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let pipe = unsafe {
            CreateNamedPipeW(
                pipe_name.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                8192,
                8192,
                0,
                &attributes,
            )
        };
        unsafe {
            LocalFree(descriptor as *mut c_void);
        }
        if pipe == INVALID_HANDLE_VALUE {
            // Another launcher already owns the first, secured pipe instance.
            return;
        }

        let connected = unsafe { ConnectNamedPipe(pipe, null_mut()) } != 0
            || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
        if connected {
            let mut buffer = [0u8; 8192];
            let mut bytes_read = 0u32;
            let read_ok = unsafe {
                ReadFile(
                    pipe,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    &mut bytes_read,
                    null_mut(),
                )
            } != 0;
            if read_ok && bytes_read > 0 {
                let response = match serde_json::from_slice::<serde_json::Value>(
                    &buffer[..bytes_read as usize],
                ) {
                    Ok(request) => {
                        let method = request
                            .get("method")
                            .and_then(|value| value.as_str())
                            .unwrap_or("");
                        handle_broker_request(method)
                    }
                    Err(_) => serde_json::json!({"ok": false, "error": "invalid_json"}),
                };
                if let Ok(encoded) = serde_json::to_vec(&response) {
                    let mut bytes_written = 0u32;
                    unsafe {
                        WriteFile(
                            pipe,
                            encoded.as_ptr(),
                            encoded.len() as u32,
                            &mut bytes_written,
                            null_mut(),
                        );
                        FlushFileBuffers(pipe);
                    }
                }
            }
        }
        unsafe {
            DisconnectNamedPipe(pipe);
            CloseHandle(pipe);
        }
    }
}

/// Start the IPC broker as a background server.
fn start_broker() {
    // A PID can be reused after a short-lived command exits. Treat the broker
    // socket itself as the liveness probe so a stale PID can never suppress
    // credential refresh for a later interactive session.
    #[cfg(unix)]
    if std::os::unix::net::UnixStream::connect(BROKER_SOCKET_PATH).is_ok() {
        return;
    }
    let _ = std::fs::remove_file(BROKER_SOCKET_PATH);
    let _ = std::fs::remove_file(BROKER_PID_FILE);

    // Write our PID
    let _ = std::fs::write(BROKER_PID_FILE, std::process::id().to_string());

    // Fork to background (simplified: just spawn a thread)
    std::thread::spawn(|| {
        use std::io::{Read, Write};

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            use std::os::unix::net::UnixListener;

            // Remove stale socket
            let _ = std::fs::remove_file(BROKER_SOCKET_PATH);

            let listener = match UnixListener::bind(BROKER_SOCKET_PATH) {
                Ok(l) => l,
                Err(_) => return,
            };

            // Set 0600 permissions — only current user can connect
            if let Ok(meta) = std::fs::metadata(BROKER_SOCKET_PATH) {
                let mut perms = meta.permissions();
                perms.set_mode(0o600);
                let _ = std::fs::set_permissions(BROKER_SOCKET_PATH, perms);
            }

            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => continue,
                };

                let mut buf = [0u8; 8192];
                let n = match stream.read(&mut buf) {
                    Ok(n) if n > 0 => n,
                    _ => continue,
                };

                let request: serde_json::Value = match serde_json::from_slice(&buf[..n]) {
                    Ok(v) => v,
                    Err(_) => {
                        let _ = stream.write_all(br#"{"ok":false,"error":"invalid_json"}"#);
                        continue;
                    }
                };

                let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");
                let response = handle_broker_request(method);

                let _ = stream.write_all(
                    serde_json::to_string(&response)
                        .unwrap_or_default()
                        .as_bytes(),
                );
            }
        }

        #[cfg(windows)]
        {
            serve_windows_broker();
        }
    });
}

/// Handle a broker IPC request.
fn handle_broker_request(method: &str) -> serde_json::Value {
    match method {
        "auth.status" => {
            // Validate by actually calling the API, not just checking if key exists
            match access_token() {
                Ok(token) => {
                    // Probe the API to check if the token is actually valid
                    let valid = std::thread::spawn(move || {
                        let runtime = tokio::runtime::Runtime::new().ok();
                        if let Some(rt) = runtime {
                            rt.block_on(async {
                                let client = reqwest::Client::new();
                                let res = client
                                    .get(format!("{WEB_ORIGIN}/api/v1/me"))
                                    .bearer_auth(&token)
                                    .timeout(std::time::Duration::from_secs(5))
                                    .send()
                                    .await;
                                res.map(|r| r.status().is_success()).unwrap_or(false)
                            })
                        } else {
                            false
                        }
                    })
                    .join()
                    .unwrap_or(false);
                    serde_json::json!({
                        "ok": true,
                        "result": {
                            "authenticated": valid,
                        }
                    })
                }
                Err(e) => serde_json::json!({
                    "ok": true,
                    "result": {
                        "authenticated": false,
                        "reason": e,
                    }
                }),
            }
        }
        "token.get" => match access_token() {
            Ok(token) => serde_json::json!({
                "ok": true,
                "result": {
                    "accessToken": token,
                    "expiresAt": format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() + 900).unwrap_or(0))
                }
            }),
            Err(e) => serde_json::json!({
                "ok": false,
                "error": e,
            }),
        },
        "token.invalidate" => {
            let _ = keyring_delete_password();
            // Also clean up file-based store
            if let Ok(home) = std::env::var("HOME") {
                let cred_file = std::path::PathBuf::from(home).join(".capix-code/credentials.json");
                let _ = std::fs::remove_file(cred_file);
            }
            serde_json::json!({"ok": true, "result": {"revoked": true}})
        }
        "auth.logout" => {
            // Revoke token on server, then clear local credentials
            if let Ok(token) = access_token() {
                let _ = reqwest::Client::new()
                    .post(format!("{WEB_ORIGIN}/oauth/revoke"))
                    .bearer_auth(token)
                    .send();
            }
            let _ = keyring_delete_password();
            if let Ok(home) = std::env::var("HOME") {
                let cred_file = std::path::PathBuf::from(home).join(".capix-code/credentials.json");
                let _ = std::fs::remove_file(cred_file);
                let _ = std::fs::remove_file(BROKER_PID_FILE);
                let _ = std::fs::remove_file(BROKER_SOCKET_PATH);
            }
            serde_json::json!({"ok": true, "result": {"loggedOut": true}})
        }
        _ => serde_json::json!({"ok": false, "error": "unknown_method"}),
    }
}

fn main() -> ExitCode {
    // Start the credential broker IPC server in the background
    start_broker();

    let cli = Cli::parse();
    let root = match install_root() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("capix-code: {e}");
            return ExitCode::FAILURE;
        }
    };
    let result = match cli.command.unwrap_or_else(RunConfig::default_command) {
        Command::Doctor => doctor(&root).map(|_| ExitCode::SUCCESS),
        Command::Login => login(),
        Command::Logout => {
            match keyring_delete_password() {
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
        Command::Run {
            auto,
            tier,
            spend_cap,
            brief,
        } => {
            let brief_text = brief.join(" ").trim().to_string();
            if auto && brief_text.is_empty() {
                Err("capix-code run --auto requires a task brief".to_string())
            } else {
                let spend_cap_minor: Result<Option<String>, String> =
                    match spend_cap.as_deref().map(parse_spend_cap_minor) {
                        Some(Ok(minor)) => Ok(Some(minor)),
                        Some(Err(e)) => Err(e),
                        None => Ok(None),
                    };
                match spend_cap_minor {
                    Err(e) => Err(e),
                    Ok(spend_cap_minor) => run_engine(
                        &root,
                        &cli.engine_args,
                        RunConfig {
                            auto,
                            tier,
                            brief: brief_text,
                            spend_cap_minor,
                        },
                    ),
                }
            }
        }
        Command::RunAgent => {
            let mut a = vec!["run".into()];
            a.extend(cli.engine_args);
            run_engine(&root, &a, RunConfig::default_interactive())
        }
        Command::Agent { subcommand } => match subcommand {
            AgentCommand::List => {
                println!("Specialist agents:");
                println!("  explore     - Read and understand codebase");
                println!("  implement   - Write code, create files");
                println!("  test        - Write and run tests");
                println!("  review      - Code review (read-only)");
                println!("  security    - Security audit (read-only)");
                println!("  deploy      - Deploy to Capix Cloud");
                Ok(ExitCode::SUCCESS)
            }
            AgentCommand::Sessions => api_get("/api/v1/agents"),
            AgentCommand::Spawn { role, task } => {
                eprintln!("Spawning {} agent: {}", role, task);
                Ok(ExitCode::SUCCESS)
            }
            AgentCommand::Resume { session_id } => {
                eprintln!("Resuming session: {}", session_id);
                Ok(ExitCode::SUCCESS)
            }
            AgentCommand::Cancel { session_id } => {
                eprintln!("Cancelling session: {}", session_id);
                Ok(ExitCode::SUCCESS)
            }
        },
        Command::Mcp { subcommand } => match subcommand {
            McpCommand::Status => mcp_status(&root),
            McpCommand::Doctor => mcp_doctor(&root),
            McpCommand::Reconnect => mcp_reconnect(&root),
        },
        Command::AgentRuntime { stdio } => {
            if stdio {
                let plugin_path = root.join("src/acp/transport.ts");
                let engine = engine_path(&root);
                let mut cmd = ProcessCommand::new(&engine);
                cmd.arg("--eval")
                    .arg(std::format!(
                        "import('{}').then(m=>m.startAcpServer())",
                        plugin_path.display()
                    ))
                    .env("CAPIX_ACP_STARTED", "1");
                match cmd.status() {
                    Ok(status) => Ok(if status.success() {
                        ExitCode::SUCCESS
                    } else {
                        ExitCode::FAILURE
                    }),
                    Err(e) => Err(format!("Failed to start agent runtime: {e}")),
                }
            } else {
                Err("agent-runtime requires --stdio flag".into())
            }
        }
        Command::LlmRun { prompt } => llm_run(&prompt),
        Command::GpuStatus => api_get("/api/v1/gpu"),
        Command::Account => api_get("/api/v1/me"),
        Command::Project => project_info(),
        Command::Status => api_get("/api/v1/billing"),
        Command::Attach { workspace_id } => unavailable(&format!("attach {workspace_id}")),
        Command::Operations => api_get("/api/v1/deployments"),
        Command::Usage => api_get("/api/v1/billing"),
        Command::Invoices => api_get("/api/v1/invoices"),
        Command::Auth { subcommand } => match subcommand {
            AuthCommand::Status => auth_status(),
            AuthCommand::Reset => auth_reset(),
            AuthCommand::Token => auth_token(),
        },
        Command::Settlement { subcommand } => match subcommand {
            SettlementCommand::Status => settlement_status(),
            SettlementCommand::Epochs => settlement_epochs(),
            SettlementCommand::ProofBalance => settlement_proof_balance(),
            SettlementCommand::ProofUsage { receipt_id } => settlement_proof_usage(&receipt_id),
        },
        Command::Receipts { subcommand } => match subcommand {
            ReceiptsCommand::List => receipts(),
            ReceiptsCommand::Verify { receipt_id } => {
                verify_receipt_proof(&receipt_id, merkle_verify::ROUTE_RECEIPT_CATEGORY)
            }
        },
        Command::Dev { subcommand } => match subcommand {
            DevCommand::Proof { award_id } => dev_proof(&award_id),
        },
        Command::Solana { subcommand } => match subcommand {
            SolanaCommand::Transaction { signature } => solana_transaction(&signature),
        },
        Command::Balance { asset } => balance(asset.as_deref()),
        Command::Billing { subcommand } => match subcommand {
            BillingCommand::History { asset } => billing_history(asset.as_deref()),
        },
        Command::Quote {
            prompt,
            asset,
            model,
        } => quote(&prompt, asset.as_deref(), model.as_deref()),
        Command::Models => api_get("/api/v1/models"),
        Command::Instances => api_get("/api/v1/deployments"),
        Command::Deploy { subcommand } => match subcommand {
            DeployCommand::Llm { model, quote } => deploy_llm(&model, &quote),
        },
        Command::Train {
            model,
            dataset,
            specialize,
        } => train(&model, &dataset, &specialize),
        Command::Destroy { id } => destroy(&id),
        Command::New {
            template,
            name,
            deploy,
        } => new_command::run(template.as_deref(), name.as_deref(), deploy),
    };
    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("capix-code: {e}");
            ExitCode::FAILURE
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_defaults_to_interactive_balanced() {
        let cli = Cli::try_parse_from(["capix-code", "run"]).expect("parse");
        match cli.command.expect("subcommand") {
            Command::Run {
                auto,
                tier,
                spend_cap,
                brief,
            } => {
                assert!(!auto);
                assert_eq!(tier, "balanced");
                assert!(spend_cap.is_none());
                assert!(brief.is_empty());
            }
            _ => panic!("expected run"),
        }
    }

    #[test]
    fn run_auto_parses_tier_spend_cap_and_brief() {
        let cli = Cli::try_parse_from([
            "capix-code",
            "run",
            "--auto",
            "--tier",
            "best",
            "--spend-cap",
            "2.50",
            "fix the flaky tests",
        ])
        .expect("parse");
        match cli.command.expect("subcommand") {
            Command::Run {
                auto,
                tier,
                spend_cap,
                brief,
            } => {
                assert!(auto);
                assert_eq!(tier, "best");
                assert_eq!(spend_cap.as_deref(), Some("2.50"));
                assert_eq!(brief.join(" "), "fix the flaky tests");
            }
            _ => panic!("expected run"),
        }
    }

    #[test]
    fn run_rejects_unknown_tier() {
        assert!(Cli::try_parse_from(["capix-code", "run", "--tier", "premium", "x"]).is_err());
    }

    #[test]
    fn spend_cap_converts_to_micro_usd_minor_units() {
        assert_eq!(parse_spend_cap_minor("5").unwrap(), "5000000");
        assert_eq!(parse_spend_cap_minor("2.50").unwrap(), "2500000");
        assert_eq!(parse_spend_cap_minor("0.000001").unwrap(), "1");
        assert_eq!(parse_spend_cap_minor("0").unwrap(), "0");
        assert_eq!(parse_spend_cap_minor(".25").unwrap(), "250000");
    }

    #[test]
    fn spend_cap_rejects_unrepresentable_amounts() {
        // More than 6 fractional digits would silently round the budget.
        assert!(parse_spend_cap_minor("0.0000001").is_err());
        assert!(parse_spend_cap_minor("-1").is_err());
        assert!(parse_spend_cap_minor("abc").is_err());
        assert!(parse_spend_cap_minor("").is_err());
        assert!(parse_spend_cap_minor("1.2.3").is_err());
        assert!(parse_spend_cap_minor("99999999999999").is_err());
    }
}
