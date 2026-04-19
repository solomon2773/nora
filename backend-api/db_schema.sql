-- PostgreSQL initial schema

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  role TEXT DEFAULT 'user',
  name TEXT,
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
  sandbox_profile VARCHAR(20) NOT NULL DEFAULT 'standard',
  node TEXT,
  host TEXT,
  runtime_host TEXT,
  runtime_port INTEGER,
  gateway_host TEXT,
  gateway_port INTEGER,
  gateway_host_port INTEGER,
  gateway_token TEXT,
  container_id TEXT,
  container_name TEXT,
  image TEXT,
  template_payload JSONB DEFAULT '{}',
  vcpu INTEGER DEFAULT 1,
  ram_mb INTEGER DEFAULT 1024,
  disk_gb INTEGER DEFAULT 10,
  created_at TIMESTAMP DEFAULT NOW()
);

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
  system_banner_enabled BOOLEAN NOT NULL DEFAULT false,
  system_banner_severity TEXT NOT NULL DEFAULT 'warning',
  system_banner_title TEXT NOT NULL DEFAULT '',
  system_banner_message TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS marketplace_listings (
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

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_snapshot_id
  ON marketplace_listings(snapshot_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_marketplace_listings_slug_unique
  ON marketplace_listings(slug)
  WHERE slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_owner
  ON marketplace_listings(owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_source_status
  ON marketplace_listings(source_type, status, published_at DESC);

CREATE TABLE IF NOT EXISTS marketplace_listing_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  snapshot_id UUID REFERENCES snapshots(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  clone_mode TEXT DEFAULT 'files_only',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(listing_id, version_number),
  UNIQUE(listing_id, snapshot_id)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_listing_versions_listing
  ON marketplace_listing_versions(listing_id, version_number DESC);

CREATE TABLE IF NOT EXISTS marketplace_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  reporter_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT DEFAULT 'open',
  reviewed_at TIMESTAMP,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketplace_reports_listing_status
  ON marketplace_reports(listing_id, status, created_at DESC);

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
  created_at TIMESTAMP DEFAULT NOW()
);

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
  created_at TIMESTAMP DEFAULT NOW()
);

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
