const k8s = require("@kubernetes/client-node");
const crypto = require("crypto");
const ProvisionerBackend = require("./interface");

class K8sBackend extends ProvisionerBackend {
  constructor() {
    super();
    this.kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) {
      this.kc.loadFromFile(process.env.KUBECONFIG);
    } else {
      this.kc.loadFromCluster(); // in-cluster config
    }
    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    this.namespace = process.env.K8S_NAMESPACE || "openclaw-agents";
  }

  async _ensureNamespace() {
    try {
      await this.coreApi.readNamespace(this.namespace);
    } catch {
      await this.coreApi.createNamespace({
        metadata: { name: this.namespace },
      });
    }
  }

  async create(config) {
    const { id, name, image, vcpu, ram_mb, env } = config;
    const deployName = `oclaw-agent-${id}`;

    await this._ensureNamespace();

    console.log(`[k8s] Creating deployment ${deployName}`);

    // Generate per-agent Gateway auth token
    const gatewayToken = crypto.randomBytes(16).toString("hex");

    // Derive deterministic Ed25519 device identity from gatewayToken
    const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
    const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
    const seed = crypto.createHash("sha256").update("openclaw-device:" + gatewayToken).digest();
    const privateDer = Buffer.concat([PKCS8_PREFIX, seed]);
    const privateKey = crypto.createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
    const publicKey = crypto.createPublicKey(privateKey);
    const spki = publicKey.export({ type: "spki", format: "der" });
    const rawPub = spki.subarray(ED25519_SPKI_PREFIX.length);
    const deviceId = crypto.createHash("sha256").update(rawPub).digest("hex");
    const pubB64 = rawPub.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
    const allScopes = ["operator.admin","operator.read","operator.write","operator.approvals","operator.pairing"];
    const nowMs = Date.now();
    const pairedJson = JSON.stringify({
      [deviceId]: {
        deviceId, publicKey: pubB64, platform: "linux", clientId: "gateway-client",
        clientMode: "backend", role: "operator", roles: ["operator"],
        scopes: allScopes, approvedScopes: allScopes,
        tokens: { operator: { token: crypto.randomBytes(32).toString("hex"), role: "operator", scopes: allScopes, createdAtMs: nowMs } },
        createdAtMs: nowMs, approvedAtMs: nowMs,
      }
    });

    const envVars = env
      ? Object.entries(env).map(([k, v]) => ({ name: k, value: String(v) }))
      : [];
    envVars.push({ name: "OPENCLAW_GATEWAY_TOKEN", value: gatewayToken });

    // CMD: install openclaw, configure gateway with pre-paired device, start it
    const escapedPaired = pairedJson.replace(/'/g, "'\\''");
    const gatewayCmd = [
      "sh", "-c",
      'apt-get update -qq && apt-get install -y -qq git > /dev/null 2>&1 && ' +
      'npm install -g openclaw@latest 2>&1 && ' +
      'mkdir -p ~/.openclaw/devices && ' +
      `echo '{"gateway":{"port":18789,"bind":"lan","mode":"local"}}' > ~/.openclaw/openclaw.json && ` +
      `echo '${escapedPaired}' > ~/.openclaw/devices/paired.json && ` +
      `echo '{}' > ~/.openclaw/devices/pending.json && ` +
      `openclaw gateway --port 18789 --password ${gatewayToken}`
    ];

    const deployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: deployName,
        namespace: this.namespace,
        labels: {
          app: "openclaw-agent",
          "openclaw.agent.id": String(id),
        },
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: { "openclaw.agent.id": String(id) },
        },
        template: {
          metadata: {
            labels: {
              app: "openclaw-agent",
              "openclaw.agent.id": String(id),
            },
          },
          spec: {
            // DNS-safe hostname from agent name (avoids Bonjour conflicts)
            hostname: (name || `agent-${id}`)
              .toLowerCase()
              .replace(/[^a-z0-9-]/g, '-')
              .replace(/-+/g, '-')
              .replace(/^-|-$/g, '')
              .slice(0, 63) || `agent-${id}`,
            containers: [
              {
                name: "agent",
                image: image || "node:22-slim",
                command: gatewayCmd.slice(0, 2),
                args: [gatewayCmd[2]],
                env: envVars,
                ports: [{ containerPort: 18789 }],
                resources: {
                  requests: {
                    cpu: `${(vcpu || 2) * 1000}m`,
                    memory: `${ram_mb || 2048}Mi`,
                  },
                  limits: {
                    cpu: `${(vcpu || 2) * 1000}m`,
                    memory: `${ram_mb || 2048}Mi`,
                  },
                },
              },
            ],
          },
        },
      },
    };

    await this.appsApi.createNamespacedDeployment(this.namespace, deployment);

    // Create a ClusterIP service so it's addressable on port 18789
    const service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: deployName,
        namespace: this.namespace,
      },
      spec: {
        selector: { "openclaw.agent.id": String(id) },
        ports: [{ port: 18789, targetPort: 18789 }],
        type: "ClusterIP",
      },
    };

    try {
      await this.coreApi.createNamespacedService(this.namespace, service);
    } catch {
      // service may already exist
    }

    const host = `${deployName}.${this.namespace}.svc.cluster.local`;
    console.log(`[k8s] Deployment ${deployName} created -> ${host} (gateway port 18789)`);
    return { containerId: deployName, host, gatewayToken };
  }

  async destroy(containerId) {
    const deployName = containerId;
    console.log(`[k8s] Destroying deployment ${deployName}`);

    try {
      await this.appsApi.deleteNamespacedDeployment(
        deployName,
        this.namespace
      );
    } catch {
      // already gone
    }
    try {
      await this.coreApi.deleteNamespacedService(deployName, this.namespace);
    } catch {
      // already gone
    }
    console.log(`[k8s] Deployment ${deployName} deleted`);
  }

  async status(containerId) {
    const deployName = containerId;
    try {
      const res = await this.appsApi.readNamespacedDeployment(
        deployName,
        this.namespace
      );
      const status = res.body.status;
      const running = (status.availableReplicas || 0) > 0;
      return { running, uptime: null, cpu: null, memory: null };
    } catch {
      return { running: false, uptime: 0, cpu: null, memory: null };
    }
  }

  async stop(containerId) {
    const deployName = containerId;
    console.log(`[k8s] Stopping deployment ${deployName} (scaling to 0)`);
    await this.appsApi.patchNamespacedDeployment(
      deployName,
      this.namespace,
      { spec: { replicas: 0 } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { "Content-Type": "application/strategic-merge-patch+json" } }
    );
    console.log(`[k8s] Deployment ${deployName} scaled to 0`);
  }

  async start(containerId) {
    const deployName = containerId;
    console.log(`[k8s] Starting deployment ${deployName} (scaling to 1)`);
    await this.appsApi.patchNamespacedDeployment(
      deployName,
      this.namespace,
      { spec: { replicas: 1 } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { "Content-Type": "application/strategic-merge-patch+json" } }
    );
    console.log(`[k8s] Deployment ${deployName} scaled to 1`);
  }

  async restart(containerId) {
    const deployName = containerId;
    console.log(`[k8s] Restarting deployment ${deployName}`);
    await this.appsApi.patchNamespacedDeployment(
      deployName,
      this.namespace,
      {
        spec: {
          template: {
            metadata: {
              annotations: {
                "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
              },
            },
          },
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { headers: { "Content-Type": "application/strategic-merge-patch+json" } }
    );
    console.log(`[k8s] Deployment ${deployName} rollout restart triggered`);
  }

  /**
   * Execute a command inside a pod of the deployment (for terminal).
   * Returns { exec, stream } compatible with the Docker backend.
   */
  async exec(containerId, opts = {}) {
    const deployName = containerId;
    const exec = new k8s.Exec(this.kc);

    // Find a running pod for this deployment
    const pods = await this.coreApi.listNamespacedPod(
      this.namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `openclaw.agent.id=${deployName.replace("oclaw-agent-", "")}`
    );
    const runningPod = (pods.body.items || []).find(
      (p) => p.status?.phase === "Running"
    );
    if (!runningPod) return null;

    return { podName: runningPod.metadata.name, exec, namespace: this.namespace };
  }

  /**
   * Stream logs from a pod of the deployment.
   */
  async logs(containerId, opts = {}) {
    const deployName = containerId;
    const log = new k8s.Log(this.kc);

    const pods = await this.coreApi.listNamespacedPod(
      this.namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      `openclaw.agent.id=${deployName.replace("oclaw-agent-", "")}`
    );
    const runningPod = (pods.body.items || []).find(
      (p) => p.status?.phase === "Running"
    );
    if (!runningPod) return null;

    const stream = new (require("stream").PassThrough)();
    await log.log(
      this.namespace,
      runningPod.metadata.name,
      "agent",
      stream,
      { follow: opts.follow !== false, tailLines: opts.tail || 100, timestamps: true }
    );
    return stream;
  }
}

module.exports = K8sBackend;
