import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const BASE_URL = process.env.NORA_SCREENSHOT_BASE_URL || 'http://127.0.0.1:28080';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR = process.env.NORA_SCREENSHOT_DIR || path.resolve(__dirname, '../artifacts/operator-screenshots');
const DB_CONTAINER = process.env.NORA_SCREENSHOT_DB_CONTAINER || 'nora-screens-postgres-1';
const USER_EMAIL = process.env.NORA_SCREENSHOT_EMAIL || 'operator@example.com';
const USER_PASSWORD = process.env.NORA_SCREENSHOT_PASSWORD || 'OperatorPass123!';
const USER_NAME = process.env.NORA_SCREENSHOT_NAME || 'Solo Operator';
const PRIMARY_AGENT_ID = '11111111-1111-4111-8111-111111111111';

async function requestJson(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} :: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

async function ensureUser() {
  try {
    await requestJson(`${BASE_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
    });
  } catch (error) {
    if (!String(error.message).includes('duplicate') && !String(error.message).includes('500')) {
      // login below is the real check; ignore duplicate-ish failures from current backend behavior
    }
  }

  const login = await requestJson(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: USER_EMAIL, password: USER_PASSWORD }),
  });

  return login.token;
}

function seedFleet(userId) {
  if (!DB_CONTAINER || DB_CONTAINER.toLowerCase() === 'none') return;

  const sql = `
DELETE FROM container_stats WHERE agent_id IN (SELECT id FROM agents WHERE user_id = '${userId}');
DELETE FROM deployments WHERE agent_id IN (SELECT id FROM agents WHERE user_id = '${userId}');
DELETE FROM agents WHERE user_id = '${userId}';

INSERT INTO agents (id, user_id, name, status, backend_type, node, host, container_name, vcpu, ram_mb, disk_gb, created_at, sandbox_type, gateway_host_port)
VALUES
  ('11111111-1111-4111-8111-111111111111', '${userId}', 'OpenClaw Research Operator', 'running', 'docker', 'worker-01', 'host.docker.internal', 'nora-research-ops', 4, 8192, 80, NOW() - INTERVAL '18 minutes', 'standard', 18789),
  ('22222222-2222-4222-8222-222222222222', '${userId}', 'Support Inbox Agent', 'warning', 'docker', 'worker-01', 'host.docker.internal', 'nora-support-inbox', 2, 4096, 40, NOW() - INTERVAL '41 minutes', 'standard', 18790),
  ('33333333-3333-4333-8333-333333333333', '${userId}', 'Spec Writer Queue', 'queued', 'docker', 'worker-02', NULL, 'nora-spec-writer', 2, 2048, 20, NOW() - INTERVAL '6 minutes', 'standard', NULL),
  ('44444444-4444-4444-8444-444444444444', '${userId}', 'Retention Analyst', 'stopped', 'docker', 'worker-03', NULL, 'nora-retention-analyst', 2, 4096, 50, NOW() - INTERVAL '2 hours', 'standard', NULL);

INSERT INTO deployments (agent_id, status)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'running'),
  ('22222222-2222-4222-8222-222222222222', 'warning'),
  ('33333333-3333-4333-8333-333333333333', 'queued'),
  ('44444444-4444-4444-8444-444444444444', 'stopped');

INSERT INTO container_stats (agent_id, cpu_percent, memory_usage_mb, memory_limit_mb, memory_percent, network_rx_mb, network_tx_mb, disk_read_mb, disk_write_mb, pids, recorded_at)
VALUES
  ('11111111-1111-4111-8111-111111111111', 18.4, 3120, 8192, 38.1, 124.3, 38.8, 14.2, 5.4, 37, NOW() - INTERVAL '5 minutes'),
  ('11111111-1111-4111-8111-111111111111', 22.1, 3388, 8192, 41.4, 127.5, 41.0, 14.5, 6.1, 39, NOW() - INTERVAL '3 minutes'),
  ('11111111-1111-4111-8111-111111111111', 16.8, 3296, 8192, 40.2, 130.0, 43.4, 14.7, 6.4, 40, NOW() - INTERVAL '1 minute');

INSERT INTO events (type, message, metadata, created_at)
VALUES
  ('agent_deployed', 'Agent "OpenClaw Research Operator" is active and gateway checks are passing.', '{"agentId":"11111111-1111-4111-8111-111111111111"}', NOW() - INTERVAL '17 minutes'),
  ('agent_warning', 'Gateway health check is still warming up for Support Inbox Agent.', '{"agentId":"22222222-2222-4222-8222-222222222222"}', NOW() - INTERVAL '38 minutes');
`;

  const sqlFile = path.join(os.tmpdir(), `nora-readme-screenshots-${Date.now()}.sql`);
  fs.writeFileSync(sqlFile, sql);
  execSync(`docker cp ${shellQuote(sqlFile)} ${shellQuote(DB_CONTAINER)}:/tmp/nora-readme-screenshots.sql`, { stdio: 'inherit' });
  execSync(`docker exec ${shellQuote(DB_CONTAINER)} psql -U platform -d platform -f /tmp/nora-readme-screenshots.sql`, { stdio: 'inherit' });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function ensureProviders(token) {
  const headers = {
    'content-type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  await requestJson(`${BASE_URL}/api/auth/profile`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ name: USER_NAME }),
  });

  const existing = await requestJson(`${BASE_URL}/api/llm-providers`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const byProvider = new Set((existing || []).map((row) => row.provider));
  const desired = [
    { provider: 'openai', apiKey: 'sk-openai-demo-1234567890abcdef', model: 'gpt-5.4' },
    { provider: 'anthropic', apiKey: 'sk-ant-demo-abcdef1234567890', model: 'claude-3-7-sonnet-latest' },
  ];

  for (const provider of desired) {
    if (byProvider.has(provider.provider)) continue;
    await requestJson(`${BASE_URL}/api/llm-providers`, {
      method: 'POST',
      headers,
      body: JSON.stringify(provider),
    });
  }

  const me = await requestJson(`${BASE_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  return me;
}

async function capture() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const token = await ensureUser();
  const me = await ensureProviders(token);
  seedFleet(me.id);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1512, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  });
  await context.addInitScript((storedToken) => {
    window.localStorage.setItem('token', storedToken);
  }, token);

  const page = await context.newPage();

  async function gotoApp(pathname, waitForText) {
    await page.goto(`${BASE_URL}${pathname}`, { waitUntil: 'networkidle' });
    if (waitForText) {
      await page.getByRole('heading', { name: waitForText, exact: true }).waitFor({ state: 'visible', timeout: 15000 });
    }
    await page.waitForTimeout(600);
  }

  await gotoApp('/app/dashboard', 'System Overview');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'proof-operator-dashboard.png') });

  await gotoApp('/app/agents', 'Fleet Management');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'proof-operator-fleet.png') });

  await gotoApp('/app/deploy', 'Deploy New Agent');
  const deployInputs = page.locator('input');
  await deployInputs.nth(0).fill('customer-success-operator');
  await deployInputs.nth(1).fill('nora-customer-success-operator');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'proof-operator-deploy-flow.png') });

  await gotoApp(`/app/agents/${PRIMARY_AGENT_ID}`, 'OpenClaw Research Operator');
  await page.getByText('OpenClaw Gateway Active').waitFor({ state: 'visible', timeout: 15000 });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'proof-operator-agent-detail.png') });

  await gotoApp('/app/settings', 'Settings');
  const providerSection = page.locator('section').filter({ hasText: 'LLM Provider Keys' }).first();
  await providerSection.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await providerSection.screenshot({ path: path.join(SCREENSHOT_DIR, 'proof-operator-settings-provider-setup.png') });

  await browser.close();

  console.log(`Saved README screenshots to ${SCREENSHOT_DIR}`);
}

capture().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
