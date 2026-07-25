// Persistence for the integration_oauth_states table.
// Used today only by the Twitter OAuth flow in routes/integrations.ts;
// the table itself is provider-agnostic so future OAuth providers reuse it.

import type { OAuthStateRow } from "../types/integration";

type DbLike = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export interface OAuthStatesRepository {
  insert(row: {
    state: string;
    provider: string;
    userId: string;
    agentId: string;
    codeVerifier: string;
    clientId: string;
    encryptedClientSecret: string | null;
    configJson: string;
    redirectPath: string;
    expiresAt: Date;
  }): Promise<void>;
  /** Read a matching state with agent ownership metadata; deletion remains a separate operation. */
  consume(input: { state: string; provider: string }): Promise<OAuthStateRow | null>;
  delete(state: string): Promise<void>;
}

/**
 * Create persistence operations for short-lived provider-agnostic OAuth state.
 *
 * @param {Object} db - Database client exposing `query`.
 * @returns {Object} OAuth state persistence operations.
 */
export function createOAuthStatesRepository(db: DbLike): OAuthStatesRepository {
  return {
    async insert(row) {
      await db.query(
        `INSERT INTO integration_oauth_states(
           state, provider, user_id, agent_id, code_verifier, client_id,
           client_secret, config, redirect_path, expires_at
         )
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          row.state,
          row.provider,
          row.userId,
          row.agentId,
          row.codeVerifier,
          row.clientId,
          row.encryptedClientSecret,
          row.configJson,
          row.redirectPath,
          row.expiresAt,
        ],
      );
    },

    async consume({ state, provider }) {
      const result = await db.query(
        `SELECT s.state, s.provider, s.user_id, s.agent_id, s.code_verifier,
                s.client_id, s.client_secret, s.config, s.redirect_path,
                s.expires_at, a.user_id AS agent_user_id
           FROM integration_oauth_states s
           JOIN agents a ON a.id = s.agent_id
          WHERE s.state = $1 AND s.provider = $2`,
        [state, provider],
      );
      return result.rows[0] ?? null;
    },

    async delete(state) {
      await db.query("DELETE FROM integration_oauth_states WHERE state = $1", [state]);
    },
  };
}
