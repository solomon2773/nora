// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const BASE_URL = process.env.NORA_SCREENSHOT_BASE_URL || "https://127.0.0.1";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCREENSHOT_DIR =
  process.env.NORA_SCREENSHOT_DIR ||
  path.resolve(__dirname, "../../.github/readme-assets");
const DB_CONTAINER =
  process.env.NORA_SCREENSHOT_DB_CONTAINER || "nora-postgres-1";
const DB_USER = process.env.NORA_SCREENSHOT_DB_USER || process.env.DB_USER || "nora";
const DB_NAME = process.env.NORA_SCREENSHOT_DB_NAME || process.env.DB_NAME || "nora";
const REAL_HERMES_AGENT_ID =
  process.env.NORA_SCREENSHOT_REAL_HERMES_AGENT_ID || "";
const REAL_HERMES_TOKEN =
  process.env.NORA_SCREENSHOT_REAL_HERMES_TOKEN || "";
const ALLOW_LOCAL_HTTPS_ERRORS = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(
  BASE_URL
);

if (ALLOW_LOCAL_HTTPS_ERRORS) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const ACCOUNTS = {
  operator: {
    email: process.env.NORA_SCREENSHOT_EMAIL || "readme.operator@example.com",
    password:
      process.env.NORA_SCREENSHOT_PASSWORD || "ReadmeOperatorPass123!",
    name: process.env.NORA_SCREENSHOT_NAME || "README Operator",
    role: "user",
  },
  admin: {
    email:
      process.env.NORA_SCREENSHOT_ADMIN_EMAIL || "readme.admin@example.com",
    password:
      process.env.NORA_SCREENSHOT_ADMIN_PASSWORD || "ReadmeAdminPass123!",
    name: process.env.NORA_SCREENSHOT_ADMIN_NAME || "README Admin",
    role: "admin",
  },
  community: {
    email:
      process.env.NORA_SCREENSHOT_COMMUNITY_EMAIL ||
      "readme.community@example.com",
    password:
      process.env.NORA_SCREENSHOT_COMMUNITY_PASSWORD ||
      "ReadmeCommunityPass123!",
    name:
      process.env.NORA_SCREENSHOT_COMMUNITY_NAME || "Community Publisher",
    role: "user",
  },
};

const IDS = {
  agents: {
    primary: "11111111-1111-4111-8111-111111111111",
    support: "22222222-2222-4222-8222-222222222222",
    queued: "33333333-3333-4333-8333-333333333333",
    stopped: "44444444-4444-4444-8444-444444444444",
    hermes: "12121212-1212-4121-8121-121212121212",
  },
  snapshots: {
    presetSignalDesk: "55555555-5555-4555-8555-555555555551",
    presetResearch: "55555555-5555-4555-8555-555555555552",
    communityPublished: "66666666-6666-4666-8666-666666666661",
    communityPending: "66666666-6666-4666-8666-666666666662",
  },
  listings: {
    presetSignalDesk: "77777777-7777-4777-8777-777777777771",
    presetResearch: "77777777-7777-4777-8777-777777777772",
    communityPublished: "77777777-7777-4777-8777-777777777773",
    communityPending: "77777777-7777-4777-8777-777777777774",
  },
  reports: {
    communityOpen: "88888888-8888-4888-8888-888888888881",
  },
  events: {
    started: "99999999-9999-4999-8999-999999999991",
    redeployed: "99999999-9999-4999-8999-999999999992",
    installed: "99999999-9999-4999-8999-999999999993",
    submitted: "99999999-9999-4999-8999-999999999994",
    reported: "99999999-9999-4999-8999-999999999995",
    stopped: "99999999-9999-4999-8999-999999999996",
  },
};

const AGENT_IMAGE = "nora-openclaw-agent:local";
const HERMES_IMAGE = "nousresearch/hermes-agent:latest";

const HERMES_README_AGENT = {
  id: IDS.agents.hermes,
  user_id: "readme-hermes-operator",
  name: "Hermes Ops Coordinator",
  status: "running",
  backend_type: "hermes",
  runtime_family: "hermes",
  deploy_target: "docker",
  sandbox_profile: "standard",
  sandbox_type: "standard",
  node: "worker-02",
  host: "hermes-runtime.internal",
  runtime_host: "hermes-runtime.internal",
  runtime_port: 8642,
  container_name: "hermes-ops-coordinator",
  image: HERMES_IMAGE,
  vcpu: 4,
  ram_mb: 6144,
  disk_gb: 60,
  created_at: "2026-04-12T16:40:00.000Z",
  updated_at: "2026-04-12T16:58:00.000Z",
};

const HERMES_README_RUNTIME = {
  url: "http://hermes-runtime.internal:8642/v1",
  runtime: {
    host: "hermes-runtime.internal",
    port: 8642,
  },
  health: {
    ok: true,
    status: "ok",
    platform: "hermes-agent",
  },
  models: [
    { id: "hermes-agent" },
    { id: "hermes-agent-fast" },
  ],
  defaultModel: "anthropic/claude-sonnet-4-5",
  dashboard: {
    ready: true,
    url: "http://hermes-runtime.internal:9119",
    port: 9119,
    health: {
      ok: true,
      status: "ok",
    },
    error: null,
  },
  gateway: {
    state: "running",
    activeAgents: 1,
    configuredPlatformsCount: 4,
    discoveredTargetsCount: 12,
    jobsCount: 3,
    updatedAt: "2026-04-12T16:56:00.000Z",
    exitReason: null,
    restartRequested: false,
    platformStates: {
      telegram: {
        state: "connected",
      },
      discord: {
        state: "connected",
      },
      slack: {
        state: "idle",
      },
      email: {
        state: "warning",
        error_message: "SMTP auth pending confirmation.",
      },
    },
  },
  directoryUpdatedAt: "2026-04-12T16:55:00.000Z",
};

function buildHermesReadmeDashboardHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hermes Official Dashboard</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #07111f;
        --panel: rgba(13, 23, 42, 0.9);
        --panel-strong: #0f1d35;
        --panel-soft: rgba(15, 23, 42, 0.72);
        --border: rgba(148, 163, 184, 0.16);
        --text: #e5eefc;
        --muted: #8fa4c7;
        --accent: #67e8f9;
        --accent-strong: #22d3ee;
        --success: #4ade80;
        --warning: #fbbf24;
        --shadow: 0 28px 80px rgba(2, 6, 23, 0.38);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(34, 211, 238, 0.18), transparent 28%),
          radial-gradient(circle at top right, rgba(96, 165, 250, 0.12), transparent 32%),
          linear-gradient(180deg, #081120 0%, #0c1730 100%);
        color: var(--text);
      }

      .shell {
        display: grid;
        grid-template-columns: 236px minmax(0, 1fr);
        min-height: 100vh;
      }

      .sidebar {
        padding: 26px 20px;
        background: linear-gradient(180deg, rgba(8, 15, 30, 0.96), rgba(7, 13, 25, 0.92));
        border-right: 1px solid var(--border);
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 26px;
      }

      .brand-mark {
        width: 40px;
        height: 40px;
        border-radius: 14px;
        background: linear-gradient(135deg, rgba(34, 211, 238, 0.22), rgba(14, 165, 233, 0.9));
        display: grid;
        place-items: center;
        font-size: 18px;
        box-shadow: inset 0 0 0 1px rgba(186, 230, 253, 0.14);
      }

      .brand-copy {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .brand-copy strong {
        font-size: 14px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .brand-copy span {
        font-size: 11px;
        color: var(--muted);
      }

      .sidebar-section {
        margin-top: 20px;
      }

      .sidebar-label {
        margin: 0 0 10px;
        font-size: 10px;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: rgba(191, 219, 254, 0.54);
      }

      .nav-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        width: 100%;
        margin: 0 0 8px;
        padding: 12px 14px;
        border-radius: 18px;
        border: 1px solid transparent;
        background: transparent;
        color: var(--text);
        font: inherit;
      }

      .nav-item.active {
        background: linear-gradient(135deg, rgba(34, 211, 238, 0.18), rgba(37, 99, 235, 0.18));
        border-color: rgba(103, 232, 249, 0.28);
      }

      .nav-item span {
        font-size: 13px;
        font-weight: 600;
      }

      .nav-badge {
        padding: 5px 8px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.78);
        color: var(--muted);
        font-size: 10px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .sidebar-card {
        margin-top: 20px;
        padding: 16px;
        border-radius: 22px;
        background: rgba(15, 23, 42, 0.76);
        border: 1px solid var(--border);
      }

      .sidebar-card strong {
        display: block;
        margin-bottom: 6px;
        font-size: 13px;
      }

      .sidebar-card p {
        margin: 0;
        font-size: 12px;
        line-height: 1.5;
        color: var(--muted);
      }

      .sidebar-card .chip-row {
        display: flex;
        gap: 8px;
        margin-top: 12px;
      }

      .chip {
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(8, 15, 30, 0.94);
        border: 1px solid var(--border);
        color: var(--text);
        font-size: 10px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      main {
        padding: 28px;
      }

      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
        margin-bottom: 22px;
      }

      .eyebrow {
        margin: 0 0 8px;
        font-size: 11px;
        letter-spacing: 0.22em;
        text-transform: uppercase;
        color: rgba(191, 219, 254, 0.64);
      }

      .topbar h1 {
        margin: 0;
        font-size: 30px;
        line-height: 1.05;
        letter-spacing: -0.04em;
      }

      .topbar p {
        margin: 8px 0 0;
        max-width: 620px;
        font-size: 14px;
        color: var(--muted);
      }

      .status-row {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }

      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 9px 12px;
        border-radius: 999px;
        border: 1px solid rgba(74, 222, 128, 0.22);
        background: rgba(20, 83, 45, 0.26);
        font-size: 12px;
        font-weight: 600;
      }

      .status-pill::before {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--success);
        box-shadow: 0 0 0 6px rgba(74, 222, 128, 0.12);
      }

      .status-meta {
        padding: 9px 12px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.78);
        border: 1px solid var(--border);
        color: var(--muted);
        font-size: 12px;
      }

      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1.6fr) minmax(280px, 0.9fr);
        gap: 18px;
        margin-bottom: 18px;
      }

      .hero-panel,
      .card,
      .list-card,
      .activity-card {
        border-radius: 28px;
        border: 1px solid var(--border);
        background: var(--panel);
        box-shadow: var(--shadow);
        overflow: hidden;
      }

      .hero-panel {
        padding: 24px 24px 20px;
        background:
          linear-gradient(135deg, rgba(34, 211, 238, 0.18), rgba(96, 165, 250, 0.08)),
          var(--panel-strong);
      }

      .hero-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-top: 18px;
      }

      .hero-stat {
        padding: 14px;
        border-radius: 20px;
        background: rgba(7, 13, 25, 0.38);
        border: 1px solid rgba(125, 211, 252, 0.12);
      }

      .hero-stat small,
      .metric-card small,
      .section-label {
        display: block;
        margin-bottom: 8px;
        font-size: 10px;
        letter-spacing: 0.2em;
        text-transform: uppercase;
        color: rgba(191, 219, 254, 0.62);
      }

      .hero-stat strong,
      .metric-card strong {
        display: block;
        font-size: 21px;
        line-height: 1.1;
      }

      .hero-stat span,
      .metric-card span {
        display: block;
        margin-top: 6px;
        font-size: 12px;
        color: var(--muted);
      }

      .hero-side {
        padding: 22px;
      }

      .hero-side h2,
      .card h2,
      .list-card h2,
      .activity-card h2 {
        margin: 0;
        font-size: 16px;
      }

      .hero-side p {
        margin: 12px 0 16px;
        font-size: 13px;
        line-height: 1.55;
        color: var(--muted);
      }

      .timeline {
        display: grid;
        gap: 12px;
      }

      .timeline-item {
        display: grid;
        grid-template-columns: 12px minmax(0, 1fr);
        gap: 12px;
      }

      .timeline-dot {
        width: 12px;
        height: 12px;
        margin-top: 5px;
        border-radius: 999px;
        background: linear-gradient(135deg, var(--accent), #2563eb);
        box-shadow: 0 0 0 5px rgba(34, 211, 238, 0.12);
      }

      .timeline-copy strong {
        display: block;
        margin-bottom: 4px;
        font-size: 13px;
      }

      .timeline-copy span {
        display: block;
        font-size: 12px;
        color: var(--muted);
      }

      .metrics {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
        margin-bottom: 18px;
      }

      .metric-card {
        padding: 16px;
        border-radius: 24px;
        background: var(--panel-soft);
        border: 1px solid var(--border);
      }

      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.95fr);
        gap: 18px;
      }

      .card-header,
      .list-header,
      .activity-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 18px 20px 0;
      }

      .card-body,
      .list-body,
      .activity-body {
        padding: 18px 20px 20px;
      }

      .workspace-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }

      .workspace-tile {
        padding: 16px;
        border-radius: 22px;
        background: rgba(8, 15, 30, 0.6);
        border: 1px solid var(--border);
      }

      .workspace-tile strong {
        display: block;
        margin-bottom: 8px;
        font-size: 13px;
      }

      .workspace-tile p {
        margin: 0;
        font-size: 12px;
        line-height: 1.55;
        color: var(--muted);
      }

      .pill-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 14px;
      }

      .pill-row span {
        padding: 7px 10px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.78);
        border: 1px solid var(--border);
        font-size: 11px;
        color: var(--text);
      }

      .list {
        display: grid;
        gap: 12px;
      }

      .list-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 14px 16px;
        border-radius: 20px;
        background: rgba(8, 15, 30, 0.58);
        border: 1px solid var(--border);
      }

      .list-item strong {
        display: block;
        margin-bottom: 4px;
        font-size: 13px;
      }

      .list-item span {
        font-size: 12px;
        color: var(--muted);
      }

      .list-status {
        padding: 6px 9px;
        border-radius: 999px;
        font-size: 10px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        background: rgba(20, 83, 45, 0.3);
        border: 1px solid rgba(74, 222, 128, 0.24);
      }

      .list-status.warning {
        color: #fde68a;
        background: rgba(120, 53, 15, 0.3);
        border-color: rgba(251, 191, 36, 0.24);
      }

      .activity-card {
        background:
          radial-gradient(circle at top right, rgba(103, 232, 249, 0.12), transparent 34%),
          var(--panel);
      }

      .activity-list {
        display: grid;
        gap: 14px;
      }

      .activity-item {
        padding: 14px 16px;
        border-radius: 22px;
        background: rgba(8, 15, 30, 0.58);
        border: 1px solid var(--border);
      }

      .activity-item strong {
        display: block;
        margin-bottom: 6px;
        font-size: 13px;
      }

      .activity-item span {
        display: block;
        font-size: 12px;
        line-height: 1.55;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">H</div>
          <div class="brand-copy">
            <strong>Hermes</strong>
            <span>Official dashboard</span>
          </div>
        </div>

        <div class="sidebar-section">
          <p class="sidebar-label">Operator</p>
          <button class="nav-item active" type="button">
            <span>Command center</span>
            <span class="nav-badge">live</span>
          </button>
          <button class="nav-item" type="button">
            <span>Channels</span>
            <span class="nav-badge">4</span>
          </button>
          <button class="nav-item" type="button">
            <span>Cron jobs</span>
            <span class="nav-badge">3</span>
          </button>
          <button class="nav-item" type="button">
            <span>Models</span>
            <span class="nav-badge">2</span>
          </button>
        </div>

        <div class="sidebar-card">
          <strong>Runtime summary</strong>
          <p>Healthy gateway, 12 discovered targets, and the default model already synced from Nora.</p>
          <div class="chip-row">
            <span class="chip">Port 9119</span>
            <span class="chip">Docker</span>
          </div>
        </div>
      </aside>

      <main>
        <div class="topbar">
          <div>
            <p class="eyebrow">Official Hermes dashboard</p>
            <h1>Hermes Ops Coordinator</h1>
            <p>Operate channels, automations, and runtime health from the embedded dashboard while Nora keeps deployment and infrastructure control.</p>
          </div>
          <div class="status-row">
            <span class="status-pill">Runtime healthy</span>
            <span class="status-meta">Default model: anthropic/claude-sonnet-4-5</span>
          </div>
        </div>

        <section class="hero">
          <div class="hero-panel">
            <span class="section-label">Deployment overview</span>
            <h2>Gateway activity is stable across live channels.</h2>
            <div class="hero-grid">
              <div class="hero-stat">
                <small>Configured platforms</small>
                <strong>4</strong>
                <span>Slack, Discord, Telegram, Email</span>
              </div>
              <div class="hero-stat">
                <small>Discovered targets</small>
                <strong>12</strong>
                <span>Ready for routing and follow-up</span>
              </div>
              <div class="hero-stat">
                <small>Cron jobs</small>
                <strong>3</strong>
                <span>Morning digest, weekly sync, backlog sweep</span>
              </div>
            </div>
          </div>

          <div class="hero-side">
            <h2>Recent automation flow</h2>
            <p>Hermes is serving the official dashboard while Nora continues to own runtime lifecycle, logs, and terminal access.</p>
            <div class="timeline">
              <div class="timeline-item">
                <div class="timeline-dot"></div>
                <div class="timeline-copy">
                  <strong>Dashboard session established</strong>
                  <span>Embedded access proxied through Nora with a fresh session token.</span>
                </div>
              </div>
              <div class="timeline-item">
                <div class="timeline-dot"></div>
                <div class="timeline-copy">
                  <strong>LLM defaults synced</strong>
                  <span>anthropic/claude-sonnet-4-5 is active for prompts and scheduled jobs.</span>
                </div>
              </div>
              <div class="timeline-item">
                <div class="timeline-dot"></div>
                <div class="timeline-copy">
                  <strong>Outbound channels ready</strong>
                  <span>Slack and Discord are connected, email is waiting on SMTP confirmation.</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="metrics">
          <div class="metric-card">
            <small>Published models</small>
            <strong>2</strong>
            <span>hermes-agent, hermes-agent-fast</span>
          </div>
          <div class="metric-card">
            <small>Runtime API</small>
            <strong>8642</strong>
            <span>OpenAI-compatible endpoint online</span>
          </div>
          <div class="metric-card">
            <small>Dashboard port</small>
            <strong>9119</strong>
            <span>Embedded through Nora</span>
          </div>
          <div class="metric-card">
            <small>Active agents</small>
            <strong>1</strong>
            <span>Gateway currently serving a single runtime</span>
          </div>
        </section>

        <section class="layout">
          <div class="card">
            <div class="card-header">
              <h2>Workspace controls</h2>
              <span class="nav-badge">Official view</span>
            </div>
            <div class="card-body">
              <div class="workspace-grid">
                <div class="workspace-tile">
                  <strong>Channels</strong>
                  <p>Inspect connected platforms, discovered targets, and routing state from one place.</p>
                </div>
                <div class="workspace-tile">
                  <strong>Automations</strong>
                  <p>Keep cron-driven prompts, queue handoffs, and escalation logic visible to operators.</p>
                </div>
                <div class="workspace-tile">
                  <strong>Model settings</strong>
                  <p>Review the default provider sync that Nora applied to the running Hermes runtime.</p>
                </div>
                <div class="workspace-tile">
                  <strong>Operator audit</strong>
                  <p>Pair this surface with Nora logs and terminal access when runtime changes need validation.</p>
                </div>
              </div>
              <div class="pill-row">
                <span>Runtime Ready</span>
                <span>Config synced</span>
                <span>Operator embed active</span>
              </div>
            </div>
          </div>

          <div class="list-card">
            <div class="list-header">
              <h2>Channel health</h2>
              <span class="nav-badge">Gateway</span>
            </div>
            <div class="list-body">
              <div class="list">
                <div class="list-item">
                  <div>
                    <strong>Slack</strong>
                    <span>Connected and receiving routed prompts</span>
                  </div>
                  <span class="list-status">connected</span>
                </div>
                <div class="list-item">
                  <div>
                    <strong>Discord</strong>
                    <span>Connected with healthy event delivery</span>
                  </div>
                  <span class="list-status">connected</span>
                </div>
                <div class="list-item">
                  <div>
                    <strong>Telegram</strong>
                    <span>Idle until the next scheduled digest</span>
                  </div>
                  <span class="list-status">idle</span>
                </div>
                <div class="list-item">
                  <div>
                    <strong>Email</strong>
                    <span>SMTP auth pending confirmation from the provider</span>
                  </div>
                  <span class="list-status warning">warning</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="activity-card" style="margin-top: 18px;">
          <div class="activity-header">
            <h2>Operator activity</h2>
            <span class="nav-badge">Last 30 min</span>
          </div>
          <div class="activity-body">
            <div class="activity-list">
              <div class="activity-item">
                <strong>16:56 UTC</strong>
                <span>Gateway snapshot refreshed with 4 configured platforms and 12 discovered targets.</span>
              </div>
              <div class="activity-item">
                <strong>16:53 UTC</strong>
                <span>Default model sync completed from Nora settings into the running Hermes runtime.</span>
              </div>
              <div class="activity-item">
                <strong>16:48 UTC</strong>
                <span>Official dashboard health probe passed and embed access was enabled for operators.</span>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  </body>
</html>`;
}

function encodeContentBase64(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function textFile(filePath, content) {
  return {
    path: filePath,
    contentBase64: encodeContentBase64(`${String(content).trim()}\n`),
  };
}

function buildTemplatePayload({
  name,
  description,
  category,
  ownerName,
  sourceType,
  missionLines,
  soulLines,
  toolsLines,
  userLines,
  heartbeatLines,
  memoryLines,
  bootstrapLines,
  extraFiles = [],
}) {
  const sourceLabel =
    sourceType === "platform" ? "Platform preset" : "Community template";
  const files = [
    textFile(
      "AGENTS.md",
      `# ${name}

${description}

## Mission

${missionLines.map((line) => `- ${line}`).join("\n")}`
    ),
    textFile(
      "SOUL.md",
      `## Soul

${soulLines.map((line) => `- ${line}`).join("\n")}`
    ),
    textFile(
      "TOOLS.md",
      `## Tools

${toolsLines.map((line) => `- ${line}`).join("\n")}`
    ),
    textFile(
      "IDENTITY.md",
      `## Identity

- Name: ${name}
- Category: ${category}
- Source: ${sourceLabel}
- Publisher: ${ownerName}
- Primary role: ${description}`
    ),
    textFile(
      "USER.md",
      `## User

${userLines.map((line) => `- ${line}`).join("\n")}`
    ),
    textFile(
      "HEARTBEAT.md",
      `## Heartbeat

${heartbeatLines.map((line) => `- ${line}`).join("\n")}`
    ),
    textFile(
      "MEMORY.md",
      `## Memory

- Template: ${name}
- Category: ${category}
- Publisher: ${ownerName}

${memoryLines.map((line) => `- ${line}`).join("\n")}`
    ),
    textFile(
      "BOOTSTRAP.md",
      `## Bootstrap

${bootstrapLines.map((line, index) => `${index + 1}. ${line}`).join("\n")}`
    ),
    ...extraFiles.map((file) => textFile(file.path, file.content)),
  ];

  return {
    version: 1,
    files,
    memoryFiles: [],
    wiring: {
      channels: [],
      integrations: [],
    },
    metadata: {
      readmeDemo: true,
      sourceType,
    },
  };
}

function buildSnapshotConfig({
  templateKey,
  builtIn,
  payload,
  defaults = {},
  kind,
}) {
  return {
    kind,
    templateKey,
    builtIn,
    defaults: {
      backend: defaults.backend || "docker",
      sandbox: defaults.sandbox || "standard",
      vcpu: defaults.vcpu || 2,
      ram_mb: defaults.ram_mb || 2048,
      disk_gb: defaults.disk_gb || 20,
      image: defaults.image || AGENT_IMAGE,
    },
    templatePayload: payload,
  };
}

function sqlLiteral(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function sqlJson(value) {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

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
    throw new Error(
      `${res.status} ${res.statusText} :: ${
        typeof data === "string" ? data : JSON.stringify(data)
      }`
    );
  }

  return data;
}

async function ensureSignup({ email, password }) {
  try {
    await requestJson(`${BASE_URL}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch (error) {
    const message = String(error.message || "");
    if (!message.includes("duplicate")) {
      // login below is the authoritative check
    }
  }
}

async function login({ email, password }) {
  return requestJson(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

async function ensureAccount(account) {
  await ensureSignup(account);
  const auth = await login(account);
  const me = await requestJson(`${BASE_URL}/api/auth/me`, {
    headers: { Authorization: `Bearer ${auth.token}` },
  });

  return {
    ...account,
    token: auth.token,
    user: me,
  };
}

async function ensureProviders(token) {
  const headers = {
    "content-type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  const existing = await requestJson(`${BASE_URL}/api/llm-providers`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const existingProviders = new Set((existing || []).map((row) => row.provider));
  const desired = [
    {
      provider: "openai",
      apiKey: "sk-openai-demo-1234567890abcdef",
      model: "gpt-5.4",
    },
    {
      provider: "anthropic",
      apiKey: "sk-ant-demo-abcdef1234567890",
      model: "claude-3-7-sonnet-latest",
    },
  ];

  for (const provider of desired) {
    if (existingProviders.has(provider.provider)) continue;

    await requestJson(`${BASE_URL}/api/llm-providers`, {
      method: "POST",
      headers,
      body: JSON.stringify(provider),
    });
  }
}

function buildSeedTemplates({ operatorUserId, adminUserId, communityUserId }) {
  const presetSignalDeskPayload = buildTemplatePayload({
    name: "Signal Desk Starter",
    description:
      "Triage inbound market signal, operator requests, and follow-up work into a clean daily action list.",
    category: "Operations",
    ownerName: "Nora",
    sourceType: "platform",
    missionLines: [
      "Separate signal from noise across inbox, CRM requests, and partner notes.",
      "Escalate only what needs a human decision or a committed follow-up.",
      "Keep summaries short, specific, and operational.",
    ],
    soulLines: [
      "Reduce overload instead of adding process.",
      "Prefer direct language, explicit ownership, and clear deadlines.",
      "Call out uncertainty when context is incomplete.",
    ],
    toolsLines: [
      "Review message logs, notes, and lightweight task context.",
      "Sort items into action now, watch list, and archive.",
      "Produce short briefings for the current operator.",
    ],
    userLines: [
      "Assume the user wants fewer notifications and better signal.",
      "Stay concise until the user asks for deeper analysis.",
    ],
    heartbeatLines: [
      "Read the core files before acting.",
      "Preserve the template mission in every response.",
      "Summarize the current state before ending a task.",
    ],
    memoryLines: [
      "Track recurring signal sources and blocked follow-ups.",
      "Remember durable preferences about summaries and escalation style.",
    ],
    bootstrapLines: [
      "Read AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md, and MEMORY.md.",
      "Restate the operator goal in one sentence.",
      "Keep the first output short and useful.",
    ],
    extraFiles: [
      {
        path: "playbooks/daily-triage.md",
        content: `## Daily Triage

- Review all new inbound requests.
- Group by urgency, owner, and dependency.
- End with a compact action list.`,
      },
      {
        path: "knowledge/operator-lanes.md",
        content: `## Operator Lanes

- Inbox triage
- Customer escalation
- Weekly summary
- Follow-up queue`,
      },
    ],
  });

  const presetResearchPayload = buildTemplatePayload({
    name: "Research Briefing Claw",
    description:
      "Turn source material, links, and rough notes into concise briefings with citations and next steps.",
    category: "Research",
    ownerName: "Nora",
    sourceType: "platform",
    missionLines: [
      "Read source material and extract the most decision-relevant facts.",
      "Preserve citations and note where evidence is weak.",
      "Convert findings into a clear briefing with next actions.",
    ],
    soulLines: [
      "Do not overstate confidence.",
      "Prefer primary sources and short summaries.",
      "Keep recommendations grounded in evidence.",
    ],
    toolsLines: [
      "Use source documents, notes, and structured context.",
      "Capture citations, open questions, and tradeoffs.",
      "Produce briefings sized for fast review.",
    ],
    userLines: [
      "Assume the user wants the shortest path to a correct decision.",
      "Separate confirmed facts from inference.",
    ],
    heartbeatLines: [
      "Check evidence before conclusions.",
      "Surface missing context early.",
      "Close with the next decision or action.",
    ],
    memoryLines: [
      "Track recurring topics, preferred source types, and unresolved questions.",
    ],
    bootstrapLines: [
      "Read the core files.",
      "Confirm the briefing audience and deadline.",
      "Return the first summary with citations.",
    ],
    extraFiles: [
      {
        path: "briefing-format.md",
        content: `## Briefing Format

1. Executive summary
2. Supporting facts
3. Risks and unknowns
4. Recommended next steps`,
      },
    ],
  });

  const communityPublishedPayload = buildTemplatePayload({
    name: "Revenue Ops Coach",
    description:
      "Shared workflow for pipeline reviews, handoff audits, and weekly revenue risk summaries.",
    category: "Revenue",
    ownerName: ACCOUNTS.community.name,
    sourceType: "community",
    missionLines: [
      "Review weekly pipeline movement and stalled handoffs.",
      "Flag deal risk, ownership gaps, and missing follow-ups.",
      "Turn raw revenue updates into one practical weekly summary.",
    ],
    soulLines: [
      "Stay calm and specific.",
      "Prioritize handoff risk over commentary.",
      "Do not hide missing ownership.",
    ],
    toolsLines: [
      "Use CRM exports, handoff notes, and pipeline review inputs.",
      "Call out risk, owner, and next step on every important item.",
    ],
    userLines: [
      "Assume the operator wants clear deal risk and explicit owners.",
    ],
    heartbeatLines: [
      "Scan the data.",
      "Sort by risk level.",
      "Publish a concise review.",
    ],
    memoryLines: [
      "Remember recurring pipeline blockers and handoff patterns.",
    ],
    bootstrapLines: [
      "Read the core files before touching the weekly review.",
      "Confirm the pipeline window for this run.",
      "Return the weekly summary with owners and next steps.",
    ],
    extraFiles: [
      {
        path: "docs/handoff-audit.md",
        content: `## Handoff Audit

- Check owner continuity.
- Verify next meeting or next action.
- Flag CRM gaps before summarizing.`,
      },
    ],
  });

  const communityPendingPayload = buildTemplatePayload({
    name: "Founder Inbox Curator",
    description:
      "Draft workflow for founder inbox triage, weekly summaries, and high-signal follow-up tracking.",
    category: "Founders",
    ownerName: ACCOUNTS.operator.name,
    sourceType: "community",
    missionLines: [
      "Review founder inbox threads, partner notes, and operator summaries.",
      "Separate high-signal requests from background chatter.",
      "Build one action-oriented digest with follow-up owners.",
    ],
    soulLines: [
      "Protect attention before volume.",
      "Keep summaries compact and decision-oriented.",
      "Escalate only what clearly needs response.",
    ],
    toolsLines: [
      "Review inbound threads, notes, and meeting follow-ups.",
      "Group work by urgency, owner, and response deadline.",
      "Publish a short summary with next actions.",
    ],
    userLines: [
      "Assume the user wants fewer interruptions and clearer next steps.",
    ],
    heartbeatLines: [
      "Collect new inputs.",
      "Sort by urgency and response owner.",
      "Send a concise daily digest.",
    ],
    memoryLines: [
      "Track recurring senders, open loops, and escalation preferences.",
    ],
    bootstrapLines: [
      "Read the core files and restate the daily digest goal.",
      "Confirm the inbox sources included in this run.",
      "Keep the first response short and actionable.",
    ],
    extraFiles: [
      {
        path: "prompts/daily-digest.md",
        content: `## Daily Digest

- Top signal
- Replies needed today
- Follow-up owners
- Threads to archive`,
      },
      {
        path: "notes/publisher-checklist.md",
        content: `## Publisher Checklist

- Category is final
- Version is bumped
- Description matches actual behavior
- Core files are complete`,
      },
    ],
  });

  const templates = [
    {
      snapshotId: IDS.snapshots.presetSignalDesk,
      listingId: IDS.listings.presetSignalDesk,
      snapshotName: "Signal Desk Starter",
      snapshotDescription:
        "Triage inbound market signal, operator requests, and follow-up work into a clean daily action list.",
      snapshotKind: "starter-template",
      templateKey: "readme-signal-desk-starter",
      builtIn: true,
      ownerUserId: null,
      listingName: "Signal Desk Starter",
      listingDescription:
        "Triage inbound market signal, operator requests, and follow-up work into a clean daily action list.",
      category: "Operations",
      installs: 128,
      downloads: 241,
      sourceType: "platform",
      status: "published",
      slug: "signal-desk-starter",
      currentVersion: 4,
      reviewNotes: "Platform preset synced with the current OpenClaw core file pack.",
      reviewedBy: adminUserId,
      publishedAtSql: "NOW() - INTERVAL '18 days'",
      updatedAtSql: "NOW() - INTERVAL '3 hours'",
      createdAtSql: "NOW() - INTERVAL '21 days'",
      defaults: {
        backend: "docker",
        sandbox: "standard",
        vcpu: 2,
        ram_mb: 3072,
        disk_gb: 24,
        image: AGENT_IMAGE,
      },
      payload: presetSignalDeskPayload,
    },
    {
      snapshotId: IDS.snapshots.presetResearch,
      listingId: IDS.listings.presetResearch,
      snapshotName: "Research Briefing Claw",
      snapshotDescription:
        "Turn source material, links, and rough notes into concise briefings with citations and next steps.",
      snapshotKind: "starter-template",
      templateKey: "readme-research-briefing-claw",
      builtIn: true,
      ownerUserId: null,
      listingName: "Research Briefing Claw",
      listingDescription:
        "Turn source material, links, and rough notes into concise briefings with citations and next steps.",
      category: "Research",
      installs: 91,
      downloads: 167,
      sourceType: "platform",
      status: "published",
      slug: "research-briefing-claw",
      currentVersion: 3,
      reviewNotes: "Preset includes bootstrap guidance and citation-oriented defaults.",
      reviewedBy: adminUserId,
      publishedAtSql: "NOW() - INTERVAL '12 days'",
      updatedAtSql: "NOW() - INTERVAL '1 day'",
      createdAtSql: "NOW() - INTERVAL '16 days'",
      defaults: {
        backend: "docker",
        sandbox: "standard",
        vcpu: 2,
        ram_mb: 4096,
        disk_gb: 28,
        image: AGENT_IMAGE,
      },
      payload: presetResearchPayload,
    },
    {
      snapshotId: IDS.snapshots.communityPublished,
      listingId: IDS.listings.communityPublished,
      snapshotName: "Revenue Ops Coach",
      snapshotDescription:
        "Shared workflow for pipeline reviews, handoff audits, and weekly revenue risk summaries.",
      snapshotKind: "community-template",
      templateKey: "readme-revenue-ops-coach",
      builtIn: false,
      ownerUserId: communityUserId,
      listingName: "Revenue Ops Coach",
      listingDescription:
        "Shared workflow for pipeline reviews, handoff audits, and weekly revenue risk summaries.",
      category: "Revenue",
      installs: 32,
      downloads: 61,
      sourceType: "community",
      status: "published",
      slug: "revenue-ops-coach",
      currentVersion: 2,
      reviewNotes: "Approved for community install after copy cleanup.",
      reviewedBy: adminUserId,
      publishedAtSql: "NOW() - INTERVAL '7 days'",
      updatedAtSql: "NOW() - INTERVAL '30 minutes'",
      createdAtSql: "NOW() - INTERVAL '9 days'",
      defaults: {
        backend: "docker",
        sandbox: "standard",
        vcpu: 2,
        ram_mb: 3072,
        disk_gb: 22,
        image: AGENT_IMAGE,
      },
      payload: communityPublishedPayload,
    },
    {
      snapshotId: IDS.snapshots.communityPending,
      listingId: IDS.listings.communityPending,
      snapshotName: "Founder Inbox Curator",
      snapshotDescription:
        "Draft workflow for founder inbox triage, weekly summaries, and high-signal follow-up tracking.",
      snapshotKind: "community-template",
      templateKey: "readme-founder-inbox-curator",
      builtIn: false,
      ownerUserId: operatorUserId,
      listingName: "Founder Inbox Curator",
      listingDescription:
        "Draft workflow for founder inbox triage, weekly summaries, and high-signal follow-up tracking.",
      category: "Founders",
      installs: 0,
      downloads: 4,
      sourceType: "community",
      status: "pending_review",
      slug: "founder-inbox-curator",
      currentVersion: 2,
      reviewNotes:
        "Review category naming, then verify the summary cadence copy before publish.",
      reviewedBy: null,
      publishedAtSql: "NULL",
      updatedAtSql: "NOW() - INTERVAL '8 minutes'",
      createdAtSql: "NOW() - INTERVAL '2 hours'",
      defaults: {
        backend: "docker",
        sandbox: "standard",
        vcpu: 2,
        ram_mb: 2048,
        disk_gb: 20,
        image: AGENT_IMAGE,
      },
      payload: communityPendingPayload,
    },
  ];

  const snapshots = templates.map((template) => ({
    id: template.snapshotId,
    agentId:
      template.listingId === IDS.listings.communityPending
        ? IDS.agents.primary
        : null,
    name: template.snapshotName,
    description: template.snapshotDescription,
    kind: template.snapshotKind,
    templateKey: template.templateKey,
    builtIn: template.builtIn,
    config: buildSnapshotConfig({
      templateKey: template.templateKey,
      builtIn: template.builtIn,
      payload: template.payload,
      defaults: template.defaults,
      kind: template.snapshotKind,
    }),
    createdAtSql: template.createdAtSql,
  }));

  return { templates, snapshots };
}

function buildEventMetadata({
  operatorUserId,
  communityUserId,
  type,
}) {
  const source = {
    kind: "account",
    service: "backend-api",
    label: ACCOUNTS.operator.name,
    account: {
      userId: operatorUserId,
      email: ACCOUNTS.operator.email,
      role: "user",
    },
  };

  if (type === "started") {
    return {
      source,
      agent: {
        id: IDS.agents.primary,
        name: "OpenClaw Research Operator",
        ownerUserId: operatorUserId,
        ownerEmail: ACCOUNTS.operator.email,
      },
      result: {
        previousStatus: "queued",
        nextStatus: "running",
      },
      request: {
        method: "POST",
        path: `/api/agents/${IDS.agents.primary}/start`,
        correlationId: "readme-start-001",
      },
    };
  }

  if (type === "redeployed") {
    return {
      source,
      agent: {
        id: IDS.agents.support,
        name: "Support Inbox Agent",
        ownerUserId: operatorUserId,
        ownerEmail: ACCOUNTS.operator.email,
      },
      result: {
        previousStatus: "warning",
        nextStatus: "running",
      },
      deploy: {
        type: "redeploy",
        specs: {
          vcpu: 2,
          ram_mb: 4096,
          disk_gb: 40,
        },
      },
      request: {
        method: "POST",
        path: `/api/agents/${IDS.agents.support}/redeploy`,
        correlationId: "readme-redeploy-001",
      },
    };
  }

  if (type === "installed") {
    return {
      source,
      listing: {
        id: IDS.listings.presetSignalDesk,
        name: "Signal Desk Starter",
        ownerUserId: null,
      },
      agent: {
        id: IDS.agents.queued,
        name: "Spec Writer Queue",
        ownerUserId: operatorUserId,
        ownerEmail: ACCOUNTS.operator.email,
      },
      result: {
        status: "queued",
      },
      request: {
        method: "POST",
        path: "/api/marketplace/install",
        correlationId: "readme-install-001",
      },
    };
  }

  if (type === "submitted") {
    return {
      source,
      listing: {
        id: IDS.listings.communityPending,
        name: "Founder Inbox Curator",
        ownerUserId: operatorUserId,
      },
      agent: {
        id: IDS.agents.primary,
        name: "OpenClaw Research Operator",
        ownerUserId: operatorUserId,
        ownerEmail: ACCOUNTS.operator.email,
      },
      request: {
        method: "POST",
        path: "/api/marketplace/publish",
        correlationId: "readme-submit-001",
      },
    };
  }

  if (type === "reported") {
    return {
      source,
      listing: {
        id: IDS.listings.communityPublished,
        name: "Revenue Ops Coach",
        ownerUserId: communityUserId,
      },
      report: {
        id: IDS.reports.communityOpen,
        reason: "misleading",
        reporterUserId: operatorUserId,
      },
      reportDetails: {
        details:
          "The listing copy promises automated CRM handoff, but the file set still expects manual review.",
      },
      request: {
        method: "POST",
        path: `/api/marketplace/${IDS.listings.communityPublished}/report`,
        correlationId: "readme-report-001",
      },
    };
  }

  return {
    source,
    agent: {
      id: IDS.agents.stopped,
      name: "Retention Analyst",
      ownerUserId: operatorUserId,
      ownerEmail: ACCOUNTS.operator.email,
    },
    result: {
      previousStatus: "running",
      nextStatus: "stopped",
    },
    request: {
      method: "POST",
      path: `/api/agents/${IDS.agents.stopped}/stop`,
      correlationId: "readme-stop-001",
    },
  };
}

function buildSeedSql({ operatorUser, adminUser, communityUser }) {
  const { templates, snapshots } = buildSeedTemplates({
    operatorUserId: operatorUser.id,
    adminUserId: adminUser.id,
    communityUserId: communityUser.id,
  });
  const listingIds = templates.map((template) => template.listingId);
  const snapshotIds = snapshots.map((snapshot) => snapshot.id);
  const agentIds = Object.values(IDS.agents);
  const operatorId = operatorUser.id;
  const communityId = communityUser.id;
  const adminId = adminUser.id;

  const eventRows = [
    {
      id: IDS.events.started,
      type: "agent_started",
      message:
        'OpenClaw Research Operator restarted cleanly after the latest template sync.',
      metadata: buildEventMetadata({
        operatorUserId: operatorId,
        communityUserId: communityId,
        type: "started",
      }),
      createdAtSql: "NOW() - INTERVAL '5 minutes'",
    },
    {
      id: IDS.events.redeployed,
      type: "agent_redeployed",
      message:
        'Support Inbox Agent finished a clean redeploy with the updated core files.',
      metadata: buildEventMetadata({
        operatorUserId: operatorId,
        communityUserId: communityId,
        type: "redeployed",
      }),
      createdAtSql: "NOW() - INTERVAL '17 minutes'",
    },
    {
      id: IDS.events.installed,
      type: "marketplace_install",
      message:
        'Installed platform preset "Signal Desk Starter" as a new queued agent.',
      metadata: buildEventMetadata({
        operatorUserId: operatorId,
        communityUserId: communityId,
        type: "installed",
      }),
      createdAtSql: "NOW() - INTERVAL '41 minutes'",
    },
    {
      id: IDS.events.submitted,
      type: "marketplace_submitted",
      message:
        'Submitted "Founder Inbox Curator" for marketplace review.',
      metadata: buildEventMetadata({
        operatorUserId: operatorId,
        communityUserId: communityId,
        type: "submitted",
      }),
      createdAtSql: "NOW() - INTERVAL '1 hour 12 minutes'",
    },
    {
      id: IDS.events.reported,
      type: "marketplace_reported",
      message:
        'Reported community listing "Revenue Ops Coach" for misleading onboarding copy.',
      metadata: buildEventMetadata({
        operatorUserId: operatorId,
        communityUserId: communityId,
        type: "reported",
      }),
      createdAtSql: "NOW() - INTERVAL '2 hours 5 minutes'",
    },
    {
      id: IDS.events.stopped,
      type: "agent_stopped",
      message: 'Retention Analyst was stopped after the weekly review cycle.',
      metadata: buildEventMetadata({
        operatorUserId: operatorId,
        communityUserId: communityId,
        type: "stopped",
      }),
      createdAtSql: "NOW() - INTERVAL '4 hours'",
    },
  ];

  return `
UPDATE users SET name = ${sqlLiteral(ACCOUNTS.operator.name)}, role = 'user' WHERE id = ${sqlLiteral(operatorId)};
UPDATE users SET name = ${sqlLiteral(ACCOUNTS.admin.name)}, role = 'admin' WHERE id = ${sqlLiteral(adminId)};
UPDATE users SET name = ${sqlLiteral(ACCOUNTS.community.name)}, role = 'user' WHERE id = ${sqlLiteral(communityId)};

DELETE FROM marketplace_reports
 WHERE listing_id IN (${listingIds.map(sqlLiteral).join(", ")})
    OR reporter_user_id IN (${sqlLiteral(operatorId)}, ${sqlLiteral(communityId)});

DELETE FROM marketplace_listing_versions
 WHERE listing_id IN (${listingIds.map(sqlLiteral).join(", ")});

DELETE FROM marketplace_listings
 WHERE id IN (${listingIds.map(sqlLiteral).join(", ")})
    OR owner_user_id IN (${sqlLiteral(operatorId)}, ${sqlLiteral(communityId)})
    OR slug IN (
      'signal-desk-starter',
      'research-briefing-claw',
      'revenue-ops-coach',
      'founder-inbox-curator'
    );

DELETE FROM snapshots
 WHERE id IN (${snapshotIds.map(sqlLiteral).join(", ")})
    OR template_key LIKE 'readme-%';

DELETE FROM events
 WHERE id IN (${Object.values(IDS.events).map(sqlLiteral).join(", ")})
    OR metadata #>> '{source,account,userId}' = ${sqlLiteral(operatorId)}
    OR metadata #>> '{actor,userId}' = ${sqlLiteral(operatorId)}
    OR metadata #>> '{agent,ownerUserId}' = ${sqlLiteral(operatorId)}
    OR metadata #>> '{listing,ownerUserId}' = ${sqlLiteral(operatorId)}
    OR metadata #>> '{report,reporterUserId}' = ${sqlLiteral(operatorId)}
    OR metadata #>> '{report,reviewerUserId}' = ${sqlLiteral(operatorId)}
    OR metadata->>'agentId' IN (${agentIds.map(sqlLiteral).join(", ")})
    OR metadata #>> '{agent,id}' IN (${agentIds.map(sqlLiteral).join(", ")})
    OR metadata #>> '{listing,id}' IN (${listingIds.map(sqlLiteral).join(", ")});

DELETE FROM container_stats WHERE agent_id IN (${agentIds.map(sqlLiteral).join(", ")});
DELETE FROM deployments WHERE agent_id IN (${agentIds.map(sqlLiteral).join(", ")});
DELETE FROM agents WHERE user_id = ${sqlLiteral(operatorId)};

INSERT INTO agents (
  id,
  user_id,
  name,
  status,
  backend_type,
  node,
  host,
  container_name,
  image,
  vcpu,
  ram_mb,
  disk_gb,
  created_at,
  sandbox_type,
  gateway_host_port
) VALUES
  (
    ${sqlLiteral(IDS.agents.primary)},
    ${sqlLiteral(operatorId)},
    'OpenClaw Research Operator',
    'running',
    'docker',
    'worker-01',
    'host.docker.internal',
    'nora-research-ops',
    ${sqlLiteral(AGENT_IMAGE)},
    4,
    8192,
    80,
    NOW() - INTERVAL '22 minutes',
    'standard',
    18789
  ),
  (
    ${sqlLiteral(IDS.agents.support)},
    ${sqlLiteral(operatorId)},
    'Support Inbox Agent',
    'warning',
    'docker',
    'worker-01',
    'host.docker.internal',
    'nora-support-inbox',
    ${sqlLiteral(AGENT_IMAGE)},
    2,
    4096,
    40,
    NOW() - INTERVAL '49 minutes',
    'standard',
    18790
  ),
  (
    ${sqlLiteral(IDS.agents.queued)},
    ${sqlLiteral(operatorId)},
    'Spec Writer Queue',
    'queued',
    'docker',
    'worker-02',
    NULL,
    'nora-spec-writer',
    ${sqlLiteral(AGENT_IMAGE)},
    2,
    2048,
    20,
    NOW() - INTERVAL '8 minutes',
    'standard',
    NULL
  ),
  (
    ${sqlLiteral(IDS.agents.stopped)},
    ${sqlLiteral(operatorId)},
    'Retention Analyst',
    'stopped',
    'docker',
    'worker-03',
    NULL,
    'nora-retention-analyst',
    ${sqlLiteral(AGENT_IMAGE)},
    2,
    4096,
    50,
    NOW() - INTERVAL '3 hours',
    'standard',
    NULL
  );

INSERT INTO deployments (agent_id, status) VALUES
  (${sqlLiteral(IDS.agents.primary)}, 'running'),
  (${sqlLiteral(IDS.agents.support)}, 'warning'),
  (${sqlLiteral(IDS.agents.queued)}, 'queued'),
  (${sqlLiteral(IDS.agents.stopped)}, 'stopped');

INSERT INTO container_stats (
  agent_id,
  cpu_percent,
  memory_usage_mb,
  memory_limit_mb,
  memory_percent,
  network_rx_mb,
  network_tx_mb,
  disk_read_mb,
  disk_write_mb,
  pids,
  recorded_at
) VALUES
  (${sqlLiteral(IDS.agents.primary)}, 18.4, 3120, 8192, 38.1, 124.3, 38.8, 14.2, 5.4, 37, NOW() - INTERVAL '5 minutes'),
  (${sqlLiteral(IDS.agents.primary)}, 22.1, 3388, 8192, 41.4, 127.5, 41.0, 14.5, 6.1, 39, NOW() - INTERVAL '3 minutes'),
  (${sqlLiteral(IDS.agents.primary)}, 16.8, 3296, 8192, 40.2, 130.0, 43.4, 14.7, 6.4, 40, NOW() - INTERVAL '1 minute');

${snapshots
  .map(
    (snapshot) => `INSERT INTO snapshots (
  id,
  agent_id,
  name,
  description,
  kind,
  template_key,
  built_in,
  config,
  created_at
) VALUES (
  ${sqlLiteral(snapshot.id)},
  ${snapshot.agentId ? sqlLiteral(snapshot.agentId) : "NULL"},
  ${sqlLiteral(snapshot.name)},
  ${sqlLiteral(snapshot.description)},
  ${sqlLiteral(snapshot.kind)},
  ${sqlLiteral(snapshot.templateKey)},
  ${snapshot.builtIn ? "TRUE" : "FALSE"},
  ${sqlJson(snapshot.config)},
  ${snapshot.createdAtSql}
);`
  )
  .join("\n\n")}

${templates
  .map(
    (template) => `INSERT INTO marketplace_listings (
  id,
  snapshot_id,
  owner_user_id,
  name,
  description,
  price,
  category,
  installs,
  downloads,
  built_in,
  source_type,
  status,
  visibility,
  slug,
  current_version,
  published_at,
  updated_at,
  reviewed_at,
  reviewed_by,
  review_notes,
  created_at
) VALUES (
  ${sqlLiteral(template.listingId)},
  ${sqlLiteral(template.snapshotId)},
  ${template.ownerUserId ? sqlLiteral(template.ownerUserId) : "NULL"},
  ${sqlLiteral(template.listingName)},
  ${sqlLiteral(template.listingDescription)},
  'Free',
  ${sqlLiteral(template.category)},
  ${template.installs},
  ${template.downloads},
  ${template.builtIn ? "TRUE" : "FALSE"},
  ${sqlLiteral(template.sourceType)},
  ${sqlLiteral(template.status)},
  'public',
  ${sqlLiteral(template.slug)},
  ${template.currentVersion},
  ${template.publishedAtSql},
  ${template.updatedAtSql},
  ${
    template.status === "published"
      ? template.updatedAtSql
      : "NULL"
  },
  ${template.reviewedBy ? sqlLiteral(template.reviewedBy) : "NULL"},
  ${sqlLiteral(template.reviewNotes)},
  ${template.createdAtSql}
);`
  )
  .join("\n\n")}

${templates
  .map(
    (template) => `INSERT INTO marketplace_listing_versions (
  listing_id,
  snapshot_id,
  version_number,
  clone_mode,
  created_at
) VALUES (
  ${sqlLiteral(template.listingId)},
  ${sqlLiteral(template.snapshotId)},
  ${template.currentVersion},
  'files_only',
  ${template.updatedAtSql}
);`
  )
  .join("\n\n")}

INSERT INTO marketplace_reports (
  id,
  listing_id,
  reporter_user_id,
  reason,
  details,
  status,
  created_at
) VALUES (
  ${sqlLiteral(IDS.reports.communityOpen)},
  ${sqlLiteral(IDS.listings.communityPublished)},
  ${sqlLiteral(operatorId)},
  'misleading',
  'The listing copy promises automated CRM handoff, but the current template still expects manual review.',
  'open',
  NOW() - INTERVAL '26 minutes'
);

${eventRows
  .map(
    (event) => `INSERT INTO events (
  id,
  type,
  message,
  metadata,
  created_at
) VALUES (
  ${sqlLiteral(event.id)},
  ${sqlLiteral(event.type)},
  ${sqlLiteral(event.message)},
  ${sqlJson(event.metadata)},
  ${event.createdAtSql}
);`
  )
  .join("\n\n")}
`;
}

function runSeedSql(sql) {
  if (!DB_CONTAINER || DB_CONTAINER.toLowerCase() === "none") return;

  const sqlFile = path.join(
    os.tmpdir(),
    `nora-readme-screenshots-${Date.now()}.sql`
  );
  fs.writeFileSync(sqlFile, sql);

  try {
    execSync(
      `docker cp ${shellQuote(sqlFile)} ${shellQuote(
        DB_CONTAINER
      )}:/tmp/nora-readme-screenshots.sql`,
      { stdio: "inherit" }
    );
    execSync(
      `docker exec ${shellQuote(
        DB_CONTAINER
      )} psql -U ${shellQuote(DB_USER)} -d ${shellQuote(
        DB_NAME
      )} -f /tmp/nora-readme-screenshots.sql`,
      { stdio: "inherit" }
    );
  } finally {
    try {
      fs.unlinkSync(sqlFile);
    } catch {
      // best effort cleanup only
    }
  }
}

async function newAuthedPage(browser, token) {
  const context = await browser.newContext({
    viewport: { width: 1512, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    ignoreHTTPSErrors: ALLOW_LOCAL_HTTPS_ERRORS,
  });

  await context.addInitScript((storedToken) => {
    window.localStorage.setItem("token", storedToken);
  }, token);

  const page = await context.newPage();
  return { context, page };
}

async function gotoHeading(page, pathname, headingText) {
  await page.goto(`${BASE_URL}${pathname}`, { waitUntil: "networkidle" });
  await page
    .getByRole("heading", { name: headingText, exact: true })
    .waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(700);
}

async function captureHermesReadmeScreenshot(browser, token) {
  const useRealHermes = Boolean(REAL_HERMES_AGENT_ID);
  const hermesAgentId = useRealHermes ? REAL_HERMES_AGENT_ID : IDS.agents.hermes;
  const hermesToken = useRealHermes && REAL_HERMES_TOKEN ? REAL_HERMES_TOKEN : token;
  const hermes = await newAuthedPage(browser, hermesToken);

  if (!useRealHermes) {
    await hermes.context.route(
      `**/api/agents/${hermesAgentId}/hermes-ui/embed*`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: buildHermesReadmeDashboardHtml(),
        });
      }
    );

    await hermes.context.route(
      `**/api/agents/${hermesAgentId}/hermes-ui`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(HERMES_README_RUNTIME),
        });
      }
    );

    await hermes.context.route(`**/api/agents/${hermesAgentId}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(HERMES_README_AGENT),
      });
    });
  }

  try {
    if (useRealHermes) {
      await hermes.page.goto(`${BASE_URL}/app/agents/${hermesAgentId}`, {
        waitUntil: "networkidle",
      });
      await hermes.page
        .getByRole("button", { name: "Hermes WebUI" })
        .first()
        .waitFor({ state: "visible", timeout: 15000 });
      await hermes.page.waitForTimeout(700);
    } else {
      await gotoHeading(
        hermes.page,
        `/app/agents/${hermesAgentId}`,
        HERMES_README_AGENT.name
      );
    }

    await hermes.page.getByRole("button", { name: "Hermes WebUI" }).first().click();
    await hermes.page
      .getByRole("button", { name: "Official Dashboard" })
      .first()
      .click();
    const iframeSelector = `iframe[title="Hermes Dashboard ${hermesAgentId}"]`;
    const iframe = hermes.page.locator(iframeSelector);

    await iframe.waitFor({ state: "visible", timeout: 15000 });
    if (useRealHermes) {
      await hermes.page.waitForFunction(
        (selector) => {
          const frame = document.querySelector(selector);
          const doc = frame?.contentDocument;
          return Boolean(doc?.body && doc.body.innerText.trim().length > 80);
        },
        iframeSelector,
        { timeout: 20000 }
      );
    } else {
      await hermes.page
        .frameLocator(iframeSelector)
        .getByText("Official Hermes dashboard", { exact: true })
        .waitFor({
          state: "visible",
          timeout: 15000,
        });
    }
    await hermes.page.getByRole("button", { name: "New Window" }).waitFor({
      state: "visible",
      timeout: 15000,
    });
    await hermes.page.waitForTimeout(700);
    const mainContent = hermes.page.locator("main");
    await mainContent.waitFor({ state: "visible", timeout: 15000 });
    const mainBox = await mainContent.boundingBox();
    if (!mainBox) {
      throw new Error("Failed to locate main content area for Hermes README screenshot");
    }
    await hermes.page.screenshot({
      path: path.join(SCREENSHOT_DIR, "proof-operator-hermes-webui-tab.png"),
      clip: {
        x: Math.round(mainBox.x),
        y: Math.round(mainBox.y),
        width: Math.min(1256, Math.round(mainBox.width)),
        height: Math.min(1000, Math.round(mainBox.height)),
      },
    });
  } finally {
    await hermes.context.close();
  }
}

async function captureScreens() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const operatorSeed = await ensureAccount(ACCOUNTS.operator);
  const adminSeed = await ensureAccount(ACCOUNTS.admin);
  const communitySeed = await ensureAccount(ACCOUNTS.community);

  runSeedSql(
    buildSeedSql({
      operatorUser: operatorSeed.user,
      adminUser: adminSeed.user,
      communityUser: communitySeed.user,
    })
  );

  const operatorAuth = await ensureAccount(ACCOUNTS.operator);
  const adminAuth = await ensureAccount(ACCOUNTS.admin);

  await ensureProviders(operatorAuth.token);

  const browser = await chromium.launch({ headless: true });
  const operator = await newAuthedPage(browser, operatorAuth.token);
  const admin = await newAuthedPage(browser, adminAuth.token);

  try {
    await gotoHeading(operator.page, "/app/dashboard", "System Overview");
    await operator.page.screenshot({
      path: path.join(SCREENSHOT_DIR, "proof-operator-dashboard.png"),
    });

    await gotoHeading(operator.page, "/app/agents", "Fleet Management");
    await operator.page.screenshot({
      path: path.join(SCREENSHOT_DIR, "proof-operator-fleet.png"),
    });

    await gotoHeading(operator.page, "/app/deploy", "Deploy New Agent");
    const deployInputs = operator.page.locator("input");
    await deployInputs.nth(0).fill("customer-success-operator");
    await deployInputs.nth(1).fill("nora-customer-success-operator");
    await operator.page.waitForTimeout(250);
    await operator.page.screenshot({
      path: path.join(SCREENSHOT_DIR, "proof-operator-deploy-flow.png"),
    });

    await gotoHeading(
      operator.page,
      `/app/agents/${IDS.agents.primary}`,
      "OpenClaw Research Operator"
    );
    await operator.page.getByText("OpenClaw Gateway Active").waitFor({
      state: "visible",
      timeout: 15000,
    });
    await operator.page.screenshot({
      path: path.join(SCREENSHOT_DIR, "proof-operator-agent-detail.png"),
    });

    await captureHermesReadmeScreenshot(browser, operatorAuth.token);

    await gotoHeading(operator.page, "/app/settings", "Settings");
    const providerSection = operator.page
      .locator("section")
      .filter({ hasText: "LLM Provider Keys" })
      .first();
    await providerSection.scrollIntoViewIfNeeded();
    await operator.page.waitForTimeout(250);
    await providerSection.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        "proof-operator-settings-provider-setup.png"
      ),
    });

    await gotoHeading(operator.page, "/app/marketplace", "Install presets, browse community templates, and track your own shared agents.");
    await operator.page.waitForTimeout(250);
    await operator.page.screenshot({
      path: path.join(SCREENSHOT_DIR, "proof-operator-marketplace.png"),
    });

    await gotoHeading(
      operator.page,
      `/app/marketplace/${IDS.listings.presetSignalDesk}`,
      "Signal Desk Starter"
    );
    await operator.page
      .getByRole("heading", {
        name: "OpenClaw core files included",
        exact: true,
      })
      .scrollIntoViewIfNeeded();
    await operator.page.waitForTimeout(250);
    await operator.page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        "proof-operator-marketplace-detail.png"
      ),
    });

    await gotoHeading(operator.page, "/app/logs", "Account event log");
    await operator.page.waitForTimeout(500);
    await operator.page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        "proof-operator-account-event-log.png"
      ),
    });

    await gotoHeading(admin.page, "/admin/marketplace", "Marketplace moderation");
    await admin.page.waitForTimeout(250);
    await admin.page.screenshot({
      path: path.join(SCREENSHOT_DIR, "proof-admin-marketplace.png"),
    });

    await gotoHeading(
      admin.page,
      `/admin/marketplace/${IDS.listings.communityPending}`,
      "Founder Inbox Curator"
    );
    await admin.page
      .getByRole("heading", {
        name: "Core files and extras",
        exact: true,
      })
      .scrollIntoViewIfNeeded();
    await admin.page.waitForTimeout(250);
    await admin.page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        "proof-admin-marketplace-detail.png"
      ),
    });
  } finally {
    await operator.context.close();
    await admin.context.close();
    await browser.close();
  }

  console.log(`Saved README screenshots to ${SCREENSHOT_DIR}`);
}

captureScreens().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
