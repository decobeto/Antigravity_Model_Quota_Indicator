const { exec } = require('child_process');
const http = require('http');
const util = require('util');

const execAsync = util.promisify(exec);

class QuotaService {
  constructor() {
    this.cachedPort = null;
    this.cachedToken = null;
    this.cachedPid = null;
  }

  /**
   * Find running language_server process cross-platform (Windows, Linux, macOS)
   * Extracts CSRF token and PID.
   */
  async discoverProcessInfo() {
    let commandLine = '';
    let pid = null;

    if (process.platform === 'win32') {
      try {
        const { stdout } = await execAsync(
          'powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \\"Name LIKE \'%language_server%\'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json"'
        );
        if (stdout && stdout.trim()) {
          const parsed = JSON.parse(stdout.trim());
          const item = Array.isArray(parsed) ? parsed[0] : parsed;
          if (item) {
            commandLine = item.CommandLine || '';
            pid = item.ProcessId;
          }
        }
      } catch (err) {
        // Fallback for wmic if powershell fails
        try {
          const { stdout } = await execAsync('wmic process where "name like \'%language_server%\'" get processid,commandline /format:list');
          commandLine = stdout;
          const pidMatch = stdout.match(/ProcessId=(\d+)/i);
          if (pidMatch) pid = parseInt(pidMatch[1], 10);
        } catch (e) {
          console.error('[QuotaService] Error running wmic/powershell:', e);
        }
      }
    } else {
      // Linux / macOS process discovery
      try {
        const { stdout } = await execAsync('ps aux');
        const lines = stdout.split('\n');
        for (const line of lines) {
          if (line.includes('language_server') && !line.includes('grep')) {
            commandLine = line;
            const parts = line.trim().split(/\s+/);
            if (parts.length > 1 && !isNaN(parts[1])) {
              pid = parseInt(parts[1], 10);
            }
            break;
          }
        }
      } catch (e) {
        console.error('[QuotaService] Error running ps:', e);
      }
    }

    if (!commandLine) {
      throw new Error('Antigravity Language Server process not found.');
    }

    const tokenMatch = commandLine.match(/--csrf_token\s+([a-f0-9-]+)/i);
    if (!tokenMatch) {
      throw new Error('CSRF token not found in Language Server process arguments.');
    }

    return {
      csrfToken: tokenMatch[1],
      pid: pid
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
        // lsof -a -iTCP -sTCP:LISTEN -p <pid> -n -P
        const { stdout } = await execAsync(`lsof -a -iTCP -sTCP:LISTEN -p ${pid} -n -P`);
        const matches = stdout.matchAll(/:(\d+)\s+\(LISTEN\)/g);
        for (const m of matches) {
          const p = parseInt(m[1], 10);
          if (p && !ports.includes(p)) ports.push(p);
        }
      } catch (e) {
        // Fallback with netstat / ss
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

    // Default candidates if specific process port search returned empty
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
