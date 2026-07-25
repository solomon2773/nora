// Pure data-access layer for the integrations module.
// Every db.query previously inlined into integrations.ts lives here.
// The repository talks SQL only — no encryption, no catalog parsing,
// no provider business logic. Callers pass pre-encrypted blobs and
// receive raw rows; transformation happens in services/.

import type { IntegrationCatalogRow, IntegrationRow } from "../types/integration";

type DbLike = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export interface IntegrationsRepository {
  upsertCatalogItem(item: {
    id: string;
    name: string;
    icon?: string | null;
    category?: string | null;
    description?: string | null;
    authType?: string | null;
    rawJson: string;
  }): Promise<void>;
  getCatalogByCategory(category?: string | null): Promise<IntegrationCatalogRow[]>;
  getCatalogItemById(catalogId: string): Promise<IntegrationCatalogRow | null>;
  insertIntegration(input: {
    agentId: string;
    provider: string;
    catalogId: string;
    encryptedToken: string | null;
    encryptedConfigJson: string;
  }): Promise<IntegrationRow | null>;
  deleteSiblingIntegrations(input: {
    agentId: string;
    provider: string;
    excludeId: string;
  }): Promise<void>;
  listForAgent(agentId: string): Promise<IntegrationRow[]>;
  listActiveForAgent(agentId: string): Promise<IntegrationRow[]>;
  listActiveEnvSourcesForAgent(agentId: string): Promise<IntegrationRow[]>;
  deleteIntegration(input: {
    integrationId: string;
    agentId: string;
  }): Promise<{ id: string; provider: string; cron_job_id?: string | null } | null>;
  findIntegration(input: {
    integrationId: string;
    agentId: string;
  }): Promise<IntegrationRow | null>;
  updateIntegration(input: {
    id: string;
    agentId: string;
    encryptedToken: string | null;
    encryptedConfigJson: string;
  }): Promise<IntegrationRow | null>;
  updateAccessTokenAndConfig(input: {
    id: string;
    encryptedToken: string;
    encryptedConfigJson: string;
  }): Promise<void>;
  updateStatus(input: { id: string; status: string }): Promise<void>;
  updateCronJobId(input: { id: string; agentId: string; cronJobId: string | null }): Promise<void>;
  findActiveEmailIntegrations(agentId: string): Promise<IntegrationRow[]>;
  findActiveIntegrationByCronJobId(input: {
    agentId: string;
    cronJobId: string;
  }): Promise<IntegrationRow | null>;
}

/**
 * Create the SQL-only integration repository used beneath encryption and provider services.
 *
 * Callers must pass already-encrypted credential values; returned rows remain untransformed.
 *
 * @param {Object} db - Database client exposing `query`.
 * @returns {Object} Raw integration persistence operations.
 */
export function createIntegrationsRepository(db: DbLike): IntegrationsRepository {
  return {
    async upsertCatalogItem(item) {
      await db.query(
        `INSERT INTO integration_catalog(id, name, icon, category, description, auth_type, config_schema, enabled)
         VALUES($1, $2, $3, $4, $5, $6, $7, true)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           icon = EXCLUDED.icon,
           category = EXCLUDED.category,
           description = EXCLUDED.description,
           auth_type = EXCLUDED.auth_type,
           config_schema = EXCLUDED.config_schema`,
        [
          item.id,
          item.name,
          item.icon,
          item.category,
          item.description,
          item.authType,
          item.rawJson,
        ],
      );
    },

    async getCatalogByCategory(category) {
      let sql = "SELECT * FROM integration_catalog WHERE enabled = true";
      const params: unknown[] = [];
      if (category) {
        sql += " AND category = $1";
        params.push(category);
      }
      sql += " ORDER BY category, name";
      const result = await db.query(sql, params);
      return result.rows;
    },

    async getCatalogItemById(catalogId) {
      const result = await db.query("SELECT * FROM integration_catalog WHERE id = $1", [catalogId]);
      return result.rows[0] ?? null;
    },

    async insertIntegration({ agentId, provider, catalogId, encryptedToken, encryptedConfigJson }) {
      const result = await db.query(
        "INSERT INTO integrations(agent_id, provider, catalog_id, access_token, config) VALUES($1, $2, $3, $4, $5) RETURNING *",
        [agentId, provider, catalogId, encryptedToken, encryptedConfigJson],
      );
      return result.rows[0] ?? null;
    },

    async deleteSiblingIntegrations({ agentId, provider, excludeId }) {
      await db.query(
        "DELETE FROM integrations WHERE agent_id = $1 AND provider = $2 AND id <> $3",
        [agentId, provider, excludeId],
      );
    },

    async listForAgent(agentId) {
      const result = await db.query(
        `SELECT i.id, i.agent_id, i.provider, i.catalog_id, i.config, i.status, i.cron_job_id,
                i.mailbox_state, i.created_at,
                ic.name as catalog_name, ic.icon as catalog_icon, ic.category as catalog_category,
                ic.description as catalog_description, ic.auth_type, ic.config_schema
         FROM integrations i
         LEFT JOIN integration_catalog ic ON i.catalog_id = ic.id
         WHERE i.agent_id = $1
         ORDER BY i.created_at DESC`,
        [agentId],
      );
      return result.rows;
    },

    async listActiveForAgent(agentId) {
      const result = await db.query(
        `SELECT i.id, i.provider, i.catalog_id, i.config, i.status, i.cron_job_id,
                i.mailbox_state, i.created_at,
                ic.name as catalog_name, ic.category as catalog_category,
                ic.auth_type, ic.config_schema
         FROM integrations i
         LEFT JOIN integration_catalog ic ON i.catalog_id = ic.id
         WHERE i.agent_id = $1 AND i.status = 'active'`,
        [agentId],
      );
      return result.rows;
    },

    async listActiveEnvSourcesForAgent(agentId) {
      const result = await db.query(
        "SELECT id, provider, catalog_id, access_token, config FROM integrations WHERE agent_id = $1 AND status = 'active'",
        [agentId],
      );
      return result.rows;
    },

    async deleteIntegration({ integrationId, agentId }) {
      const result = await db.query(
        "DELETE FROM integrations WHERE id = $1 AND agent_id = $2 RETURNING id, provider, cron_job_id",
        [integrationId, agentId],
      );
      return result.rows[0] ?? null;
    },

    async findIntegration({ integrationId, agentId }) {
      const result = await db.query("SELECT * FROM integrations WHERE id = $1 AND agent_id = $2", [
        integrationId,
        agentId,
      ]);
      return result.rows[0] ?? null;
    },

    async updateAccessTokenAndConfig({ id, encryptedToken, encryptedConfigJson }) {
      await db.query("UPDATE integrations SET access_token = $1, config = $2 WHERE id = $3", [
        encryptedToken,
        encryptedConfigJson,
        id,
      ]);
    },

    async updateStatus({ id, status }) {
      await db.query("UPDATE integrations SET status = $1 WHERE id = $2", [status, id]);
    },

    async updateIntegration({ id, agentId, encryptedToken, encryptedConfigJson }) {
      const result = await db.query(
        `UPDATE integrations
            SET access_token = $1,
                config = $2
          WHERE id = $3 AND agent_id = $4
        RETURNING *`,
        [encryptedToken, encryptedConfigJson, id, agentId],
      );
      return result.rows[0] ?? null;
    },

    async updateCronJobId({ id, agentId, cronJobId }) {
      await db.query("UPDATE integrations SET cron_job_id = $1 WHERE id = $2 AND agent_id = $3", [
        cronJobId,
        id,
        agentId,
      ]);
    },

    async findActiveEmailIntegrations(agentId) {
      const result = await db.query(
        "SELECT id, agent_id, provider, config, cron_job_id, status FROM integrations WHERE agent_id = $1 AND provider = 'email' AND status = 'active'",
        [agentId],
      );
      return result.rows;
    },

    async findActiveIntegrationByCronJobId({ agentId, cronJobId }) {
      const result = await db.query(
        `SELECT id, agent_id, provider, catalog_id, status, cron_job_id
           FROM integrations
          WHERE agent_id = $1 AND cron_job_id = $2 AND status = 'active'
          LIMIT 1`,
        [agentId, cronJobId],
      );
      return result.rows[0] ?? null;
    },
  };
}
