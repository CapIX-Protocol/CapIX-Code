//! `capix-code new` — one-command MVP scaffolding.
//!
//! Template resolution is API-first: `GET {WEB_ORIGIN}/api/v1/templates`
//! returns the control-plane catalog. That catalog (see
//! `app/api/v1/templates/route.ts` in capix-protocol) is a *deployment spec*
//! catalog — it carries stack/features/customization metadata and a workload
//! spec for the quote → deployment pipeline, but no local file tree. Local
//! scaffolding therefore uses the built-in file trees below; every listing
//! marks whether a template came from the API or is built in.

use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::process::ExitCode;

use serde::Deserialize;

/// Placeholder substituted with the project name in every scaffolded file.
const NAME_PLACEHOLDER: &str = "{{PROJECT_NAME}}";

/* ------------------------------------------------------------------ *
 * Built-in file-tree templates
 * ------------------------------------------------------------------ */

pub struct BuiltinTemplate {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    /// Default build command sent to the websites API on `--deploy`.
    pub build_command: Option<&'static str>,
    /// Printed after a successful scaffold.
    pub next_steps: &'static [&'static str],
    /// (relative path, contents) — contents may contain `{{PROJECT_NAME}}`.
    pub files: &'static [(&'static str, &'static str)],
}

const STATIC_SITE: BuiltinTemplate = BuiltinTemplate {
    id: "static-site",
    name: "Static Site",
    description: "Plain HTML/CSS site, deployable as-is. No build step.",
    build_command: None,
    next_steps: &["cd {{PROJECT_NAME}}", "open index.html"],
    files: &[
        (
            "index.html",
            r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{{PROJECT_NAME}}</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main>
      <h1>{{PROJECT_NAME}}</h1>
      <p>Scaffolded with <code>capix-code new static-site</code>.</p>
    </main>
  </body>
</html>
"#,
        ),
        (
            "styles.css",
            r#"body {
  margin: 0;
  font-family: system-ui, sans-serif;
  display: grid;
  place-items: center;
  min-height: 100vh;
  background: #0b0d10;
  color: #e8eaed;
}
main {
  text-align: center;
}
code {
  color: #7dd3fc;
}
"#,
        ),
        (
            "capix.json",
            r#"{
  "name": "{{PROJECT_NAME}}",
  "template": "static-site",
  "outputDir": "."
}
"#,
        ),
        (
            "README.md",
            r#"# {{PROJECT_NAME}}

Static site scaffolded with `capix-code new static-site`.

## Run

Open `index.html` in a browser, or serve the directory:

```bash
npx serve .
```

## Deploy

Push to a git remote, then:

```bash
capix-code new static-site {{PROJECT_NAME}} --deploy
```
"#,
        ),
        (".gitignore", "node_modules/\ndist/\n"),
    ],
};

const NEXT_SAAS: BuiltinTemplate = BuiltinTemplate {
    id: "next-saas",
    name: "Next.js SaaS",
    description: "Minimal Next.js (App Router) starter for a SaaS MVP.",
    build_command: Some("npm install && npm run build"),
    next_steps: &["cd {{PROJECT_NAME}}", "npm install", "npm run dev"],
    files: &[
        (
            "package.json",
            r#"{
  "name": "{{PROJECT_NAME}}",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "^15.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
"#,
        ),
        (
            "next.config.mjs",
            "/** @type {import('next').NextConfig} */\nexport default {};\n",
        ),
        (
            "app/layout.tsx",
            r#"export const metadata = {
  title: "{{PROJECT_NAME}}",
  description: "{{PROJECT_NAME}} — scaffolded with capix-code new",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
"#,
        ),
        (
            "app/page.tsx",
            r#"export default function Home() {
  return (
    <main>
      <h1>{{PROJECT_NAME}}</h1>
      <p>Scaffolded with capix-code new next-saas.</p>
    </main>
  );
}
"#,
        ),
        (
            "capix.json",
            r#"{
  "name": "{{PROJECT_NAME}}",
  "template": "next-saas",
  "buildCommand": "npm install && npm run build",
  "outputDir": ".next"
}
"#,
        ),
        (
            "README.md",
            r#"# {{PROJECT_NAME}}

Next.js SaaS starter scaffolded with `capix-code new next-saas`.

## Run

```bash
npm install
npm run dev
```

## Deploy

Push to a git remote, then:

```bash
capix-code new next-saas {{PROJECT_NAME}} --deploy
```
"#,
        ),
        (".gitignore", "node_modules/\n.next/\ndist/\n"),
    ],
};

pub fn builtin_templates() -> &'static [BuiltinTemplate] {
    &[STATIC_SITE, NEXT_SAAS]
}

fn builtin_ids() -> String {
    builtin_templates()
        .iter()
        .map(|t| t.id)
        .collect::<Vec<_>>()
        .join(", ")
}

/* ------------------------------------------------------------------ *
 * API catalog (deployment-spec templates)
 * ------------------------------------------------------------------ */

#[derive(Debug, Deserialize)]
pub struct ApiTemplate {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub tagline: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: String,
}

#[derive(Deserialize)]
struct TemplatesResponse {
    #[serde(default)]
    data: Vec<ApiTemplate>,
}

/// API base URL. `CAPIX_WEB_ORIGIN` overrides the compile-time constant so
/// tests (and staging) can point the command at a different control plane.
fn web_origin() -> String {
    std::env::var("CAPIX_WEB_ORIGIN")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| crate::WEB_ORIGIN.to_string())
}

/// Fetch the public template catalog. The route is unauthenticated today
/// (see capix-protocol `app/api/v1/templates/route.ts` GET handler).
pub fn fetch_api_templates(origin: &str) -> Result<Vec<ApiTemplate>, String> {
    crate::runtime()?.block_on(async {
        let response = crate::http_client()?
            .get(format!("{origin}/api/v1/templates"))
            .send()
            .await
            .map_err(|e| format!("cannot reach the Capix templates API at {origin}: {e}"))?;
        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("Capix templates API returned {status}: {text}"));
        }
        let parsed: TemplatesResponse = serde_json::from_str(&text)
            .map_err(|e| format!("invalid Capix templates API response: {e}"))?;
        Ok(parsed.data)
    })
}

/* ------------------------------------------------------------------ *
 * Validation + filesystem guards
 * ------------------------------------------------------------------ */

/// Mirrors the control-plane deployment-name rule
/// (`^[a-z0-9][a-z0-9-]{1,62}$` in capix-protocol `lib/templates.ts`) so a
/// scaffolded name is always deployable later.
pub fn validate_project_name(name: &str) -> Result<(), String> {
    let len = name.chars().count();
    if !(2..=63).contains(&len) {
        return Err(format!(
            "invalid project name \"{name}\": must be 2-63 characters"
        ));
    }
    let valid = name
        .chars()
        .enumerate()
        .all(|(i, c)| c.is_ascii_lowercase() || c.is_ascii_digit() || (c == '-' && i > 0));
    if !valid {
        return Err(format!(
            "invalid project name \"{name}\": use lowercase letters, digits and hyphens, starting with a letter or digit"
        ));
    }
    Ok(())
}

/// Fail if `dest` exists and is non-empty; create it otherwise.
pub fn ensure_target_dir(dest: &Path) -> Result<(), String> {
    if dest.exists() {
        if !dest.is_dir() {
            return Err(format!(
                "cannot scaffold: {} exists and is not a directory",
                dest.display()
            ));
        }
        let mut entries = std::fs::read_dir(dest)
            .map_err(|e| format!("cannot read directory {}: {e}", dest.display()))?;
        if entries.next().is_some() {
            return Err(format!(
                "cannot scaffold: directory {} already exists and is not empty",
                dest.display()
            ));
        }
        return Ok(());
    }
    std::fs::create_dir_all(dest)
        .map_err(|e| format!("cannot create directory {}: {e}", dest.display()))
}

/// Write the template's file tree into `dest`, substituting the project name.
/// Returns the number of files written.
pub fn scaffold(template: &BuiltinTemplate, name: &str, dest: &Path) -> Result<usize, String> {
    ensure_target_dir(dest)?;
    let mut written = 0usize;
    for (relative, contents) in template.files {
        let path = dest.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        let substituted = contents.replace(NAME_PLACEHOLDER, name);
        std::fs::write(&path, substituted)
            .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
        written += 1;
    }
    Ok(written)
}

/* ------------------------------------------------------------------ *
 * Deploy (--deploy)
 * ------------------------------------------------------------------ */

/// `git remote get-url origin` in `dir`; `None` when git is missing, the dir
/// is not a repo, or no origin remote is configured.
pub fn git_origin_remote(dir: &Path) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(dir)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

/// POST /api/v1/websites — create a website + first release from a git
/// source ref. Returns the parsed response body.
pub fn deploy_website(
    origin: &str,
    token: &str,
    name: &str,
    source_ref: &str,
    build_command: Option<&str>,
) -> Result<serde_json::Value, String> {
    let idempotency_key = format!("capix-code-new-{}", crate::uuid());
    crate::runtime()?.block_on(async {
        let mut body = serde_json::json!({
            "name": name,
            "sourceRef": source_ref,
        });
        if let Some(command) = build_command {
            body["buildCommand"] = serde_json::json!(command);
        }
        let response = crate::http_client()?
            .post(format!("{origin}/api/v1/websites"))
            .bearer_auth(token)
            .header("idempotency-key", &idempotency_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("cannot reach the Capix websites API: {e}"))?;
        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("Capix websites API returned {status}: {text}"));
        }
        serde_json::from_str(&text).map_err(|e| e.to_string())
    })
}

fn deploy_flow(template: &BuiltinTemplate, name: &str, dest: &Path) -> Result<(), String> {
    match git_origin_remote(dest) {
        None => {
            println!(
                "Deploy skipped: {} has no git remote \"origin\".",
                dest.display()
            );
            println!("To deploy, push this project to a git remote first:");
            println!("  cd {name}");
            println!("  git init");
            println!("  git add -A");
            println!("  git commit -m \"Initial commit\"");
            println!("  git remote add origin <your-repo-url>");
            println!("  git push -u origin main");
            println!("Then re-run:");
            println!("  capix-code new {} {name} --deploy", template.id);
            println!("No deploy was performed.");
            Ok(())
        }
        Some(remote) => {
            println!("Deploying {name} from {remote} …");
            let token = crate::access_token()?;
            let body = deploy_website(&web_origin(), &token, name, &remote, template.build_command)
                .map_err(|e| {
                    format!(
                        "deploy failed (the project was scaffolded locally at {}): {e}",
                        dest.display()
                    )
                })?;
            let website = body.get("website").unwrap_or(&body);
            println!("Deploy accepted by the Capix control plane.");
            if let Some(id) = website.get("id").and_then(|v| v.as_str()) {
                println!("website id : {id}");
            }
            if let Some(status) = website.get("status").and_then(|v| v.as_str()) {
                println!("status     : {status}");
            }
            if let Some(url) = website.get("previewUrl").and_then(|v| v.as_str()) {
                println!("preview    : {url}");
            }
            Ok(())
        }
    }
}

/* ------------------------------------------------------------------ *
 * Command entry points
 * ------------------------------------------------------------------ */

pub fn run(template: Option<&str>, name: Option<&str>, deploy: bool) -> Result<ExitCode, String> {
    match template {
        None => list_templates(),
        Some(template_id) => scaffold_command(template_id, name, deploy),
    }
}

fn print_table(rows: &[(String, String, String)]) {
    let width = rows.iter().map(|r| r.0.len()).max().unwrap_or(0);
    for (id, name, description) in rows {
        println!("  {id:<width$}  {name} — {description}");
    }
}

fn list_templates() -> Result<ExitCode, String> {
    let origin = web_origin();
    let api_templates = match fetch_api_templates(&origin) {
        Ok(list) => Some(list),
        Err(e) => {
            eprintln!("capix-code: {e}");
            eprintln!("capix-code: API catalog unavailable — showing built-in templates only.");
            None
        }
    };
    println!("Capix templates");
    println!("───────────────");
    if let Some(templates) = &api_templates {
        println!("\nFrom the Capix API ({origin}/api/v1/templates):");
        if templates.is_empty() {
            println!("  (catalog is empty)");
        } else {
            let rows: Vec<(String, String, String)> = templates
                .iter()
                .map(|t| {
                    let summary = if t.tagline.is_empty() {
                        t.description.clone()
                    } else {
                        t.tagline.clone()
                    };
                    let name = if t.category.is_empty() {
                        t.name.clone()
                    } else {
                        format!("{} [{}]", t.name, t.category)
                    };
                    (t.id.clone(), name, summary)
                })
                .collect();
            print_table(&rows);
        }
        println!(
            "  (API templates are deployment specs without a local file tree — deploy them from https://www.capix.network/cloud)"
        );
    }
    println!("\nBuilt in to this CLI (scaffoldable local file trees):");
    let rows: Vec<(String, String, String)> = builtin_templates()
        .iter()
        .map(|t| {
            (
                t.id.to_string(),
                t.name.to_string(),
                t.description.to_string(),
            )
        })
        .collect();
    print_table(&rows);
    println!("\nScaffold one with: capix-code new <template> [name]");
    Ok(ExitCode::SUCCESS)
}

fn scaffold_command(
    template_id: &str,
    name: Option<&str>,
    deploy: bool,
) -> Result<ExitCode, String> {
    let name = name.unwrap_or(template_id);
    validate_project_name(name)?;
    let template = match builtin_templates().iter().find(|t| t.id == template_id) {
        Some(template) => template,
        None => {
            // Give an honest explanation: does the id exist in the API catalog
            // (deployment spec only) or is it unknown entirely?
            return match fetch_api_templates(&web_origin()) {
                Ok(list) if list.iter().any(|t| t.id == template_id) => Err(format!(
                    "template \"{template_id}\" exists in the Capix API catalog, but API templates are deployment specs without a local file tree and cannot be scaffolded by `capix-code new`. Scaffold a built-in template instead ({}) or deploy \"{template_id}\" from https://www.capix.network/cloud.",
                    builtin_ids()
                )),
                Ok(_) => Err(format!(
                    "unknown template \"{template_id}\"; run `capix-code new` to list available templates"
                )),
                Err(e) => Err(format!(
                    "unknown built-in template \"{template_id}\", and the Capix templates API could not be checked: {e}"
                )),
            };
        }
    };
    let dest = std::env::current_dir()
        .map_err(|e| format!("cannot resolve current directory: {e}"))?
        .join(name);
    let written = scaffold(template, name, &dest)?;
    println!(
        "Created \"{name}\" in {} (template: {}, built-in)",
        dest.display(),
        template.id
    );
    println!("{written} file(s) written.");
    println!("\nNext steps:");
    for step in template.next_steps {
        println!("  {}", step.replace(NAME_PLACEHOLDER, name));
    }
    if deploy {
        println!();
        deploy_flow(template, name, &dest)?;
    }
    Ok(ExitCode::SUCCESS)
}

/// Test helper: where scaffolded temp projects go.
#[cfg(test)]
fn temp_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir()
        .join(format!("capix-new-test-{}-{nanos}", std::process::id()))
        .join(tag)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /* ---- name validation ---- */

    #[test]
    fn accepts_valid_names() {
        for name in ["ab", "my-app", "a1", "x".repeat(63).as_str()] {
            assert!(validate_project_name(name).is_ok(), "expected ok: {name}");
        }
    }

    #[test]
    fn rejects_invalid_names() {
        for name in [
            "",
            "a",
            "-lead",
            "Upper",
            "has space",
            "under_score",
            "dot.name",
            "é",
        ] {
            assert!(validate_project_name(name).is_err(), "expected err: {name}");
        }
        let too_long = "x".repeat(64);
        assert!(validate_project_name(&too_long).is_err());
    }

    /* ---- dir-exists guard ---- */

    #[test]
    fn ensure_target_dir_creates_missing() {
        let dir = temp_dir("creates");
        ensure_target_dir(&dir).unwrap();
        assert!(dir.is_dir());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_target_dir_allows_empty_existing() {
        let dir = temp_dir("empty");
        std::fs::create_dir_all(&dir).unwrap();
        ensure_target_dir(&dir).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_target_dir_rejects_non_empty() {
        let dir = temp_dir("non-empty");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("existing.txt"), "x").unwrap();
        let err = ensure_target_dir(&dir).unwrap_err();
        assert!(err.contains("not empty"), "unexpected error: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_target_dir_rejects_file() {
        let path = temp_dir("a-file");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "x").unwrap();
        let err = ensure_target_dir(&path).unwrap_err();
        assert!(err.contains("not a directory"), "unexpected error: {err}");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    /* ---- template substitution ---- */

    #[test]
    fn scaffold_writes_tree_and_substitutes_name() {
        let dir = temp_dir("scaffold");
        let template = &builtin_templates()[0];
        let written = scaffold(template, "acme-site", &dir).unwrap();
        assert_eq!(written, template.files.len());
        for (relative, _) in template.files {
            let contents = std::fs::read_to_string(dir.join(relative)).unwrap();
            assert!(
                !contents.contains(NAME_PLACEHOLDER),
                "unsubstituted placeholder in {relative}"
            );
        }
        let manifest = std::fs::read_to_string(dir.join("capix.json")).unwrap();
        assert!(manifest.contains("\"acme-site\""));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn scaffold_refuses_to_overwrite_non_empty_dir() {
        let dir = temp_dir("scaffold-guard");
        let template = &builtin_templates()[1];
        scaffold(template, "first-app", &dir).unwrap();
        let err = scaffold(template, "second-app", &dir).unwrap_err();
        assert!(err.contains("not empty"), "unexpected error: {err}");
        // The original files are untouched.
        let manifest = std::fs::read_to_string(dir.join("capix.json")).unwrap();
        assert!(manifest.contains("\"first-app\""));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn next_steps_substitute_name() {
        let template = &builtin_templates()[1];
        let rendered: Vec<String> = template
            .next_steps
            .iter()
            .map(|s| s.replace(NAME_PLACEHOLDER, "shop-mvp"))
            .collect();
        assert_eq!(rendered[0], "cd shop-mvp");
    }

    /* ---- mock HTTP server (list + deploy paths) ---- */

    /// Serve one canned HTTP response; returns the origin and a handle that
    /// yields the captured request text.
    fn serve_once(status: &str, body: &str) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let status = status.to_string();
        let body = body.to_string();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 4096];
            // Read until headers are complete and the declared body arrived.
            loop {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&request);
                if let Some(head_end) = text.find("\r\n\r\n") {
                    let content_length: usize = text[..head_end]
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|v| v.trim().parse().ok())
                        })
                        .unwrap_or(0);
                    if text.len() >= head_end + 4 + content_length {
                        break;
                    }
                }
            }
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8_lossy(&request).to_string()
        });
        (format!("http://{addr}"), handle)
    }

    #[test]
    fn fetch_templates_parses_api_catalog() {
        let (origin, handle) = serve_once(
            "200 OK",
            r#"{"data":[{"id":"saas-starter","name":"SaaS Starter","tagline":"Next.js + auth","category":"web"}],"generatedAt":"2026-07-19T00:00:00.000Z"}"#,
        );
        let templates = fetch_api_templates(&origin).unwrap();
        let request = handle.join().unwrap();
        assert!(request.starts_with("GET /api/v1/templates "));
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].id, "saas-starter");
        assert_eq!(templates[0].tagline, "Next.js + auth");
    }

    #[test]
    fn fetch_templates_reports_http_error() {
        let (origin, handle) = serve_once("500 Internal Server Error", r#"{"error":"boom"}"#);
        let err = fetch_api_templates(&origin).unwrap_err();
        handle.join().unwrap();
        assert!(err.contains("500"), "unexpected error: {err}");
    }

    #[test]
    fn fetch_templates_reports_unreachable_api() {
        // Nothing is listening on this port.
        let err = fetch_api_templates("http://127.0.0.1:9").unwrap_err();
        assert!(
            err.contains("cannot reach the Capix templates API"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn deploy_website_posts_name_and_source_ref() {
        let (origin, handle) = serve_once(
            "201 Created",
            r#"{"website":{"id":"site_abc","name":"acme-site","status":"preview","previewUrl":"https://acme-site--deadbeef.capix.dev"}}"#,
        );
        let body = deploy_website(
            &origin,
            "test-token",
            "acme-site",
            "https://github.com/acme/acme-site.git",
            None,
        )
        .unwrap();
        let request = handle.join().unwrap();
        assert!(request.starts_with("POST /api/v1/websites "));
        assert!(request.contains("authorization: Bearer test-token"));
        assert!(request.contains("idempotency-key: capix-code-new-"));
        assert!(request.contains(r#""name":"acme-site""#));
        assert!(request.contains(r#""sourceRef":"https://github.com/acme/acme-site.git""#));
        let preview = body
            .pointer("/website/previewUrl")
            .and_then(|v| v.as_str())
            .unwrap();
        assert_eq!(preview, "https://acme-site--deadbeef.capix.dev");
    }

    #[test]
    fn deploy_website_reports_failure_honestly() {
        let (origin, handle) = serve_once(
            "409 Conflict",
            r#"{"code":"CAPIX_SLUG_TAKEN","message":"taken"}"#,
        );
        let err =
            deploy_website(&origin, "test-token", "acme-site", "git@x:y.git", None).unwrap_err();
        handle.join().unwrap();
        assert!(err.contains("409"), "unexpected error: {err}");
        assert!(err.contains("CAPIX_SLUG_TAKEN"), "unexpected error: {err}");
    }
}
