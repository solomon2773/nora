// @ts-nocheck
const https = require("https");
const { URL } = require("url");
const ProvisionerBackend = require("./interface");
const {
  buildTelemetry,
  buildUnavailableTelemetry,
  PROXMOX_DEFAULT_CAPABILITIES,
  bytesToMegabytes,
  roundMetric,
  toFiniteInteger,
} = require("./telemetry");
const {
  PROXMOX_RELEASE_BLOCKER_ISSUE,
} = require("../../../agent-runtime/lib/backendCatalog");

class ProxmoxBackend extends ProvisionerBackend {
  constructor() {
    super();
    this.baseUrl = process.env.PROXMOX_API_URL; // e.g. https://pve.example.com:8006/api2/json
    this.tokenId = process.env.PROXMOX_TOKEN_ID; // e.g. root@pam!openclaw
    this.tokenSecret = process.env.PROXMOX_TOKEN_SECRET;
    this.node = process.env.PROXMOX_NODE || "pve";
    this.template = process.env.PROXMOX_TEMPLATE || "local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst";
    this.timeoutMs = 60000;
  }

  async _request(method, path, payload) {
    if (!this.baseUrl || !this.tokenId || !this.tokenSecret) {
      throw new Error("Proxmox API is not configured");
    }

    const base = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
    const url = new URL(path.replace(/^\//, ""), base);
    const body = payload == null ? null : JSON.stringify(payload);
    const headers = {
      Authorization: `PVEAPIToken=${this.tokenId}=${this.tokenSecret}`,
    };

    if (body != null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method,
          headers,
          rejectUnauthorized: false,
          timeout: this.timeoutMs,
        },
        (res) => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            raw += chunk;
          });
          res.on("end", () => {
            let parsed = {};

            if (raw) {
              try {
                parsed = JSON.parse(raw);
              } catch (error) {
                reject(new Error(`Invalid Proxmox response: ${error.message}`));
                return;
              }
            }

            const statusCode = res.statusCode || 500;
            if (statusCode < 200 || statusCode >= 300) {
              const detail =
                parsed?.errors
                  ? JSON.stringify(parsed.errors)
                  : parsed?.message || raw || `HTTP ${statusCode}`;
              reject(new Error(detail));
              return;
            }

            resolve(parsed);
          });
        }
      );

      req.on("timeout", () => {
        req.destroy(new Error("Proxmox API timeout"));
      });
      req.on("error", reject);

      if (body != null) {
        req.write(body);
      }

      req.end();
    });
  }

  async _requestData(method, path, payload) {
    const response = await this._request(method, path, payload);
    return response?.data;
  }

  async _getNextVmid() {
    return this._requestData("GET", "/cluster/nextid");
  }

  async create() {
    throw new Error(PROXMOX_RELEASE_BLOCKER_ISSUE);
  }

  async destroy(containerId) {
    const vmid = containerId;
    console.log(`[proxmox] Destroying LXC ${vmid}`);
    try {
      await this._requestData("POST", `/nodes/${this.node}/lxc/${vmid}/status/stop`);
      // Wait for stop
      await new Promise((r) => setTimeout(r, 5000));
    } catch {
      // already stopped
    }
    await this._requestData("DELETE", `/nodes/${this.node}/lxc/${vmid}`);
    console.log(`[proxmox] LXC ${vmid} deleted`);
  }

  async status(containerId) {
    const vmid = containerId;
    try {
      const data = await this._requestData(
        "GET",
        `/nodes/${this.node}/lxc/${vmid}/status/current`
      );
      return {
        running: data.status === "running",
        uptime: data.uptime || 0,
        cpu: data.cpu || 0,
        memory: data.mem || 0,
      };
    } catch {
      return { running: false, uptime: 0, cpu: null, memory: null };
    }
  }

  async stats(containerId) {
    const vmid = containerId;

    try {
      const data = await this._requestData(
        "GET",
        `/nodes/${this.node}/lxc/${vmid}/status/current`
      );

      const cpuPercent =
        typeof data?.cpu === "number" ? roundMetric(data.cpu * 100) : null;
      const memoryUsageMb = bytesToMegabytes(data?.mem, 0);
      const memoryLimitMb = bytesToMegabytes(data?.maxmem, 0);
      const memoryPercent =
        typeof data?.mem === "number" && typeof data?.maxmem === "number" && data.maxmem > 0
          ? roundMetric((data.mem / data.maxmem) * 100)
          : null;
      const networkRxMb = bytesToMegabytes(data?.netin);
      const networkTxMb = bytesToMegabytes(data?.netout);
      const diskReadMb = bytesToMegabytes(data?.diskread);
      const diskWriteMb = bytesToMegabytes(data?.diskwrite);
      const pids = toFiniteInteger(data?.pid ?? data?.pids);

      const capabilities = {
        cpu: cpuPercent != null,
        memory: memoryUsageMb != null || memoryLimitMb != null,
        network: networkRxMb != null || networkTxMb != null,
        disk: diskReadMb != null || diskWriteMb != null,
        pids: pids != null,
      };

      return buildTelemetry({
        backendType: "proxmox",
        capabilities,
        current: {
          recorded_at: new Date().toISOString(),
          running: data?.status === "running",
          uptime_seconds:
            data?.status === "running" ? toFiniteInteger(data?.uptime) ?? 0 : 0,
          cpu_percent: cpuPercent,
          memory_usage_mb: memoryUsageMb,
          memory_limit_mb: memoryLimitMb,
          memory_percent: memoryPercent,
          network_rx_mb: networkRxMb,
          network_tx_mb: networkTxMb,
          disk_read_mb: diskReadMb,
          disk_write_mb: diskWriteMb,
          pids,
        },
      });
    } catch {
      return buildUnavailableTelemetry({
        backendType: "proxmox",
        running: false,
        capabilities: PROXMOX_DEFAULT_CAPABILITIES,
      });
    }
  }

  async stop(containerId) {
    const vmid = containerId;
    console.log(`[proxmox] Stopping LXC ${vmid}`);
    await this._requestData("POST", `/nodes/${this.node}/lxc/${vmid}/status/shutdown`, { timeout: 30 });
    // Wait for graceful shutdown, then force-stop if needed
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await this.status(vmid);
      if (!s.running) {
        console.log(`[proxmox] LXC ${vmid} stopped`);
        return;
      }
    }
    // Force stop
    await this._requestData("POST", `/nodes/${this.node}/lxc/${vmid}/status/stop`);
    console.log(`[proxmox] LXC ${vmid} force-stopped`);
  }

  async start(containerId) {
    const vmid = containerId;
    console.log(`[proxmox] Starting LXC ${vmid}`);
    await this._requestData("POST", `/nodes/${this.node}/lxc/${vmid}/status/start`);
    // Wait for it to be running
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = await this.status(vmid);
      if (s.running) {
        console.log(`[proxmox] LXC ${vmid} started`);
        return;
      }
    }
    console.warn(`[proxmox] LXC ${vmid} start — may still be booting`);
  }

  async restart(containerId) {
    const vmid = containerId;
    console.log(`[proxmox] Restarting LXC ${vmid}`);
    await this._requestData("POST", `/nodes/${this.node}/lxc/${vmid}/status/reboot`);
    console.log(`[proxmox] LXC ${vmid} reboot requested`);
  }

  /**
   * Inject the OpenClaw agent runtime into an LXC container via pct exec.
   * Requires the runtime directory to be accessible on the Proxmox host.
   */
  async injectRuntime() {
    throw new Error(PROXMOX_RELEASE_BLOCKER_ISSUE);
  }
}

module.exports = ProxmoxBackend;
