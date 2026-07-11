use clap::{Parser, Subcommand};
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, ExitCode};

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
    EngineVersion,
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
    let mut command = ProcessCommand::new(&engine);
    command
        .args(args)
        .env("CAPIX_CODE_BUNDLED_RUNTIME", &runtime)
        .env("CAPIX_CODE_PLUGIN", runtime.join("src/plugin.ts"))
        .env(
            "CAPIX_CODE_DEFAULT_CONFIG",
            root.join("config/capix-defaults.json"),
        );
    scrub_environment(&mut command);
    let status = command
        .status()
        .map_err(|e| format!("failed to launch engine: {e}"))?;
    Ok(ExitCode::from(status.code().unwrap_or(1) as u8))
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
        Command::EngineVersion => run_engine(&root, &["--version".into()]),
        Command::Login => run_engine(&root, &["auth".into(), "login".into(), "capix".into()]),
        Command::Logout => run_engine(&root, &["auth".into(), "logout".into(), "capix".into()]),
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
        Command::GpuStatus => run_engine(
            &root,
            &[
                "capix".into(),
                "status".into(),
                "--resource".into(),
                "gpu".into(),
            ],
        ),
        Command::Account => run_engine(&root, &["capix".into(), "account".into()]),
        Command::Project => run_engine(&root, &["capix".into(), "project".into()]),
        Command::Status => run_engine(&root, &["capix".into(), "status".into()]),
        Command::Attach { workspace_id } => {
            run_engine(&root, &["capix".into(), "attach".into(), workspace_id])
        }
        Command::Operations => run_engine(&root, &["capix".into(), "operations".into()]),
        Command::Receipts => run_engine(&root, &["capix".into(), "receipts".into()]),
        Command::Usage => run_engine(&root, &["capix".into(), "usage".into()]),
        Command::Invoices => run_engine(&root, &["capix".into(), "invoices".into()]),
    };
    match result {
        Ok(code) => code,
        Err(e) => {
            eprintln!("capix-code: {e}");
            ExitCode::FAILURE
        }
    }
}
