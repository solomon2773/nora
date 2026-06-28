-- PostgreSQL initial schema

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  role TEXT DEFAULT 'user',
  name TEXT,
  preferred_locale TEXT,
  agent_limit_override INTEGER,
  managed_backups_enabled_override BOOLEAN,
  backup_limit_per_agent_override INTEGER,
  backup_storage_mb_override INTEGER,
  backup_retention_days_override INTEGER,
  provider TEXT,
  provider_id TEXT,
  stripe_customer_id TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name TEXT,
  status TEXT DEFAULT 'queued',
  backend_type VARCHAR(20) NOT NULL DEFAULT 'docker',
  sandbox_type VARCHAR(20) DEFAULT 'standard',
  runtime_family VARCHAR(20) NOT NULL DEFAULT 'openclaw',
  deploy_target VARCHAR(20) NOT NULL DEFAULT 'docker',
  execution_target_id TEXT NOT NULL DEFAULT 'docker',
  sandbox_profile VARCHAR(20) NOT NULL DEFAULT 'standard',
  node TEXT,
  host TEXT,
  runtime_host TEXT,
  runtime_port INTEGER,
  gateway_host TEXT,
  gateway_port INTEGER,
  gateway_host_port INTEGER,
  dashboard_port INTEGER,
  gateway_token TEXT,
  container_id TEXT,
  container_name TEXT,
  image TEXT,
  template_payload JSONB DEFAULT '{}',
  clawhub_skills JSONB DEFAULT '[]',
  vcpu INTEGER DEFAULT 1,
  ram_mb INTEGER DEFAULT 1024,
  disk_gb INTEGER DEFAULT 10,
  paused_reason TEXT,
  mcp_servers JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kubernetes_clusters (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'kubernetes',
  cluster_name TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  credential_mode TEXT NOT NULL DEFAULT 'mounted_path',
  kubeconfig_path TEXT NOT NULL DEFAULT '',
  kubeconfig_encrypted TEXT,
  kube_context TEXT NOT NULL DEFAULT '',
  namespace TEXT NOT NULL DEFAULT 'openclaw-agents',
  openclaw_namespace TEXT NOT NULL DEFAULT '',
  hermes_namespace TEXT NOT NULL DEFAULT '',
  exposure_mode TEXT NOT NULL DEFAULT 'cluster-ip',
  runtime_host TEXT NOT NULL DEFAULT '',
  runtime_node_port INTEGER,
  gateway_node_port INTEGER,
  service_annotations JSONB NOT NULL DEFAULT '{}'::jsonb,
  load_balancer_source_ranges TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  load_balancer_class TEXT NOT NULL DEFAULT '',
  load_balancer_ready_timeout_ms INTEGER NOT NULL DEFAULT 600000,
  load_balancer_ready_interval_ms INTEGER NOT NULL DEFAULT 5000,
  last_test_status TEXT,
  last_test_message TEXT,
  last_tested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kubernetes_clusters_enabled
  ON kubernetes_clusters(enabled, is_default, label);

CREATE TABLE IF NOT EXISTS remote_hosts (
  id TEXT PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  is_default BOOLEAN NOT NULL DEFAULT false,
  ssh_host TEXT NOT NULL DEFAULT '',
  ssh_port INTEGER NOT NULL DEFAULT 22,
  ssh_user TEXT NOT NULL DEFAULT '',
  ssh_auth_mode TEXT NOT NULL DEFAULT 'key',
  ssh_private_key_encrypted TEXT,
  ssh_password_encrypted TEXT,
  ssh_passphrase_encrypted TEXT,
  gateway_host TEXT NOT NULL DEFAULT '',
  docker_host TEXT NOT NULL DEFAULT '',
  -- Pinned SSH host public key (base64), captured trust-on-first-use during the
  -- connection test and verified on every subsequent connect (MITM protection).
  ssh_host_key TEXT,
  last_test_status TEXT,
  last_test_message TEXT,
  last_tested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_remote_hosts_owner
  ON remote_hosts(owner_user_id, enabled, is_default, label);

CREATE TABLE IF NOT EXISTS gateway_port_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host_key TEXT NOT NULL,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  port INTEGER NOT NULL,
  -- Which published port this row holds for the agent on host_key. Lets one
  -- agent reserve several collision-safe ports on the same physical host
  -- (e.g. remote Hermes: 'gateway' = runtime API 8642, 'dashboard' = UI 9119).
  purpose TEXT NOT NULL DEFAULT 'gateway',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(host_key, port)
);

CREATE INDEX IF NOT EXISTS idx_gateway_port_allocations_agent
  ON gateway_port_allocations(agent_id);

CREATE TABLE IF NOT EXISTS deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  status TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_migrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  deployed_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  runtime_family VARCHAR(20) NOT NULL DEFAULT 'openclaw',
  source_kind TEXT NOT NULL DEFAULT 'upload',
  source_transport TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  summary JSONB DEFAULT '{}',
  warnings JSONB DEFAULT '[]',
  encrypted_manifest TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_migrations_user_created
  ON agent_migrations(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_migrations_agent
  ON agent_migrations(deployed_agent_id);

CREATE TABLE IF NOT EXISTS agent_secret_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  env_key TEXT NOT NULL,
  env_value TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, env_key)
);

CREATE INDEX IF NOT EXISTS idx_agent_secret_overrides_agent
  ON agent_secret_overrides(agent_id, env_key);

CREATE TABLE IF NOT EXISTS hermes_runtime_state (
  agent_id UUID PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  model_config JSONB DEFAULT '{}',
  channel_configs JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton = TRUE),
  default_vcpu INTEGER NOT NULL DEFAULT 1,
  default_ram_mb INTEGER NOT NULL DEFAULT 1024,
  default_disk_gb INTEGER NOT NULL DEFAULT 10,
  default_locale TEXT NOT NULL DEFAULT 'en',
  system_banner_enabled BOOLEAN NOT NULL DEFAULT false,
  system_banner_severity TEXT NOT NULL DEFAULT 'warning',
  system_banner_title TEXT NOT NULL DEFAULT '',
  system_banner_message TEXT NOT NULL DEFAULT '',
  agent_hub_default_share_target TEXT NOT NULL DEFAULT 'both',
  agent_hub_url TEXT NOT NULL DEFAULT 'https://nora.solomontsao.com',
  agent_hub_api_key_encrypted TEXT,
  backup_storage_backend TEXT NOT NULL DEFAULT 'local',
  backup_local_path TEXT NOT NULL DEFAULT '/var/lib/nora-backups',
  backup_s3_bucket TEXT NOT NULL DEFAULT '',
  backup_s3_region TEXT NOT NULL DEFAULT 'us-east-1',
  backup_s3_endpoint TEXT NOT NULL DEFAULT '',
  backup_s3_access_key_id_encrypted TEXT,
  backup_s3_secret_access_key_encrypted TEXT,
  backup_ssh_host TEXT NOT NULL DEFAULT '',
  backup_ssh_port INTEGER NOT NULL DEFAULT 22,
  backup_ssh_username TEXT NOT NULL DEFAULT '',
  backup_ssh_remote_path TEXT NOT NULL DEFAULT '/backups/nora',
  backup_ssh_private_key_encrypted TEXT,
  backup_ssh_password_encrypted TEXT,
  backup_installation_schedule_enabled BOOLEAN NOT NULL DEFAULT false,
  backup_installation_schedule_frequency TEXT NOT NULL DEFAULT 'daily',
  backup_installation_schedule_hour_utc INTEGER NOT NULL DEFAULT 2,
  backup_installation_schedule_day_of_week INTEGER NOT NULL DEFAULT 0,
  -- Platform-wide SMTP for invitation emails + alert email channels (Phase 6).
  -- Encrypted password is AES-256-GCM via crypto.ts. The set is "configured"
  -- iff host + port + from_address are populated (mailer.isConfigured()).
  smtp_host TEXT NOT NULL DEFAULT '',
  smtp_port INTEGER NOT NULL DEFAULT 587,
  smtp_secure BOOLEAN NOT NULL DEFAULT false,
  smtp_username TEXT NOT NULL DEFAULT '',
  smtp_password_encrypted TEXT,
  smtp_from_address TEXT NOT NULL DEFAULT '',
  smtp_from_name TEXT NOT NULL DEFAULT 'Nora',
  -- Per-tier defaults live in backend-api/platformSettings.ts
  -- (DEFAULT_BACKUP_PLAN_LIMITS) and are applied per-key by
  -- normalizeBackupPlanLimits on read. Keep the schema default empty so the
  -- two stay in sync from a single source of truth.
  backup_plan_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Dev-mode only: the generated JWT secret persisted so sessions survive
  -- restarts when JWT_SECRET is not configured. Never used in production
  -- (boot fails there without an explicit JWT_SECRET).
  dev_jwt_secret TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO platform_settings(singleton, default_vcpu, default_ram_mb, default_disk_gb)
VALUES(TRUE, 1, 1024, 10)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  name TEXT NOT NULL,
  description TEXT,
  kind TEXT DEFAULT 'snapshot',
  template_key TEXT,
  built_in BOOLEAN DEFAULT false,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_hub_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID REFERENCES snapshots(id) ON DELETE CASCADE,
  owner_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT,
  price TEXT DEFAULT 'Free',
  category TEXT DEFAULT 'General',
  rating NUMERIC DEFAULT 0,
  installs INTEGER DEFAULT 0,
  downloads INTEGER DEFAULT 0,
  built_in BOOLEAN DEFAULT false,
  source_type TEXT DEFAULT 'platform',
  status TEXT DEFAULT 'published',
  visibility TEXT DEFAULT 'public',
  share_target TEXT DEFAULT 'internal',
  local_visibility TEXT DEFAULT 'internal',
  central_share_status TEXT DEFAULT 'not_shared',
  central_listing_id TEXT,
  central_last_synced_at TIMESTAMP,
  central_error TEXT,
  slug TEXT,
  current_version INTEGER DEFAULT 1,
  published_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT NOW(),
  reviewed_at TIMESTAMP,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  review_notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_template_key
  ON snapshots(template_key);

CREATE INDEX IF NOT EXISTS idx_agent_hub_listings_snapshot_id
  ON agent_hub_listings(snapshot_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_hub_listings_slug_unique
  ON agent_hub_listings(slug)
  WHERE slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_hub_listings_owner
  ON agent_hub_listings(owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_hub_listings_source_status
  ON agent_hub_listings(source_type, status, published_at DESC);

CREATE TABLE IF NOT EXISTS agent_hub_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_used_at TIMESTAMP,
  revoked_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_hub_api_keys_user
  ON agent_hub_api_keys(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_hub_api_keys_hash_active
  ON agent_hub_api_keys(key_hash)
  WHERE status = 'active' AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_hub_listing_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES agent_hub_listings(id) ON DELETE CASCADE,
  snapshot_id UUID REFERENCES snapshots(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  clone_mode TEXT DEFAULT 'files_only',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(listing_id, version_number),
  UNIQUE(listing_id, snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_hub_listing_versions_listing
  ON agent_hub_listing_versions(listing_id, version_number DESC);

CREATE TABLE IF NOT EXISTS agent_hub_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES agent_hub_listings(id) ON DELETE CASCADE,
  reporter_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT DEFAULT 'open',
  reviewed_at TIMESTAMP,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_hub_reports_listing_status
  ON agent_hub_reports(listing_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(workspace_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_agents_agent
  ON workspace_agents(agent_id);

-- Shared BYOC remote hosts (Phase C3). A host's owner can share it into a
-- workspace they belong to; workspace members then use it per their workspace
-- role (editor+ deploys/reaches, viewer sees read-only). Host config/credentials
-- stay with the owner. Mirrors workspace_agents.
CREATE TABLE IF NOT EXISTS workspace_remote_hosts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  remote_host_id TEXT REFERENCES remote_hosts(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(workspace_id, remote_host_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_remote_hosts_host
  ON workspace_remote_hosts(remote_host_id);

-- Per-workspace membership (Phase 0 of multi-tenant RBAC).
-- workspaces.user_id remains as the creator denormalization; permission checks
-- read from workspace_members.role instead.
CREATE TABLE IF NOT EXISTS workspace_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer'
    CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_user
  ON workspace_members(user_id);

CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_role
  ON workspace_members(workspace_id, role);

-- Backfill: every existing workspace creator becomes the 'owner' member.
INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT id, user_id, 'owner'
  FROM workspaces
 WHERE user_id IS NOT NULL
ON CONFLICT (workspace_id, user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS workspace_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer'
    CHECK (role IN ('admin', 'editor', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  accepted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  accepted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace
  ON workspace_invitations(workspace_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_invitations_email_pending
  ON workspace_invitations(email)
  WHERE status = 'pending';

-- General-purpose, workspace-scoped API keys (Phase 1 of the public REST API).
-- Token format: "nora_" + base64url(random32). Stored as HMAC-SHA256 hash with a
-- server-side secret; key_prefix shows first 18 chars for UI display. Scopes is
-- a JSONB array of "resource:action" strings (e.g. "agents:read", "agents:write").
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_workspace
  ON api_keys(workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash_active
  ON api_keys(key_hash)
  WHERE status = 'active' AND revoked_at IS NULL;

-- Alert rules (Phase 2). Match emitted events by type pattern (literal or
-- glob suffix like "agent.*") and deliver to one or more channels.
-- "webhook" channels POST a JSON body via the alert-deliveries BullMQ queue
-- with exponential-backoff retries (handled in workers/provisioner/worker.ts);
-- "email" channels dispatch inline through the platform mailer. last_error
-- holds the most recent terminal delivery failure.
CREATE TABLE IF NOT EXISTS alert_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  event_pattern TEXT NOT NULL,
  channels JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_fired_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_workspace_enabled
  ON alert_rules(workspace_id, enabled);

CREATE INDEX IF NOT EXISTS idx_alert_rules_pattern_enabled
  ON alert_rules(event_pattern)
  WHERE enabled = true;

-- Agent configuration history (Phase 3). Every save of an agent's
-- template_payload writes a new row; rollback restores a prior config and
-- triggers a redeploy. version_number is monotonic per agent; the latest row
-- is the current configuration baseline.
CREATE TABLE IF NOT EXISTS agent_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  message TEXT,
  source TEXT NOT NULL DEFAULT 'edit'
    CHECK (source IN ('edit', 'deploy', 'redeploy', 'duplicate', 'hub-install', 'restore', 'rollback')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_agent_versions_agent_recent
  ON agent_versions(agent_id, version_number DESC);

-- Fleet runtime migrations (Phase 5). Tracks bulk runtime transitions
-- (e.g. moving every Hermes agent from Docker to Kubernetes) so progress is
-- visible and pre-migration state is captured for rollback.
CREATE TABLE IF NOT EXISTS fleet_migrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  initiated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'queued', 'in_progress', 'completed', 'partial_failure', 'rolled_back')),
  source_selection JSONB NOT NULL DEFAULT '{}',
  target_selection JSONB NOT NULL DEFAULT '{}',
  agent_ids JSONB NOT NULL DEFAULT '[]',
  before_state JSONB NOT NULL DEFAULT '{}',
  after_state JSONB NOT NULL DEFAULT '{}',
  errors JSONB NOT NULL DEFAULT '[]',
  dry_run BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  rolled_back_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fleet_migrations_status_created
  ON fleet_migrations(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fleet_migrations_initiator
  ON fleet_migrations(initiated_by, created_at DESC);

-- Per-workspace usage budgets. When usage crosses the soft threshold (e.g.
-- 80% of limit) or 100%, an event fires that the alert system can match.
CREATE TABLE IF NOT EXISTS workspace_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period TEXT NOT NULL DEFAULT 'monthly'
    CHECK (period IN ('daily', 'weekly', 'monthly')),
  limit_usd NUMERIC(12, 2) NOT NULL,
  soft_threshold_pct INTEGER NOT NULL DEFAULT 80
    CHECK (soft_threshold_pct BETWEEN 0 AND 100),
  last_alerted_at TIMESTAMPTZ,
  last_alerted_pct INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(workspace_id, period)
);

-- Per-agent LLM spend budgets. Soft crossings emit alert events; hard
-- crossings additionally pause the runtime (agents.paused_reason records why).
CREATE TABLE IF NOT EXISTS agent_budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  period TEXT NOT NULL DEFAULT 'monthly'
    CHECK (period IN ('daily', 'weekly', 'monthly')),
  limit_usd NUMERIC(12, 2) NOT NULL,
  soft_threshold_pct INTEGER NOT NULL DEFAULT 80
    CHECK (soft_threshold_pct BETWEEN 0 AND 100),
  last_alerted_at TIMESTAMPTZ,
  last_alerted_pct INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, period)
);

CREATE INDEX IF NOT EXISTS idx_agent_budgets_agent ON agent_budgets(agent_id);

-- Control-plane scheduled agent runs (recurring cron triggers). The backend
-- sweep claims due rows (FOR UPDATE SKIP LOCKED), computes the next fire, and
-- enqueues each run; the worker executes the action (a prompt or a lifecycle op)
-- and records an agent.schedule.run event. min_interval is enforced in the app
-- so a too-frequent cron can't thrash an agent.
CREATE TABLE IF NOT EXISTS agent_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  action_type TEXT NOT NULL DEFAULT 'prompt'
    CHECK (action_type IN ('prompt', 'restart', 'stop', 'start', 'redeploy')),
  prompt TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  last_status TEXT,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_schedules_due
  ON agent_schedules(next_run_at) WHERE enabled;
CREATE INDEX IF NOT EXISTS idx_agent_schedules_agent ON agent_schedules(agent_id);

CREATE TABLE IF NOT EXISTS integration_catalog (
  id VARCHAR(50) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  icon VARCHAR(50),
  category VARCHAR(50) NOT NULL,
  description TEXT,
  auth_type VARCHAR(20),
  config_schema JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  catalog_id VARCHAR(50) REFERENCES integration_catalog(id),
  access_token TEXT,
  config JSONB DEFAULT '{}',
  status VARCHAR(20) DEFAULT 'active',
  cron_job_id TEXT,
  mailbox_state JSONB DEFAULT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS integration_oauth_states (
  state TEXT PRIMARY KEY,
  provider VARCHAR(50) NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL,
  client_id TEXT,
  client_secret TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  redirect_path TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_integration_oauth_states_expires
  ON integration_oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  type VARCHAR(30) NOT NULL,
  name VARCHAR(100) NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS channel_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
  direction VARCHAR(10) NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usage_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  metric_type VARCHAR(50) NOT NULL,
  value NUMERIC NOT NULL DEFAULT 0,
  metadata JSONB DEFAULT '{}',
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_metrics_agent
  ON usage_metrics(agent_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_usage_metrics_user
  ON usage_metrics(user_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_usage_metrics_type
  ON usage_metrics(metric_type, recorded_at);

CREATE INDEX IF NOT EXISTS idx_usage_metrics_token_model
  ON usage_metrics(metric_type, (metadata->>'model'), recorded_at);

CREATE INDEX IF NOT EXISTS idx_usage_metrics_token_source
  ON usage_metrics(metric_type, (metadata->>'source'), recorded_at);

CREATE TABLE IF NOT EXISTS container_stats (
  id BIGSERIAL PRIMARY KEY,
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  cpu_percent NUMERIC NOT NULL DEFAULT 0,
  memory_usage_mb INTEGER NOT NULL DEFAULT 0,
  memory_limit_mb INTEGER NOT NULL DEFAULT 0,
  memory_percent NUMERIC NOT NULL DEFAULT 0,
  network_rx_mb NUMERIC NOT NULL DEFAULT 0,
  network_tx_mb NUMERIC NOT NULL DEFAULT 0,
  disk_read_mb NUMERIC NOT NULL DEFAULT 0,
  disk_write_mb NUMERIC NOT NULL DEFAULT 0,
  network_rx_rate_mbps NUMERIC NOT NULL DEFAULT 0,
  network_tx_rate_mbps NUMERIC NOT NULL DEFAULT 0,
  disk_read_rate_mbps NUMERIC NOT NULL DEFAULT 0,
  disk_write_rate_mbps NUMERIC NOT NULL DEFAULT 0,
  pids INTEGER NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_container_stats_agent_time
  ON container_stats(agent_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent', 'installation')),
  status TEXT NOT NULL DEFAULT 'queued',
  name TEXT NOT NULL,
  storage_backend TEXT NOT NULL DEFAULT 'local',
  storage_key TEXT,
  storage_config JSONB DEFAULT '{}',
  content_type TEXT NOT NULL DEFAULT 'application/gzip',
  format TEXT NOT NULL DEFAULT 'nora-backup-archive/v1',
  size_bytes BIGINT NOT NULL DEFAULT 0,
  checksum_sha256 TEXT,
  scope JSONB DEFAULT '{}',
  summary JSONB DEFAULT '{}',
  warnings JSONB DEFAULT '[]',
  error TEXT,
  restore_metadata JSONB DEFAULT '{}',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backups_user_agent_created
  ON backups(user_id, agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backups_kind_created
  ON backups(kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backups_expires
  ON backups(expires_at)
  WHERE expires_at IS NOT NULL AND status <> 'deleted';

CREATE TABLE IF NOT EXISTS backup_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent', 'installation')),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  name TEXT,
  frequency TEXT NOT NULL DEFAULT 'daily',
  hour_utc INTEGER NOT NULL DEFAULT 2,
  day_of_week INTEGER NOT NULL DEFAULT 0,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_backup_id UUID REFERENCES backups(id) ON DELETE SET NULL,
  last_error TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backup_schedules_due
  ON backup_schedules(enabled, next_run_at)
  WHERE enabled = true AND next_run_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  message TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT UNIQUE,
  plan TEXT DEFAULT 'free',
  status TEXT DEFAULT 'active',
  agent_limit INTEGER DEFAULT 3,
  vcpu INTEGER DEFAULT 1,
  ram_mb INTEGER DEFAULT 1024,
  disk_gb INTEGER DEFAULT 10,
  current_period_end TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
