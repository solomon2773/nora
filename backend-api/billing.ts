// @ts-nocheck
const db = require("./db");
const { getBackupPlanLimits, getDeploymentDefaults } = require("./platformSettings");

// Conditionally load Stripe — if no key, functions gracefully degrade
const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? require("stripe")(stripeKey) : null;

const PLATFORM_MODE = (process.env.PLATFORM_MODE || "selfhosted").toLowerCase();
const IS_PAAS = PLATFORM_MODE === "paas";

const PLANS = {
  free: {
    agent_limit: 3,
    managed_backups_enabled: false,
    backup_limit_per_agent: 0,
    backup_storage_mb: 0,
    backup_retention_days: 0,
  },
  pro: {
    agent_limit: 10,
    managed_backups_enabled: true,
    backup_limit_per_agent: 5,
    backup_storage_mb: 5120,
    backup_retention_days: 30,
  },
  enterprise: {
    agent_limit: 100,
    managed_backups_enabled: true,
    backup_limit_per_agent: 30,
    backup_storage_mb: 102400,
    backup_retention_days: 180,
  },
};
const KNOWN_PLANS = new Set(Object.keys(PLANS));
const DEFAULT_USER_AGENT_LIMIT = 3;

const SELFHOSTED_LIMITS = {
  max_vcpu: parseInt(process.env.MAX_VCPU || "16", 10),
  max_ram_mb: parseInt(process.env.MAX_RAM_MB || "32768", 10),
  max_disk_gb: parseInt(process.env.MAX_DISK_GB || "500", 10),
  max_agents: parseInt(process.env.MAX_AGENTS || "50", 10),
  backup_limit_per_agent: parseInt(process.env.NORA_BACKUP_LIMIT_PER_AGENT || "10", 10),
  backup_storage_mb: parseInt(process.env.NORA_BACKUP_STORAGE_MB || "51200", 10),
  backup_retention_days: parseInt(process.env.NORA_BACKUP_RETENTION_DAYS || "30", 10),
};
const BILLING_ENABLED = process.env.BILLING_ENABLED === "true";

// Effective entitlement normalization

function parseInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePlanName(plan) {
  const normalized = String(plan || "")
    .trim()
    .toLowerCase();
  return KNOWN_PLANS.has(normalized) ? normalized : "free";
}

function normalizeAgentLimitOverride(value) {
  const parsed = parseInteger(value);
  if (parsed == null || parsed < 0) return null;
  return parsed;
}

function normalizeBackupLimitOverride(value) {
  const parsed = parseInteger(value);
  if (parsed == null || parsed < 0) return null;
  return parsed;
}

function normalizeNullableBoolean(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return null;
}

function isAdminUser(user = {}) {
  return (
    String(user?.role || "")
      .trim()
      .toLowerCase() === "admin"
  );
}

/**
 * Apply platform-role defaults and an optional administrator override to an
 * agent cap, limiting only an explicit override when a ceiling is supplied.
 *
 * @param {Object} base - Base subscription payload.
 * @param {Object} [user={}] - User role and limit override fields.
 * @param {Object} [options={}] - Optional maximum administrator override.
 * @returns {Object} Subscription with effective limit and provenance fields.
 */
function applyEffectiveAgentLimit(base, user = {}, options = {}) {
  const override = normalizeAgentLimitOverride(user?.agent_limit_override);
  const maxAgentLimit = Number.isInteger(options.maxAgentLimit) ? options.maxAgentLimit : null;
  const effectiveOverride =
    override == null ? null : maxAgentLimit == null ? override : Math.min(override, maxAgentLimit);
  const roleDefaultIsUnlimited = isAdminUser(user);
  const baseAgentLimit = roleDefaultIsUnlimited ? null : DEFAULT_USER_AGENT_LIMIT;

  if (effectiveOverride != null) {
    return {
      ...base,
      agent_limit: effectiveOverride,
      base_agent_limit: baseAgentLimit,
      agent_limit_override: effectiveOverride,
      agent_limit_source: "admin_override",
      is_unlimited: false,
    };
  }

  if (roleDefaultIsUnlimited) {
    return {
      ...base,
      agent_limit: null,
      base_agent_limit: null,
      agent_limit_override: null,
      agent_limit_source: "admin_default_unlimited",
      is_unlimited: true,
    };
  }

  return {
    ...base,
    agent_limit: DEFAULT_USER_AGENT_LIMIT,
    base_agent_limit: DEFAULT_USER_AGENT_LIMIT,
    agent_limit_override: null,
    agent_limit_source: "default",
    is_unlimited: false,
  };
}

/**
 * Merge plan backup entitlements with administrator overrides and admin
 * defaults for unlimited backup count and storage, preserving plan retention.
 *
 * @param {Object} base - Base plan entitlement payload.
 * @param {Object} [user={}] - User role and backup override fields.
 * @returns {Object} Effective backup entitlement and provenance fields.
 */
function applyBackupEntitlement(base, user = {}) {
  const enabledOverride = normalizeNullableBoolean(user?.managed_backups_enabled_override);
  const countOverride = normalizeBackupLimitOverride(user?.backup_limit_per_agent_override);
  const storageOverride = normalizeBackupLimitOverride(user?.backup_storage_mb_override);
  const retentionOverride = normalizeBackupLimitOverride(user?.backup_retention_days_override);
  const roleDefaultIsUnlimited = isAdminUser(user);

  let next = {
    ...base,
    managed_backups_enabled:
      base.managed_backups_enabled === true || String(base.plan || "") === "selfhosted",
    managed_backups_enabled_override: null,
    backup_limit_per_agent: roleDefaultIsUnlimited ? null : base.backup_limit_per_agent,
    backup_limit_per_agent_override: null,
    backup_storage_mb: roleDefaultIsUnlimited ? null : base.backup_storage_mb,
    backup_storage_mb_override: null,
    backup_retention_days: base.backup_retention_days,
    backup_retention_days_override: null,
    managed_backups_source: base.managed_backups_source || "plan",
    backup_limit_source: roleDefaultIsUnlimited
      ? "admin_default_unlimited"
      : base.backup_limit_source || "plan",
    backup_storage_source: roleDefaultIsUnlimited
      ? "admin_default_unlimited"
      : base.backup_storage_source || "plan",
    backup_retention_source: base.backup_retention_source || "plan",
    backup_is_unlimited: roleDefaultIsUnlimited,
  };

  if (enabledOverride !== null) {
    next.managed_backups_enabled = enabledOverride;
    next.managed_backups_enabled_override = enabledOverride;
    next.managed_backups_source = "admin_override";
  }

  if (countOverride != null) {
    next.backup_limit_per_agent = countOverride;
    next.backup_limit_per_agent_override = countOverride;
    next.backup_limit_source = "admin_override";
    next.backup_is_unlimited = false;
  }

  if (storageOverride != null) {
    next.backup_storage_mb = storageOverride;
    next.backup_storage_mb_override = storageOverride;
    next.backup_storage_source = "admin_override";
    next.backup_is_unlimited = false;
  }

  if (retentionOverride != null) {
    next.backup_retention_days = retentionOverride;
    next.backup_retention_days_override = retentionOverride;
    next.backup_retention_source = "admin_override";
  }

  if (!next.managed_backups_enabled) {
    next.backup_limit_per_agent = 0;
    next.backup_storage_mb = 0;
    next.backup_is_unlimited = false;
  }

  return next;
}

// Subscription resolution

function buildPlanSubscription(plan, defaults = {}, backupPlanLimits = null) {
  const normalizedPlan = normalizePlanName(plan);
  const basePlan = PLANS[normalizedPlan] || PLANS.free;
  const backupPlan = backupPlanLimits?.[normalizedPlan] || basePlan;
  return {
    plan: normalizedPlan,
    agent_limit: basePlan.agent_limit,
    vcpu: defaults.vcpu,
    ram_mb: defaults.ram_mb,
    disk_gb: defaults.disk_gb,
    managed_backups_enabled: backupPlan.managed_backups_enabled,
    backup_limit_per_agent: backupPlan.backup_limit_per_agent,
    backup_storage_mb: backupPlan.backup_storage_mb,
    backup_retention_days: backupPlan.backup_retention_days,
  };
}

async function getUserRow(userId) {
  const result = await db.query(
    `SELECT id,
            email,
            role,
            name,
            agent_limit_override,
            managed_backups_enabled_override,
            backup_limit_per_agent_override,
            backup_storage_mb_override,
            backup_retention_days_override
       FROM users
      WHERE id = $1`,
    [userId],
  );
  return result.rows[0] || null;
}

async function getLatestSubscription(userId) {
  const result = await db.query(
    "SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
    [userId],
  );
  return result.rows[0] || null;
}

function buildSelfHostedSubscription(user = {}) {
  const base = {
    plan: "selfhosted",
    status: "active",
    agent_limit: SELFHOSTED_LIMITS.max_agents,
    vcpu: SELFHOSTED_LIMITS.max_vcpu,
    ram_mb: SELFHOSTED_LIMITS.max_ram_mb,
    disk_gb: SELFHOSTED_LIMITS.max_disk_gb,
    managed_backups_enabled: true,
    backup_limit_per_agent: SELFHOSTED_LIMITS.backup_limit_per_agent,
    backup_storage_mb: SELFHOSTED_LIMITS.backup_storage_mb,
    backup_retention_days: SELFHOSTED_LIMITS.backup_retention_days,
  };

  return applyBackupEntitlement(
    applyEffectiveAgentLimit(base, user, {
      maxAgentLimit: SELFHOSTED_LIMITS.max_agents,
    }),
    user,
  );
}

function buildPaaSSubscription({
  user = {},
  subscriptionRow = null,
  deploymentDefaults = {},
  backupPlanLimits = null,
} = {}) {
  const basePlan = normalizePlanName(subscriptionRow?.plan);
  const billingDisabledBackupEntitlement = BILLING_ENABLED
    ? {}
    : {
        managed_backups_enabled: true,
        backup_limit_per_agent: SELFHOSTED_LIMITS.backup_limit_per_agent,
        backup_storage_mb: SELFHOSTED_LIMITS.backup_storage_mb,
        backup_retention_days: SELFHOSTED_LIMITS.backup_retention_days,
        managed_backups_source: "billing_disabled",
        backup_limit_source: "billing_disabled",
        backup_storage_source: "billing_disabled",
        backup_retention_source: "billing_disabled",
      };
  const base = {
    ...subscriptionRow,
    ...buildPlanSubscription(basePlan, deploymentDefaults, backupPlanLimits),
    ...billingDisabledBackupEntitlement,
    plan: basePlan,
    status: BILLING_ENABLED ? subscriptionRow?.status || "active" : "active",
  };

  return applyBackupEntitlement(applyEffectiveAgentLimit(base, user), user);
}

/**
 * Resolve a user's effective subscription across self-hosted or PaaS mode,
 * including platform defaults, billing state, and administrator overrides.
 *
 * @param {string} userId - User whose entitlement should be resolved.
 * @param {Object} [options={}] - Optional preloaded rows and platform settings.
 * @returns {Promise<Object>} Effective subscription and resource limits.
 */
async function getSubscription(userId, options = {}) {
  const hasUserRow = Object.prototype.hasOwnProperty.call(options, "userRow");
  const user = hasUserRow ? options.userRow : await getUserRow(userId);

  if (!IS_PAAS) {
    return buildSelfHostedSubscription(user || {});
  }

  const deploymentDefaults = options.deploymentDefaults || (await getDeploymentDefaults());
  const hasBackupPlanLimits = Object.prototype.hasOwnProperty.call(options, "backupPlanLimits");
  const backupPlanLimits = hasBackupPlanLimits
    ? options.backupPlanLimits
    : BILLING_ENABLED
      ? await getBackupPlanLimits()
      : null;
  const hasSubscriptionRow = Object.prototype.hasOwnProperty.call(options, "subscriptionRow");
  const subscriptionRow = hasSubscriptionRow
    ? options.subscriptionRow
    : await getLatestSubscription(userId);

  return buildPaaSSubscription({
    user: user || {},
    subscriptionRow,
    deploymentDefaults,
    backupPlanLimits,
  });
}

function buildLimitReachedError(count, subscription = {}) {
  const limit = Number.isInteger(subscription?.agent_limit) ? subscription.agent_limit : 0;
  return `Agent limit reached (${count}/${limit}). Contact your administrator.`;
}

// Capacity enforcement

/**
 * Check subscription activity and owned-agent count against the effective cap.
 *
 * @param {string} userId - User attempting to create an agent.
 * @returns {Promise<Object>} Allow/deny decision, remaining capacity, and subscription.
 */
async function enforceLimits(userId) {
  const sub = await getSubscription(userId);
  if (IS_PAAS && BILLING_ENABLED && sub.status !== "active") {
    return { allowed: false, error: "Subscription is not active", subscription: sub };
  }

  const agentCount = await db.query("SELECT COUNT(*) FROM agents WHERE user_id = $1", [userId]);
  const count = parseInt(agentCount.rows[0].count, 10);

  if (sub.is_unlimited) {
    return { allowed: true, remaining: Infinity, subscription: sub };
  }

  if (Number.isInteger(sub.agent_limit) && count >= sub.agent_limit) {
    return {
      allowed: false,
      error: buildLimitReachedError(count, sub),
      subscription: sub,
    };
  }

  return {
    allowed: true,
    remaining: Number.isInteger(sub.agent_limit) ? sub.agent_limit - count : Infinity,
    subscription: sub,
  };
}

/**
 * Measure aggregate active backup storage for a user and, when requested, the
 * active backup count for one agent.
 *
 * @param {string} userId - Backup owner.
 * @param {Object} [options={}] - Optional agent id for the per-agent count.
 * @returns {Promise<Object>} Aggregate bytes and per-agent backup count.
 */
async function getBackupUsage(userId, options = {}) {
  const statusScope = ["queued", "running", "ready", "ready_with_warnings"];
  const params = [userId, statusScope];
  let agentClause = "";
  if (options.agentId) {
    params.push(options.agentId);
    agentClause = `AND agent_id = $${params.length}`;
  }

  const [storageResult, countResult] = await Promise.all([
    db.query(
      `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS used_bytes
         FROM backups
        WHERE user_id = $1
          AND status = ANY($2)
          AND kind = 'agent'`,
      [userId, statusScope],
    ),
    db.query(
      `SELECT COUNT(*)::int AS count
         FROM backups
        WHERE user_id = $1
          AND status = ANY($2)
          AND kind = 'agent'
          ${agentClause}`,
      params,
    ),
  ]);

  return {
    backup_storage_used_bytes: Number(storageResult.rows[0]?.used_bytes || 0),
    backup_count_for_agent: Number(countResult.rows[0]?.count || 0),
  };
}

function buildBackupLimitReachedError(count, subscription = {}) {
  const limit = Number.isInteger(subscription?.backup_limit_per_agent)
    ? subscription.backup_limit_per_agent
    : 0;
  return `Backup limit reached (${count}/${limit}). Contact your administrator.`;
}

/**
 * Enforce subscription status, managed-backup entitlement, count, and
 * user-wide storage limits; count is agent-scoped only when an id is supplied.
 *
 * @param {string} userId - User attempting the backup.
 * @param {Object} [options={}] - Optional target agent id.
 * @returns {Promise<Object>} Allow/deny decision with entitlement and usage context.
 */
async function enforceBackupLimits(userId, options = {}) {
  const sub = await getSubscription(userId);
  if (IS_PAAS && BILLING_ENABLED && sub.status !== "active") {
    return { allowed: false, error: "Subscription is not active", subscription: sub };
  }

  if (!sub.managed_backups_enabled) {
    return {
      allowed: false,
      error: "Managed backups are not available on your current plan.",
      subscription: sub,
    };
  }

  const usage = await getBackupUsage(userId, options);
  if (
    Number.isInteger(sub.backup_limit_per_agent) &&
    usage.backup_count_for_agent >= sub.backup_limit_per_agent
  ) {
    return {
      allowed: false,
      error: buildBackupLimitReachedError(usage.backup_count_for_agent, sub),
      subscription: sub,
      usage,
    };
  }

  const storageLimitBytes = Number.isInteger(sub.backup_storage_mb)
    ? sub.backup_storage_mb * 1024 * 1024
    : null;
  if (storageLimitBytes != null && usage.backup_storage_used_bytes >= storageLimitBytes) {
    return {
      allowed: false,
      error: "Backup storage limit reached. Delete old backups or contact your administrator.",
      subscription: sub,
      usage,
    };
  }

  return {
    allowed: true,
    subscription: sub,
    usage,
  };
}

// ── Create Stripe Checkout Session ──────────────────────────────

/**
 * Create or reuse a Stripe customer and start checkout, selecting the Pro
 * price only for `pro` and the Enterprise price for every other plan value.
 *
 * @param {string} userId - User starting checkout.
 * @param {string} plan - Paid plan identifier.
 * @returns {Promise<Object>} Checkout URL and session id.
 */
async function createCheckoutSession(userId, plan) {
  if (!stripe) throw new Error("Stripe is not configured");

  const priceId =
    plan === "pro" ? process.env.STRIPE_PRICE_PRO : process.env.STRIPE_PRICE_ENTERPRISE;

  if (!priceId) throw new Error(`No Stripe price configured for plan: ${plan}`);

  // Get or create Stripe customer
  const user = (await db.query("SELECT * FROM users WHERE id = $1", [userId])).rows[0];
  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({ email: user.email, metadata: { userId } });
    customerId = customer.id;
    await db.query("UPDATE users SET stripe_customer_id = $1 WHERE id = $2", [customerId, userId]);
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.NEXTAUTH_URL || "http://localhost:8080"}/app/settings?billing=success`,
    cancel_url: `${process.env.NEXTAUTH_URL || "http://localhost:8080"}/pricing`,
    metadata: { userId, plan },
  });
  return { url: session.url, sessionId: session.id };
}

// ── Create Stripe Customer Portal session ────────────────────────

async function createPortalSession(userId) {
  if (!stripe) throw new Error("Stripe is not configured");
  const user = (await db.query("SELECT * FROM users WHERE id = $1", [userId])).rows[0];
  if (!user.stripe_customer_id) throw new Error("No Stripe customer found");

  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: `${process.env.NEXTAUTH_URL || "http://localhost:8080"}/app/settings`,
  });
  return { url: session.url };
}

// ── Handle Stripe Webhook Events ────────────────────────────────

/**
 * Apply a previously signature-verified Stripe lifecycle event to subscription state.
 *
 * @param {Object} event - Stripe webhook event verified by the HTTP boundary.
 * @returns {Promise<void>}
 */
async function handleWebhookEvent(event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const userId = session.metadata?.userId;
      const plan = session.metadata?.plan || "pro";
      const specs = buildPlanSubscription(plan, await getDeploymentDefaults());

      await db.query(
        `INSERT INTO subscriptions(user_id, stripe_customer_id, stripe_subscription_id, plan, status, agent_limit, vcpu, ram_mb, disk_gb, current_period_end)
         VALUES($1, $2, $3, $4, 'active', $5, $6, $7, $8, NOW() + INTERVAL '30 days')
         ON CONFLICT (stripe_subscription_id) DO UPDATE SET
           plan = EXCLUDED.plan, status = 'active', agent_limit = EXCLUDED.agent_limit,
           vcpu = EXCLUDED.vcpu, ram_mb = EXCLUDED.ram_mb, disk_gb = EXCLUDED.disk_gb,
           updated_at = NOW()`,
        [
          userId,
          session.customer,
          session.subscription,
          plan,
          specs.agent_limit,
          specs.vcpu,
          specs.ram_mb,
          specs.disk_gb,
        ],
      );
      break;
    }

    case "invoice.paid": {
      const invoice = event.data.object;
      await db.query(
        `UPDATE subscriptions SET status = 'active', current_period_end = NOW() + INTERVAL '30 days', updated_at = NOW()
         WHERE stripe_subscription_id = $1`,
        [invoice.subscription],
      );
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      await db.query(
        "UPDATE subscriptions SET status = 'past_due', updated_at = NOW() WHERE stripe_subscription_id = $1",
        [invoice.subscription],
      );
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      // Downgrade to free
      const freePlan = buildPlanSubscription("free", await getDeploymentDefaults());
      await db.query(
        `UPDATE subscriptions SET plan = 'free', status = 'canceled', agent_limit = $1, vcpu = $2, ram_mb = $3, disk_gb = $4, updated_at = NOW()
         WHERE stripe_subscription_id = $5`,
        [freePlan.agent_limit, freePlan.vcpu, freePlan.ram_mb, freePlan.disk_gb, sub.id],
      );
      break;
    }
  }
}

module.exports = {
  PLANS,
  BILLING_ENABLED,
  PLATFORM_MODE,
  IS_PAAS,
  SELFHOSTED_LIMITS,
  buildBackupLimitReachedError,
  normalizeAgentLimitOverride,
  normalizeBackupLimitOverride,
  normalizeNullableBoolean,
  getSubscription,
  getBackupUsage,
  enforceBackupLimits,
  enforceLimits,
  createCheckoutSession,
  createPortalSession,
  handleWebhookEvent,
};
