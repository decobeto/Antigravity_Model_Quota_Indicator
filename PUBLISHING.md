# Publishing & Cross-Platform Compatibility Guide 🚀

This document covers cross-platform support (Windows, Linux, macOS) and step-by-step instructions for publishing the **Antigravity Model Quota Indicator** extension under publisher `deco_beto` to extension marketplaces (Open VSX and VS Code Marketplace).

---

## 🌐 Cross-Platform Architecture

The extension is designed to run natively without native C++ binary dependencies across all major platforms:

### 1. Windows 🪟
- **Process Discovery**: Executes PowerShell `Get-CimInstance Win32_Process` (fallback to `wmic`) to inspect `language_server_windows_x64.exe` command-line arguments and extract `--csrf_token`.
- **Port Discovery**: Uses `Get-NetTCPConnection` to list listening TCP ports owned by the language server PID.

### 2. Linux 🐧
- **Process Discovery**: Executes `ps aux` to find `language_server` process instances and parse `--csrf_token`.
- **Port Discovery**: Executes `lsof -a -iTCP -sTCP:LISTEN -p <PID>` (fallback to `ss -tulpn` and `netstat`).

### 3. macOS 🍎
- **Process Discovery**: Executes `ps aux` identifying `language_server_macos_x64` / `language_server_macos_arm64` processes.
- **Port Discovery**: Executes `lsof -a -iTCP -sTCP:LISTEN -p <PID>` and `netstat -anv`.

---

## 🏬 Marketplace Publishing Guide

Antigravity IDE (built on Code-OSS) utilizes the **Open VSX Registry** (`open-vsx.org`) as its primary extension marketplace, while also supporting local `.vsix` installation and Visual Studio Marketplace packages.

### Package Artifact

Pre-built VSIX package ready for deployment:
`antigravity-quota-status-1.0.1.vsix`

---

### Option A: Publish to Open VSX Registry (Default Antigravity IDE Marketplace)

1. Register an account on [open-vsx.org](https://open-vsx.org/).
2. Create your publisher namespace (`deco_beto`).
3. Generate an Access Token under *Settings -> Access Tokens*.
4. Publish using `ovsx`:
   ```bash
   npx ovsx publish antigravity-quota-status-1.0.1.vsix -p <YOUR_OPEN_VSX_ACCESS_TOKEN>
   ```

---

### Option B: Publish to Visual Studio Marketplace (VS Code Marketplace)

1. Visit the [VS Code Marketplace Management Portal](https://marketplace.visualstudio.com/manage).
2. Create an Azure DevOps organization and generate a Personal Access Token (PAT) with `Marketplace (Publish)` scope.
3. Publish using `@vscode/vsce`:
   ```bash
   npx vsce publish -p <YOUR_PERSONAL_ACCESS_TOKEN>
   ```

---

### Option C: Manual `.vsix` Installation

To install manually from the command line:
```bash
antigravity-ide --install-extension antigravity-quota-status-1.0.1.vsix
```
Or in the Antigravity IDE UI: **Extensions** -> `...` -> **Install from VSIX...**
