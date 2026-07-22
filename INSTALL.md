# Install CapixIDE and Capix Code

This guide installs the unsigned customer builds published by the official Capix repositories.

- CapixIDE: https://github.com/CapIX-Protocol/CapIX-IDE/releases
- Capix Code: https://github.com/CapIX-Protocol/CapIX-Code/releases
- Web console: https://www.capix.network

Never continue when a downloaded artifact does not match its adjacent SHA-256 file.

## Versioning

Versions are immutable `vMAJOR.MINOR.PATCH` tags. The commands below pin
CapixIDE `v2.3.13` and Capix Code `v2.4.8`, the pinned customer releases with
attached customer artifacts and adjacent checksums. Do not substitute a newer
tag unless its release page contains the exact archive and checksum filenames
used below.

The Capix Code shell installer resolves `latest` to an immutable tag by setting
`CAPIX_STABLE_VERSION` before download, rather than trusting mutable content:

```bash
CAPIX_STABLE_VERSION=v2.4.8 bash scripts/install.sh latest
```

## macOS

### CapixIDE — Apple silicon

```bash
set -euo pipefail
IDE_VERSION=v2.3.13
IDE_ARCH=arm64
IDE_NAME="CapixIDE-${IDE_VERSION}-darwin-${IDE_ARCH}-unsigned"
IDE_URL="https://github.com/CapIX-Protocol/CapIX-IDE/releases/download/${IDE_VERSION}"

cd ~/Downloads
curl --proto '=https' --tlsv1.2 -fLO "${IDE_URL}/${IDE_NAME}.tar.gz"
curl --proto '=https' --tlsv1.2 -fLO "${IDE_URL}/${IDE_NAME}.tar.gz.sha256"

ACTUAL="$(shasum -a 256 "${IDE_NAME}.tar.gz" | awk '{print $1}')"
EXPECTED="$(awk '{print $1}' "${IDE_NAME}.tar.gz.sha256")"
test "${ACTUAL}" = "${EXPECTED}" || { echo "Checksum mismatch — do not install"; exit 1; }

tar -xzf "${IDE_NAME}.tar.gz"
mkdir -p "${HOME}/Applications"
rm -rf "${HOME}/Applications/CapixIDE.app"
ditto CapixIDE.app "${HOME}/Applications/CapixIDE.app"
open "${HOME}/Applications/CapixIDE.app"
```

The app is unsigned. On the first launch, control-click **CapixIDE** in Applications, choose **Open**, then choose **Open** again. If macOS continues to quarantine the verified app:

```bash
xattr -dr com.apple.quarantine "${HOME}/Applications/CapixIDE.app"
open "${HOME}/Applications/CapixIDE.app"
```

### CapixIDE — Intel Mac

Use the same commands with:

```bash
IDE_ARCH=x64
```

### Capix Code — Apple silicon

```bash
set -euo pipefail
CODE_VERSION=v2.4.8
CODE_ARCH=arm64
CODE_NAME="capix-code-${CODE_VERSION#v}-darwin-${CODE_ARCH}-unsigned"
CODE_URL="https://github.com/CapIX-Protocol/CapIX-Code/releases/download/${CODE_VERSION}"

cd ~/Downloads
curl --proto '=https' --tlsv1.2 -fLO "${CODE_URL}/${CODE_NAME}.tar.gz"
curl --proto '=https' --tlsv1.2 -fLO "${CODE_URL}/${CODE_NAME}.tar.gz.sha256"

ACTUAL="$(shasum -a 256 "${CODE_NAME}.tar.gz" | awk '{print $1}')"
EXPECTED="$(awk '{print $1}' "${CODE_NAME}.tar.gz.sha256")"
test "${ACTUAL}" = "${EXPECTED}" || { echo "Checksum mismatch — do not install"; exit 1; }

tar -xzf "${CODE_NAME}.tar.gz"
rm -rf "${HOME}/.local/share/capix-code"
mkdir -p "${HOME}/.local/share/capix-code" "${HOME}/.local/bin"
ditto customer "${HOME}/.local/share/capix-code"
ln -sfn "${HOME}/.local/share/capix-code/bin/capix-code" "${HOME}/.local/bin/capix-code"
grep -q 'HOME/.local/bin' "${HOME}/.zshrc" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "${HOME}/.zshrc"
export PATH="${HOME}/.local/bin:${PATH}"

capix-code doctor
capix-code login
capix-code auth status
capix-code mcp doctor
capix-code llm-run "Reply with exactly: CAPIX_REMOTE_OK"
```

### Capix Code — Intel Mac

Use the same commands with:

```bash
CODE_ARCH=x64
```

## Linux

The current verified CapixIDE customer artifact supports x86_64 Linux. Capix
Code supports both x86_64 and arm64. These commands install into the current
user's home directory and do not require sudo.

### CapixIDE

```bash
set -euo pipefail
IDE_VERSION=v2.3.13
case "$(uname -m)" in
  x86_64) IDE_ARCH=x64 ;;
  *) echo "No verified CapixIDE artifact is published for this Linux architecture"; exit 1 ;;
esac
IDE_NAME="CapixIDE-${IDE_VERSION}-linux-${IDE_ARCH}-unsigned"
IDE_URL="https://github.com/CapIX-Protocol/CapIX-IDE/releases/download/${IDE_VERSION}"

cd /tmp
curl --proto '=https' --tlsv1.2 -fLO "${IDE_URL}/${IDE_NAME}.tar.gz"
curl --proto '=https' --tlsv1.2 -fLO "${IDE_URL}/${IDE_NAME}.tar.gz.sha256"

ACTUAL="$(sha256sum "${IDE_NAME}.tar.gz" | awk '{print $1}')"
EXPECTED="$(awk '{print $1}' "${IDE_NAME}.tar.gz.sha256")"
test "${ACTUAL}" = "${EXPECTED}" || { echo "Checksum mismatch — do not install"; exit 1; }

rm -rf "${HOME}/.local/share/capixide"
mkdir -p "${HOME}/.local/share/capixide" "${HOME}/.local/bin"
tar -xzf "${IDE_NAME}.tar.gz" -C "${HOME}/.local/share/capixide" --strip-components=1
IDE_BIN="$(find "${HOME}/.local/share/capixide" -maxdepth 3 -type f \( -name capix -o -name capixide \) -perm -111 | head -n 1)"
test -n "${IDE_BIN}" || { echo "CapixIDE executable was not found"; exit 1; }
ln -sfn "${IDE_BIN}" "${HOME}/.local/bin/capixide"
export PATH="${HOME}/.local/bin:${PATH}"

capixide
```

### Capix Code

```bash
set -euo pipefail
CODE_VERSION=v2.4.8
case "$(uname -m)" in
  x86_64) CODE_ARCH=x64 ;;
  aarch64|arm64) CODE_ARCH=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)"; exit 1 ;;
esac
CODE_NAME="capix-code-${CODE_VERSION#v}-linux-${CODE_ARCH}-unsigned"
CODE_URL="https://github.com/CapIX-Protocol/CapIX-Code/releases/download/${CODE_VERSION}"

cd /tmp
curl --proto '=https' --tlsv1.2 -fLO "${CODE_URL}/${CODE_NAME}.tar.gz"
curl --proto '=https' --tlsv1.2 -fLO "${CODE_URL}/${CODE_NAME}.tar.gz.sha256"

ACTUAL="$(sha256sum "${CODE_NAME}.tar.gz" | awk '{print $1}')"
EXPECTED="$(awk '{print $1}' "${CODE_NAME}.tar.gz.sha256")"
test "${ACTUAL}" = "${EXPECTED}" || { echo "Checksum mismatch — do not install"; exit 1; }

tar -xzf "${CODE_NAME}.tar.gz"
rm -rf "${HOME}/.local/share/capix-code"
mkdir -p "${HOME}/.local/share/capix-code" "${HOME}/.local/bin"
cp -a customer/. "${HOME}/.local/share/capix-code/"
ln -sfn "${HOME}/.local/share/capix-code/bin/capix-code" "${HOME}/.local/bin/capix-code"
export PATH="${HOME}/.local/bin:${PATH}"

capix-code --version
capix-code auth status
capix-code mcp doctor
capix-code agent-runtime --stdio &
capix-code doctor
capix-code login
```

Persist the user-local binary directory if it is not already in your shell configuration:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> "${HOME}/.profile"
```

## Windows 11

Open **PowerShell** as the normal user. Administrator access is not required.

### CapixIDE

```powershell
$ErrorActionPreference = "Stop"
$IdeVersion = "v2.3.13"
$IdeName = "CapixIDE-$IdeVersion-win32-x64-unsigned"
$IdeUrl = "https://github.com/CapIX-Protocol/CapIX-IDE/releases/download/$IdeVersion"
$Download = Join-Path $env:USERPROFILE "Downloads"
$Archive = Join-Path $Download "$IdeName.zip"
$Checksum = "$Archive.sha256"

Invoke-WebRequest "$IdeUrl/$IdeName.zip" -OutFile $Archive
Invoke-WebRequest "$IdeUrl/$IdeName.zip.sha256" -OutFile $Checksum

$Actual = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToUpperInvariant()
$Expected = ((Get-Content $Checksum -Raw).Trim() -split "\s+")[0].ToUpperInvariant()
if ($Actual -ne $Expected) { throw "Checksum mismatch — do not install" }

$Install = Join-Path $env:LOCALAPPDATA "Programs\CapixIDE"
if (Test-Path $Install) { Remove-Item $Install -Recurse -Force }
New-Item $Install -ItemType Directory -Force | Out-Null
Expand-Archive $Archive -DestinationPath $Install -Force
$Exe = Get-ChildItem $Install -Recurse -Filter "CapixIDE.exe" | Select-Object -First 1
if (-not $Exe) { throw "CapixIDE.exe was not found" }
Start-Process $Exe.FullName
```

The build is unsigned. If SmartScreen appears, select **More info**, verify the publisher warning and downloaded checksum, then select **Run anyway**.

### Capix Code

```powershell
$ErrorActionPreference = "Stop"
$CodeVersion = "v2.4.8"
$CodeName = "capix-code-$($CodeVersion.TrimStart('v'))-win32-x64-unsigned"
$CodeUrl = "https://github.com/CapIX-Protocol/CapIX-Code/releases/download/$CodeVersion"
$Download = Join-Path $env:USERPROFILE "Downloads"
$Archive = Join-Path $Download "$CodeName.zip"
$Checksum = "$Archive.sha256"

Invoke-WebRequest "$CodeUrl/$CodeName.zip" -OutFile $Archive
Invoke-WebRequest "$CodeUrl/$CodeName.zip.sha256" -OutFile $Checksum

$Actual = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToUpperInvariant()
$Expected = ((Get-Content $Checksum -Raw).Trim() -split "\s+")[0].ToUpperInvariant()
if ($Actual -ne $Expected) { throw "Checksum mismatch — do not install" }

$Install = Join-Path $env:LOCALAPPDATA "Programs\CapixCode"
if (Test-Path $Install) { Remove-Item $Install -Recurse -Force }
New-Item $Install -ItemType Directory -Force | Out-Null
Expand-Archive $Archive -DestinationPath $Install -Force
$Customer = Get-ChildItem $Install -Directory -Filter "customer" -Recurse | Select-Object -First 1
if (-not $Customer) { throw "Capix Code runtime was not found" }

$Bin = Join-Path $Customer.FullName "bin"
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($UserPath -split ";") -notcontains $Bin) {
  [Environment]::SetEnvironmentVariable("Path", (($UserPath.TrimEnd(";") + ";" + $Bin).TrimStart(";")), "User")
}
$env:Path = "$Bin;$env:Path"

capix-code.exe --version
capix-code.exe doctor
capix-code.exe login
```

Open a new PowerShell window after installation so the updated user PATH is inherited.

## Sign in and verify

CapixIDE and Capix Code use browser authentication. Do not paste refresh tokens or wallet private keys into either product.

1. Open CapixIDE and select the Capix activity icon.
2. Select **Sign In** in Profile.
3. Complete the browser wallet-signature flow.
4. Return to CapixIDE and confirm Profile displays the web balance and deployments.
5. In a terminal, verify the installed runtime without invoking paid inference:

```bash
capix-code --version
capix-code auth status
capix-code mcp doctor
capix-code agent-runtime --stdio &
capix-code doctor
capix-code --help
```

Complete `capix-code login`, then verify the authenticated account without
invoking paid inference:

```bash
capix-code auth status
capix-code balance
```

Launch the coding interface and confirm the Capix Auto and SuperGemma model
entries are present before sending a paid request:

```bash
capix-code
```

The default is the single **Capix Auto** entry backed by the live network model catalogue.

## Build from source

Customer installation does not require a source build. Contributors who need
to reproduce the current-platform artifacts should use these pinned toolchains.

### Capix Code

Requirements: Git, Node.js 20 or newer, Rust stable, C/C++ build tools, Bun
`1.3.14` exactly, and network access for the pinned source and dependencies.

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
export PATH="$HOME/.bun/bin:$PATH"
git clone https://github.com/CapIX-Protocol/CapIX-Code.git
cd CapIX-Code
test "$(bun --version)" = "1.3.14"
./scripts/bootstrap.sh
./scripts/rebrand.sh
BUN_BIN="$(command -v bun)" ./scripts/build.sh
./dist/customer/bin/capix-code --version
capix-code auth status
capix-code mcp doctor
capix-code agent-runtime --stdio &
./dist/customer/bin/capix-code doctor
```

On Windows, run the equivalent commands in Git Bash with Rust and Visual Studio
2022 C++ Build Tools installed; the final executable is
`dist/customer/bin/capix-code.exe`.

### CapixIDE

CapixIDE requires exactly Node.js `20.18.2`. On macOS it also requires Xcode
Command Line Tools and GNU libtool. Linux requires the standard Electron/VS Code
desktop build dependencies; Windows requires Visual Studio 2022 Build Tools,
Python, and Git Bash.

```bash
git clone https://github.com/CapIX-Protocol/CapIX-IDE.git
cd CapIX-IDE
nvm install 20.18.2
nvm use 20.18.2
test "$(node --version)" = "v20.18.2"
./scripts/bootstrap.sh
./scripts/build.sh
```

The unsigned output is a `CapixIDE.app` bundle on macOS and a portable CapixIDE
directory on Linux and Windows. The build command prints the exact local path
for the selected platform.
Package and checksum a completed build with the version in `product.json`:

```bash
./scripts/package-release.sh v2.3.13 darwin arm64
```

Replace `darwin arm64` with the platform and architecture actually built. The
verified archive and adjacent SHA-256 file are written to `release-artifacts/`.

## Update

Repeat the relevant installation section with the new version number. Verify the new checksum before replacing the existing installation.

## Uninstall

### macOS

```bash
rm -rf /Applications/CapixIDE.app
rm -rf "${HOME}/.local/share/capix-code"
rm -f "${HOME}/.local/bin/capix-code"
```

### Linux

```bash
rm -rf "${HOME}/.local/share/capixide" "${HOME}/.local/share/capix-code"
rm -f "${HOME}/.local/bin/capixide" "${HOME}/.local/bin/capix-code"
```

### Windows PowerShell

```powershell
Remove-Item "$env:LOCALAPPDATA\Programs\CapixIDE" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:LOCALAPPDATA\Programs\CapixCode" -Recurse -Force -ErrorAction SilentlyContinue
```
