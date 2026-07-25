# Nora Helm Chart

Installs the full Nora control plane on Kubernetes: the nginx edge, the three
Next.js frontends (marketing, operator dashboard, admin), the backend API, the
provisioner and backup workers, and — by default — in-chart PostgreSQL 15 and
Redis 7 built on the official images.

## Quick start

```bash
helm install nora ./infra/helm/nora \
  --namespace nora --create-namespace \
  --set secrets.jwtSecret="$(openssl rand -hex 32)" \
  --set secrets.encryptionKey="$(openssl rand -hex 32)" \
  --set secrets.backupEncryptionKey="$(openssl rand -hex 32)" \
  --set secrets.apiKeyHashSecret="$(openssl rand -hex 32)" \
  --set secrets.agentHubApiKeyHashSecret="$(openssl rand -hex 32)" \
  --set secrets.dbPassword="$(openssl rand -hex 24)" \
  --set publicUrl="https://nora.example.com" \
  --set ingress.enabled=true --set ingress.host="nora.example.com"
```

No insecure defaults ship in the chart: installs fail fast until the six
secret values are provided (or `secrets.existingSecret` points at a Secret
carrying `JWT_SECRET`, `ENCRYPTION_KEY`, `NORA_BACKUP_ENCRYPTION_KEY`,
`NORA_API_KEY_HASH_SECRET`, `NORA_AGENT_HUB_API_KEY_HASH_SECRET`, and
`DB_PASSWORD`). New chart installs require distinct workspace/API and Agent Hub
hash secrets. Upgrades whose older values contain only `apiKeyHashSecret` retain
the legacy shared-key fallback until the operator supplies the dedicated value.

> **Save your secrets.** The `--set` form above generates secrets that live only
> inside the release. `helm uninstall` deletes the generated Secret, but the
> postgres data PVC and the `nora-backups` PVC are retained
> (`helm.sh/resource-policy: keep`). A reinstall then generates _new_ secrets
> that cannot decrypt the retained data or match the kept DB password. For any
> install you intend to keep, manage the six secrets yourself and pass them via
> `secrets.existingSecret`, or back up the generated Secret immediately.

Without an Ingress: `kubectl -n nora port-forward svc/nora-nginx 8080:80` and
open http://localhost:8080. The first user to sign up becomes the platform
admin.

## Key values

| Value                                   | Default                 | Meaning                                                                       |
| --------------------------------------- | ----------------------- | ----------------------------------------------------------------------------- |
| `global.imageRegistry`                  | `ghcr.io/solomon2773`   | Registry for the published `nora-*` images                                    |
| `global.imageTag`                       | `v<appVersion>`         | Image tag for all Nora services                                               |
| `publicUrl`                             | `http://localhost:8080` | Public origin; feeds `NEXTAUTH_URL` + `CORS_ORIGINS`                          |
| `enabledBackends`                       | `k8s`                   | Agent deploy targets (see limitations)                                        |
| `secrets.*` / `secrets.existingSecret`  | —                       | Required credentials (see above)                                              |
| `backendEnv`                            | `{}`                    | Extra non-secret env for backend-api + workers                                |
| `frontendEnv`                           | `{}`                    | Explicit non-secret env shared by frontends; never inherits control-plane env |
| `frontendMarketing.oauthExistingSecret` | `""`                    | Secret whose optional OAuth keys are exposed only to marketing                |
| `kubeconfigs.existingSecret`            | `""`                    | Secret of kubeconfig files mounted at `/kubeconfigs` for agent deploy targets |
| `postgresql.enabled` / `redis.enabled`  | `true`                  | In-chart data stores; disable and fill `*.external.*` to bring your own       |
| `backupsVolume.*`                       | RWO 10Gi                | Shared volume for managed local backups                                       |
| `ingress.*`                             | disabled                | Ingress in front of the `nora-nginx` Service                                  |
| `nginx.service.type`                    | `ClusterIP`             | Switch to `LoadBalancer`/`NodePort` to expose directly                        |
| `security.*`                            | non-root/read-only      | Pod/container security contexts for Nora application pods                     |
| `availability.*`                        | enabled                 | Preferred node spreading and PDBs when a component has multiple replicas      |

## Design notes

- **One release per namespace.** Services use fixed compose-parity names
  (`backend-api`, `postgres`, `redis`, `frontend-dashboard`, …) so the bundled
  nginx config and the app's connection defaults work unchanged.
- **`files/nginx-k8s.conf`** mirrors the repo-root `nginx.conf` routing with
  static Service upstreams. When `nginx.conf` routing changes, update it in the
  same PR.
- **`files/db_schema.sql`** is a vendored copy of `backend-api/db_schema.sql`
  used by the in-chart postgres initdb. CI (`npm run ci:validate-infra`) fails
  when the copies drift; refresh with
  `cp backend-api/db_schema.sql infra/helm/nora/files/db_schema.sql`.
- **Secure pod defaults** disable service-account token mounting, run Nora and
  nginx as numeric non-root users, drop all Linux capabilities, enforce the
  runtime-default seccomp profile, block privilege escalation, and use
  read-only root filesystems with bounded scratch volumes. PostgreSQL and Redis
  use their upstream numeric users with the same capability/seccomp posture.
- **Secret files, not broad frontend env.** The core Secret is mounted read-only
  at `/run/secrets` for backend-api, workers, database-wait init containers, and
  bundled PostgreSQL. The Nora entrypoint loads valid env-named files; frontend
  pods receive only their explicit `frontendEnv`/component `env` allowlists.
- **Typed deployment invariants cannot be shadowed.** `backendEnv` and `commonEnv`
  reject canonical keys such as `ENABLED_BACKENDS`, `PLATFORM_MODE`, database,
  and Redis coordinates. Configure those through their typed chart values so a
  Kubernetes install cannot silently re-enable the unavailable local Docker target.
- **Dedicated marketing OAuth Secret.** Set
  `frontendMarketing.oauthExistingSecret` to a Secret containing any of
  `OAUTH_LOGIN_ENABLED`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GITHUB_CLIENT_ID`, and `GITHUB_CLIENT_SECRET`. Only the marketing pod
  references those optional keys. The value can name the same Secret as
  `secrets.existingSecret`: the backend then loads OAuth values from
  `/run/secrets`, while marketing receives only the five-key allowlist. When
  this value is empty, existing installs that placed exactly those keys in
  `commonEnv` remain compatible; no other `commonEnv` entry is forwarded to a
  frontend.
- **HA controls** prefer scheduling replicas on different nodes and render a
  PodDisruptionBudget automatically when a component's replica count exceeds
  one. Stateful PostgreSQL remains single-replica; production HA databases
  should be supplied externally.
- **Managed PostgreSQL/Redis** can be configured through the existing Secret:
  `DATABASE_URL`, `DB_SSL_MODE`, `DB_SSL_CA`, `REDIS_URL`, `REDIS_PASSWORD`, and
  `REDIS_TLS*` are consumed consistently by the API and both workers. Use
  `verify-full` plus a CA for PostgreSQL and `rediss://`/`REDIS_TLS=true` for
  production services.

## Limitations on Kubernetes

- **Docker deploy target is unavailable** — the provisioner has no Docker
  socket in a pod. The chart requires `ENABLED_BACKENDS` to include `k8s` and
  rejects `docker`; register clusters
  under Admin → Kubernetes and mount their kubeconfigs via
  `kubeconfigs.existingSecret`.
- **In-place release upgrades (Admin UI) are a Docker Compose feature.**
  Upgrade with `helm upgrade nora <chart> --reuse-values` instead.
- **Local backup storage** uses one PVC shared by backend-api and
  worker-backup. `ReadWriteOnce` only works when both pods schedule onto the
  same node (k3s/Kind/single-node). On multi-node clusters use a
  `ReadWriteMany` storage class or configure S3/SSH backup storage and set
  `backupsVolume.enabled=false`.

## Validation

- `npm run ci:validate-infra` — helm lint + `helm template | kubeconform
-strict` + schema drift guard (runs in CI Security on every PR).
- `infra/helm/scripts/kind-smoke.sh` — full install on a local Kind cluster
  with edge probes (`/api/health`, `/`, `/app`, `/admin`).
