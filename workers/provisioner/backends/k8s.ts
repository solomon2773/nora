// @ts-nocheck
const k8s = require("@kubernetes/client-node");
const crypto = require("crypto");
const ProvisionerBackend = require("./interface");
const {
  buildOpenClawInstallCommand,
  buildRuntimeBootstrapCommand,
  buildTemplatePayloadBootstrapCommand,
  buildRuntimeEnv,
} = require("../../../agent-runtime/lib/runtimeBootstrap");
const { OPENCLAW_GATEWAY_PORT, AGENT_RUNTIME_PORT } = require("../../../agent-runtime/lib/contracts");
const {
  buildContainerBootstrap,
  toK8sLaunch,
} = require("../../../agent-runtime/lib/containerCommand");

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
    this.exposureMode = (process.env.K8S_EXPOSURE_MODE || "cluster-ip").toLowerCase();
  }

  _normalizePort(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  _isNodePortExposure() {
    return this.exposureMode === "node-port";
  }

  _servicePorts() {
    const ports = [
      { name: "gateway", port: OPENCLAW_GATEWAY_PORT, targetPort: OPENCLAW_GATEWAY_PORT },
      { name: "runtime", port: AGENT_RUNTIME_PORT, targetPort: AGENT_RUNTIME_PORT },
    ];

    if (!this._isNodePortExposure()) {
      return ports;
    }

    const configuredGatewayNodePort = this._normalizePort(process.env.K8S_GATEWAY_NODE_PORT);
    const configuredRuntimeNodePort = this._normalizePort(process.env.K8S_RUNTIME_NODE_PORT);

    if (configuredGatewayNodePort) {
      ports[0].nodePort = configuredGatewayNodePort;
    }
    if (configuredRuntimeNodePort) {
      ports[1].nodePort = configuredRuntimeNodePort;
    }

    return ports;
  }

  _servicePortsWithoutNodePorts(ports = []) {
    return ports.map(({ nodePort, ...port }) => ({ ...port }));
  }

  _errorBodyText(error) {
    // v1.x error bodies arrive as strings on `error.body` or `error.responseBody`;
    // some flows expose them on `error.cause.body`. Stringify whatever we find.
    return String(
      error?.body?.message ||
      error?.body ||
      error?.responseBody ||
      error?.cause?.body ||
      error?.message ||
      ""
    );
  }

  _errorStatus(error) {
    return error?.statusCode || error?.code || error?.response?.status || null;
  }

  _isAlreadyExistsError(error) {
    const text = this._errorBodyText(error);
    return (
      this._errorStatus(error) === 409 ||
      /\b409\b|already exists|AlreadyExists/i.test(text)
    );
  }

  _isNodePortConflictError(error) {
    const text = this._errorBodyText(error);
    const status = this._errorStatus(error);
    return (
      (status === 422 || /\b422\b|Invalid/i.test(text)) &&
      /nodeport|provided port is already allocated/i.test(text)
    );
  }

  async _ensureNamespace() {
    try {
      await this.coreApi.readNamespace({ name: this.namespace });
    } catch {
      await this.coreApi.createNamespace({
        body: {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: { name: this.namespace },
        },
      });
    }
  }

  async create(config) {
    const { id, name, image, vcpu, ram_mb, env, templatePayload } = config;
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

    const envVars = Object.entries({
      ...(env || {}),
      ...buildRuntimeEnv(),
      OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    }).map(([k, v]) => ({ name: k, value: String(v) }));

    // CMD: install openclaw, configure gateway with pre-paired device, start the
    // runtime sidecar, then launch the gateway.
    const escapedPaired = pairedJson.replace(/'/g, "'\\''");
    const runtimeBootstrapCmd = buildRuntimeBootstrapCommand();
    const templateBootstrapCmd = buildTemplatePayloadBootstrapCommand(templatePayload);
    const ensureOpenClawCmd = buildOpenClawInstallCommand(["openclaw@latest"]);
    const gatewayScript =
      ensureOpenClawCmd +
      'mkdir -p ~/.openclaw/devices && ' +
      `echo '{"gateway":{"port":${OPENCLAW_GATEWAY_PORT},"bind":"lan","mode":"local"}}' > ~/.openclaw/openclaw.json && ` +
      `echo '${escapedPaired}' > ~/.openclaw/devices/paired.json && ` +
      `echo '{}' > ~/.openclaw/devices/pending.json && ` +
      templateBootstrapCmd +
      runtimeBootstrapCmd +
      '"$OPENCLAW_BIN" gateway --port ' + OPENCLAW_GATEWAY_PORT + ` --password ${gatewayToken}`;
    const gatewayLaunch = toK8sLaunch(buildContainerBootstrap(gatewayScript));

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
                image: image || "node:24-slim",
                command: gatewayLaunch.command,
                args: gatewayLaunch.args,
                env: envVars,
                ports: [
                  { name: "gateway", containerPort: OPENCLAW_GATEWAY_PORT },
                  { name: "runtime", containerPort: AGENT_RUNTIME_PORT },
                ],
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

    try {
      await this.appsApi.createNamespacedDeployment({ namespace: this.namespace, body: deployment });
    } catch (error) {
      if (!this._isAlreadyExistsError(error)) throw error;
      console.warn(`[k8s] Deployment ${deployName} already exists; reusing on retry`);
    }

    // Create a service that exposes both the control-plane gateway and runtime
    // sidecar. Default is ClusterIP for in-cluster control planes; local kind
    // verification uses NodePort so the Docker-hosted backend can reach it.
    const service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: deployName,
        namespace: this.namespace,
      },
      spec: {
        selector: { "openclaw.agent.id": String(id) },
        ports: this._servicePorts(),
        type: this._isNodePortExposure() ? "NodePort" : "ClusterIP",
      },
    };

    let serviceResp = null;
    try {
      serviceResp = await this.coreApi.createNamespacedService({ namespace: this.namespace, body: service });
    } catch (error) {
      if (this._isAlreadyExistsError(error)) {
        serviceResp = await this.coreApi.readNamespacedService({ name: deployName, namespace: this.namespace });
      } else if (
        this._isNodePortExposure() &&
        service.spec.ports.some((port) => port.nodePort != null) &&
        this._isNodePortConflictError(error)
      ) {
        console.warn(
          `[k8s] Fixed NodePort allocation unavailable for ${deployName}; retrying with dynamic NodePorts`
        );
        const dynamicService = {
          ...service,
          spec: {
            ...service.spec,
            ports: this._servicePortsWithoutNodePorts(service.spec.ports),
          },
        };
        serviceResp = await this.coreApi.createNamespacedService({ namespace: this.namespace, body: dynamicService });
      } else {
        throw error;
      }
    }

    const host = `${deployName}.${this.namespace}.svc.cluster.local`;
    // v1.x returns the object directly; fall back to `.body` for belt-and-braces.
    const servicePorts = serviceResp?.spec?.ports || serviceResp?.body?.spec?.ports || service.spec.ports;

    if (this._isNodePortExposure()) {
      const runtimeNodePort = servicePorts.find((port) => port.name === "runtime")?.nodePort;
      const gatewayNodePort = servicePorts.find((port) => port.name === "gateway")?.nodePort;
      if (!runtimeNodePort || !gatewayNodePort) {
        throw new Error("K8s NodePort exposure requires runtime and gateway node ports");
      }

      const nodePortHost =
        process.env.K8S_RUNTIME_HOST ||
        process.env.GATEWAY_HOST ||
        "host.docker.internal";

      console.log(
        `[k8s] Deployment ${deployName} created -> ${host} ` +
        `(runtime nodePort ${runtimeNodePort}, gateway nodePort ${gatewayNodePort})`
      );
      return {
        containerId: deployName,
        host,
        gatewayToken,
        runtimeHost: nodePortHost,
        runtimePort: runtimeNodePort,
        gatewayHost: nodePortHost,
        gatewayHostPort: gatewayNodePort,
      };
    }

    console.log(
      `[k8s] Deployment ${deployName} created -> ${host} ` +
      `(gateway ${OPENCLAW_GATEWAY_PORT}, runtime ${AGENT_RUNTIME_PORT})`
    );
    return {
      containerId: deployName,
      host,
      gatewayToken,
      runtimeHost: host,
      runtimePort: AGENT_RUNTIME_PORT,
      gatewayHost: host,
      gatewayPort: OPENCLAW_GATEWAY_PORT,
    };
  }

  async destroy(containerId) {
    const deployName = containerId;
    console.log(`[k8s] Destroying deployment ${deployName}`);

    try {
      await this.appsApi.deleteNamespacedDeployment({ name: deployName, namespace: this.namespace });
    } catch {
      // already gone
    }
    try {
      await this.coreApi.deleteNamespacedService({ name: deployName, namespace: this.namespace });
    } catch {
      // already gone
    }
    console.log(`[k8s] Deployment ${deployName} deleted`);
  }

  async status(containerId) {
    const deployName = containerId;
    try {
      const res = await this.appsApi.readNamespacedDeployment({ name: deployName, namespace: this.namespace });
      // v1.x returns the object directly; fall back to `.body` for belt-and-braces.
      const status = (res?.status || res?.body?.status) || {};
      const running = (status.availableReplicas || 0) > 0;
      return { running, uptime: null, cpu: null, memory: null };
    } catch {
      return { running: false, uptime: 0, cpu: null, memory: null };
    }
  }

  async stop(containerId) {
    const deployName = containerId;
    console.log(`[k8s] Stopping deployment ${deployName} (scaling to 0)`);
    // v1.x's auto-selected Content-Type for patch is application/json-patch+json,
    // so the body MUST be a JSON Patch ops array (RFC 6902), not a merge object.
    await this.appsApi.patchNamespacedDeployment({
      name: deployName,
      namespace: this.namespace,
      body: [{ op: "replace", path: "/spec/replicas", value: 0 }],
    });
    console.log(`[k8s] Deployment ${deployName} scaled to 0`);
  }

  async start(containerId) {
    const deployName = containerId;
    console.log(`[k8s] Starting deployment ${deployName} (scaling to 1)`);
    await this.appsApi.patchNamespacedDeployment({
      name: deployName,
      namespace: this.namespace,
      body: [{ op: "replace", path: "/spec/replicas", value: 1 }],
    });
    console.log(`[k8s] Deployment ${deployName} scaled to 1`);
  }

  async restart(containerId) {
    const deployName = containerId;
    console.log(`[k8s] Restarting deployment ${deployName}`);
    await this.appsApi.patchNamespacedDeployment({
      name: deployName,
      namespace: this.namespace,
      body: [
        {
          op: "add",
          path: "/spec/template/metadata/annotations",
          value: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() },
        },
      ],
    });
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
    const labelSelector = `openclaw.agent.id=${deployName.replace("oclaw-agent-", "")}`;
    const pods = await this.coreApi.listNamespacedPod({ namespace: this.namespace, labelSelector });
    const podItems = pods?.items || pods?.body?.items || [];
    const runningPod = podItems.find((p) => p.status?.phase === "Running");
    if (!runningPod) return null;

    return { podName: runningPod.metadata.name, exec, namespace: this.namespace };
  }

  /**
   * Stream logs from a pod of the deployment.
   */
  async logs(containerId, opts = {}) {
    const deployName = containerId;
    const log = new k8s.Log(this.kc);

    const labelSelector = `openclaw.agent.id=${deployName.replace("oclaw-agent-", "")}`;
    const pods = await this.coreApi.listNamespacedPod({ namespace: this.namespace, labelSelector });
    const podItems = pods?.items || pods?.body?.items || [];
    const runningPod = podItems.find((p) => p.status?.phase === "Running");
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
