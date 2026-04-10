// agent snapshot registry backed by PostgreSQL

const db = require("./db");

function stringifyConfig(config = {}) {
  return typeof config === "string" ? config : JSON.stringify(config || {});
}

function normalizeSnapshotOptions(options = {}) {
  return {
    kind:
      typeof options.kind === "string" && options.kind.trim()
        ? options.kind.trim()
        : "snapshot",
    templateKey:
      typeof options.templateKey === "string" && options.templateKey.trim()
        ? options.templateKey.trim()
        : null,
    builtIn: options.builtIn === true,
  };
}

async function createSnapshot(
  agentId,
  name,
  description,
  config = {},
  options = {}
) {
  const normalized = normalizeSnapshotOptions(options);
  const result = await db.query(
    `INSERT INTO snapshots(agent_id, name, description, config, kind, template_key, built_in)
     VALUES($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      agentId,
      name,
      description,
      stringifyConfig(config),
      normalized.kind,
      normalized.templateKey,
      normalized.builtIn,
    ]
  );
  return result.rows[0];
}

async function listSnapshots() {
  const result = await db.query("SELECT * FROM snapshots ORDER BY created_at DESC");
  return result.rows;
}

async function getSnapshot(id) {
  const result = await db.query("SELECT * FROM snapshots WHERE id = $1", [id]);
  return result.rows[0];
}

async function getSnapshotByTemplateKey(templateKey) {
  if (!templateKey) return null;
  const result = await db.query(
    "SELECT * FROM snapshots WHERE template_key = $1 ORDER BY created_at ASC LIMIT 1",
    [templateKey]
  );
  return result.rows[0] || null;
}

async function upsertSnapshot({
  agentId = null,
  name,
  description,
  config = {},
  kind = "snapshot",
  templateKey = null,
  builtIn = false,
} = {}) {
  const normalized = normalizeSnapshotOptions({ kind, templateKey, builtIn });
  if (normalized.templateKey) {
    const existing = await getSnapshotByTemplateKey(normalized.templateKey);
    if (existing) {
      const result = await db.query(
        `UPDATE snapshots
            SET agent_id = $1,
                name = $2,
                description = $3,
                config = $4,
                kind = $5,
                built_in = $6
          WHERE id = $7
        RETURNING *`,
        [
          agentId,
          name,
          description,
          stringifyConfig(config),
          normalized.kind,
          normalized.builtIn,
          existing.id,
        ]
      );
      return result.rows[0];
    }
  }

  return createSnapshot(agentId, name, description, config, normalized);
}

async function updateSnapshot(
  id,
  {
    agentId,
    name,
    description,
    config,
    kind,
    templateKey,
    builtIn,
  } = {}
) {
  const existing = await getSnapshot(id);
  if (!existing) return null;

  const normalized = normalizeSnapshotOptions({
    kind: kind ?? existing.kind,
    templateKey:
      templateKey !== undefined ? templateKey : existing.template_key,
    builtIn: builtIn ?? existing.built_in,
  });

  const result = await db.query(
    `UPDATE snapshots
        SET agent_id = $1,
            name = $2,
            description = $3,
            config = $4,
            kind = $5,
            template_key = $6,
            built_in = $7
      WHERE id = $8
      RETURNING *`,
    [
      agentId !== undefined ? agentId : existing.agent_id,
      name !== undefined ? name : existing.name,
      description !== undefined ? description : existing.description,
      config !== undefined ? stringifyConfig(config) : stringifyConfig(existing.config),
      normalized.kind,
      normalized.templateKey,
      normalized.builtIn,
      id,
    ]
  );

  return result.rows[0] || null;
}

module.exports = {
  createSnapshot,
  getSnapshot,
  getSnapshotByTemplateKey,
  listSnapshots,
  updateSnapshot,
  upsertSnapshot,
};
