const { exec } = require('child_process');
const http = require('http');
const util = require('util');

const execAsync = util.promisify(exec);

let vscode = null;
try {
  vscode = require('vscode');
} catch (e) {
  // Running outside VS Code extension host (e.g. test scripts)
}

class QuotaService {
  constructor() {
    this.cachedPort = null;
    this.cachedToken = null;
    this.cachedPid = null;
  }

  /**
   * Query candidate language_server processes efficiently on Windows, Linux, and macOS
   */
  async getCandidateProcesses() {
    const candidates = [];

    if (process.platform === 'win32') {
      try {
        const { stdout } = await execAsync(
          'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \\"Name LIKE \'%language_server%\'\\" | Select-Object ProcessId, ParentProcessId, CommandLine | ConvertTo-Json -Compress"'
        );
        if (stdout?.trim()) {
          const parsed = JSON.parse(stdout.trim());
          const list = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of list) {
            if (item?.CommandLine && /--csrf_token\s+[a-f0-9-]+/i.test(item.CommandLine)) {
              candidates.push({
                pid: Number(item.ProcessId),
                ppid: Number(item.ParentProcessId) || null,
                commandLine: item.CommandLine
              });
            }
          }
        }
      } catch (e) {
        // Fallback to wmic if PowerShell is restricted
        try {
          const { stdout } = await execAsync('wmic process where "name like \'%language_server%\'" get processid,parentprocessid,commandline /format:list');
          const pids = [...stdout.matchAll(/ProcessId=(\d+)/gi)];
          const ppids = [...stdout.matchAll(/ParentProcessId=(\d+)/gi)];
          const cmdLines = [...stdout.matchAll(/CommandLine=(.+)/gi)];
          for (let i = 0; i < pids.length; i++) {
            const cmd = cmdLines[i]?.[1]?.trim() || '';
            if (/--csrf_token\s+[a-f0-9-]+/i.test(cmd)) {
              candidates.push({
                pid: parseInt(pids[i][1], 10),
                ppid: ppids[i] ? parseInt(ppids[i][1], 10) : null,
                commandLine: cmd
              });
            }
          }
        } catch (errWmic) {
          console.error('[QuotaService] Error in wmic fallback:', errWmic);
        }
      }
    } else {
      // Linux / macOS: query only processes containing language_server
      try {
        const { stdout } = await execAsync('ps -eo pid,ppid,command | grep language_server | grep -v grep');
        const lines = stdout.split('\n');
        for (const line of lines) {
          const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
          if (match && /--csrf_token\s+[a-f0-9-]+/i.test(match[3])) {
            candidates.push({
              pid: Number(match[1]),
              ppid: Number(match[2]),
              commandLine: match[3]
            });
          }
        }
      } catch (e) {
        // Fallback for ps aux if ps -eo has format differences
        try {
          const { stdout } = await execAsync('ps aux | grep language_server | grep -v grep');
          const lines = stdout.split('\n');
          for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            const cmd = parts.slice(10).join(' ');
            if (parts.length > 1 && /--csrf_token\s+[a-f0-9-]+/i.test(cmd)) {
              candidates.push({
                pid: parseInt(parts[1], 10),
                ppid: null,
                commandLine: cmd
              });
            }
          }
        } catch (errPs) {
          console.error('[QuotaService] Error in ps fallback:', errPs);
        }
      }
    }

    return candidates;
  }

  /**
   * Find language_server process with intelligent disambiguation for multi-window environments
   */
  async discoverProcessInfo() {
    const candidates = await this.getCandidateProcesses();

    if (candidates.length === 0) {
      throw new Error('Antigravity Language Server process not found.');
    }

    // Default to first candidate
    let chosen = candidates[0];

    // If multiple candidates exist, attempt to match the current workspace
    if (candidates.length > 1 && vscode?.workspace?.workspaceFolders?.length) {
      const currentWorkspacePath = vscode.workspace.workspaceFolders[0].uri.fsPath.toLowerCase();

      const workspaceMatch = candidates.find(c => {
        const match = c.commandLine.match(/--workspace_id\s+([^\s]+)/i);
        if (!match) return false;
        // The workspace_id parameter typically encodes the path, e.g. file_c_3A_Users_...
        const rawId = match[1].toLowerCase();
        const cleanPath = decodeURIComponent(rawId.replace(/^file_/, '').replace(/_/g, '/'));
        return currentWorkspacePath.includes(cleanPath) || cleanPath.includes(currentWorkspacePath) || rawId.includes(encodeURIComponent(currentWorkspacePath).toLowerCase());
      });

      if (workspaceMatch) {
        chosen = workspaceMatch;
      }
    }

    const tokenMatch = chosen.commandLine.match(/--csrf_token\s+([a-f0-9-]+)/i);
    if (!tokenMatch) {
      throw new Error('CSRF token not found in Language Server process arguments.');
    }

    return {
      csrfToken: tokenMatch[1],
      pid: chosen.pid
    };
  }

  /**
   * Get all TCP listening ports for a specific PID cross-platform
   */
  async getListeningPorts(pid) {
    const ports = [];

    if (process.platform === 'win32' && pid) {
      try {
        const { stdout } = await execAsync(
          `powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort | ConvertTo-Json"`
        );
        if (stdout && stdout.trim()) {
          const parsed = JSON.parse(stdout.trim());
          const items = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of items) {
            if (item && item.LocalPort && !ports.includes(item.LocalPort)) {
              ports.push(item.LocalPort);
            }
          }
        }
      } catch (err) {
        // fallback
      }
    } else if ((process.platform === 'linux' || process.platform === 'darwin') && pid) {
      try {
        const { stdout } = await execAsync(`lsof -a -iTCP -sTCP:LISTEN -p ${pid} -n -P`);
        const matches = stdout.matchAll(/:(\d+)\s+\(LISTEN\)/g);
        for (const m of matches) {
          const p = parseInt(m[1], 10);
          if (p && !ports.includes(p)) ports.push(p);
        }
      } catch (e) {
        try {
          const { stdout } = await execAsync('netstat -anv | grep LISTEN');
          const matches = stdout.matchAll(/\.([0-9]+)\s+.*LISTEN/g);
          for (const m of matches) {
            const p = parseInt(m[1], 10);
            if (p > 1024 && !ports.includes(p)) ports.push(p);
          }
        } catch (e2) {}
      }
    }

    // Default candidate ports if specific process port search returned empty
    const defaultCandidates = [53530, 53527, 53529, 53533, 53534, 53538, 53541, 53552];
    for (const p of defaultCandidates) {
      if (!ports.includes(p)) ports.push(p);
    }

    return ports;
  }

  /**
   * Make HTTP Connect RPC request
   */
  makeRpcRequest(port, token, path, bodyObj = {}) {
    return new Promise((resolve) => {
      const postData = JSON.stringify(bodyObj);
      const req = http.request({
        hostname: '127.0.0.1',
        port: port,
        path: path,
        method: 'POST',
        timeout: 3000,
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': token,
          'connect-protocol-version': '1',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve({ success: true, data: JSON.parse(data) });
            } catch (e) {
              resolve({ success: false, status: res.statusCode, raw: data });
            }
          } else {
            resolve({ success: false, status: res.statusCode, raw: data });
          }
        });
      });

      req.on('error', (err) => resolve({ success: false, error: err.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'timeout' });
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Discover active connection params (port & token)
   */
  async connect() {
    // Test cached port first if available
    if (this.cachedPort && this.cachedToken) {
      const testRes = await this.makeRpcRequest(
        this.cachedPort,
        this.cachedToken,
        '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
      );
      if (testRes.success) {
        return { port: this.cachedPort, token: this.cachedToken };
      }
    }

    const processInfo = await this.discoverProcessInfo();
    const ports = await this.getListeningPorts(processInfo.pid);

    for (const port of ports) {
      const res = await this.makeRpcRequest(
        port,
        processInfo.csrfToken,
        '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
      );
      if (res.success) {
        this.cachedPort = port;
        this.cachedToken = processInfo.csrfToken;
        this.cachedPid = processInfo.pid;
        return { port, token: processInfo.csrfToken };
      }
    }

    throw new Error('Could not connect to active Language Server RPC port.');
  }

  /**
   * Fetch current model quota summary
   */
  async fetchQuotaSummary() {
    const { port, token } = await this.connect();
    const res = await this.makeRpcRequest(
      port,
      token,
      '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
    );

    if (!res.success) {
      throw new Error(`Failed to retrieve quota summary: HTTP ${res.status}`);
    }

    return res.data?.response || res.data;
  }

  /**
   * Fetch user status (email, user tier)
   */
  async fetchUserStatus() {
    try {
      const { port, token } = await this.connect();
      const res = await this.makeRpcRequest(
        port,
        token,
        '/exa.language_server_pb.LanguageServerService/GetUserStatus'
      );
      if (res.success) {
        return res.data;
      }
    } catch (err) {
      console.error('[QuotaService] Error fetching user status:', err);
    }
    return null;
  }
}

module.exports = { QuotaService };
