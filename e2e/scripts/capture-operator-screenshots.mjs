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
      )} psql -U platform -d platform -f /tmp/nora-readme-screenshots.sql`,
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
