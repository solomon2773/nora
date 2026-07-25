{{/* Image tag: explicit value or v<appVersion>. */}}
{{- define "nora.imageTag" -}}
{{- default (printf "v%s" .Chart.AppVersion) .Values.global.imageTag -}}
{{- end -}}

{{/* Preferred node-level anti-affinity for replicated components. */}}
{{- define "nora.preferredPodAntiAffinity" -}}
{{- if .root.Values.availability.preferredPodAntiAffinity }}
affinity:
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchExpressions:
              - key: app.kubernetes.io/name
                operator: In
                values: ["nora"]
              - key: app.kubernetes.io/instance
                operator: In
                values: [{{ .root.Release.Name | quote }}]
              - key: app.kubernetes.io/component
                operator: In
                values: [{{ .component | quote }}]
          topologyKey: kubernetes.io/hostname
{{- end }}
{{- end -}}

{{/* Fully-qualified Nora image for a component, e.g. (include "nora.image" (dict "root" . "name" "nora-backend-api")). */}}
{{- define "nora.image" -}}
{{- printf "%s/%s:%s" .root.Values.global.imageRegistry .name (include "nora.imageTag" .root) -}}
{{- end -}}

{{/* Common labels for a component; expects (dict "root" . "component" "backend-api"). */}}
{{- define "nora.labels" -}}
app.kubernetes.io/name: nora
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version }}
{{- end -}}

{{/* Selector labels (stable subset). */}}
{{- define "nora.selectorLabels" -}}
app.kubernetes.io/name: nora
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Name of the Secret holding core credentials. */}}
{{- define "nora.secretName" -}}
{{- default "nora-secrets" .Values.secrets.existingSecret -}}
{{- end -}}

{{/* Effective database connection facts. */}}
{{- define "nora.dbHost" -}}
{{- if .Values.postgresql.enabled -}}postgres{{- else -}}{{ required "postgresql.external.host is required when postgresql.enabled=false" .Values.postgresql.external.host }}{{- end -}}
{{- end -}}
{{- define "nora.dbPort" -}}
{{- if .Values.postgresql.enabled -}}5432{{- else -}}{{ .Values.postgresql.external.port }}{{- end -}}
{{- end -}}
{{- define "nora.dbUser" -}}
{{- if .Values.postgresql.enabled -}}{{ .Values.postgresql.auth.username }}{{- else -}}{{ .Values.postgresql.external.username }}{{- end -}}
{{- end -}}
{{- define "nora.dbName" -}}
{{- if .Values.postgresql.enabled -}}{{ .Values.postgresql.auth.database }}{{- else -}}{{ .Values.postgresql.external.database }}{{- end -}}
{{- end -}}

{{/* Effective Redis connection facts. */}}
{{- define "nora.redisHost" -}}
{{- if .Values.redis.enabled -}}redis{{- else -}}{{ required "redis.external.host is required when redis.enabled=false" .Values.redis.external.host }}{{- end -}}
{{- end -}}
{{- define "nora.redisPort" -}}
{{- if .Values.redis.enabled -}}6379{{- else -}}{{ .Values.redis.external.port }}{{- end -}}
{{- end -}}

{{/* Non-secret envFrom block shared by control-plane pods. Core and operator
     secrets are mounted read-only at /run/secrets and loaded by the image
     entrypoint instead of being injected wholesale into the pod environment. */}}
{{- define "nora.controlPlaneEnvFrom" -}}
envFrom:
  - configMapRef:
      name: nora-env
{{- end -}}

{{/* Extra env entries from commonEnv/backendEnv maps; expects (dict "root" . "extra" <map>). */}}
{{- define "nora.extraEnv" -}}
{{- range $key, $value := .extra }}
- name: {{ $key }}
  value: {{ $value | quote }}
{{- end }}
{{- end -}}

{{/* imagePullSecrets block. */}}
{{- define "nora.imagePullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
  initContainer that blocks a control-plane pod until the database accepts TCP.
  Compose used `depends_on: condition: service_healthy`; Kubernetes Deployments
  have no such gate, and the backend runs its transactional migrateDB() before
  binding HTTP — so this avoids a noisy crash loop while PostgreSQL starts. Uses the already
  present backend-api image (node) so no extra image is pulled; DB_HOST/DB_PORT
  come from the nora-env ConfigMap and resolve for both bundled and external DB.
*/}}
{{- define "nora.waitForDbInit" -}}
initContainers:
  - name: wait-for-db
    image: {{ include "nora.image" (dict "root" . "name" "nora-backend-api") }}
    imagePullPolicy: {{ .Values.global.imagePullPolicy }}
    securityContext:
      {{- toYaml .Values.security.containerSecurityContext | nindent 6 }}
    envFrom:
      - configMapRef:
          name: nora-env
    volumeMounts:
      - name: runtime-secrets
        mountPath: /run/secrets
        readOnly: true
    command:
      - /usr/local/bin/nora-container-entrypoint
    args:
      - node
      - -e
      - |
        const net = require("net");
        let host = process.env.DB_HOST || "postgres", port = Number(process.env.DB_PORT || 5432);
        const connectionUrl = process.env.DATABASE_URL || process.env.DB_URL;
        if (connectionUrl) {
          const parsed = new URL(connectionUrl);
          host = parsed.hostname;
          port = Number(parsed.port || 5432);
        }
        (function attempt() {
          const sock = net.connect(port, host);
          sock.on("connect", () => { sock.end(); process.exit(0); });
          sock.on("error", () => {
            sock.destroy();
            console.error(`waiting for database ${host}:${port}`);
            setTimeout(attempt, 2000);
          });
        })();
{{- end -}}

{{/*
  Additional worker initContainer. The backend binds only after its
  transactional migration ledger is complete, so a successful /health probe
  is the worker-safe schema-ready signal.
*/}}
{{- define "nora.waitForApiInit" -}}
- name: wait-for-api-migrations
  image: {{ include "nora.image" (dict "root" . "name" "nora-backend-api") }}
  imagePullPolicy: {{ .Values.global.imagePullPolicy }}
  securityContext:
    {{- toYaml .Values.security.containerSecurityContext | nindent 4 }}
  command:
    - node
    - -e
    - |
      const http = require("http");
      (function attempt() {
        const request = http.get("http://backend-api:4000/health", (response) => {
          response.resume();
          if (response.statusCode === 200) process.exit(0);
          console.error(`waiting for migrated backend API (HTTP ${response.statusCode})`);
          setTimeout(attempt, 2000);
        });
        request.setTimeout(3000, () => request.destroy(new Error("health timeout")));
        request.on("error", (error) => {
          console.error(`waiting for migrated backend API: ${error.message}`);
          setTimeout(attempt, 2000);
        });
      })();
{{- end -}}
