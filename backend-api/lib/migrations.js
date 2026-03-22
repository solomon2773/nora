// migrations.js
// Handles reading and applying SQL migrations from the migrations/ directory.
// Tracking is handled by the _migrations table in PostgreSQL.

const fs = require('fs');
const path = require('path');
const db = require('../db');

const MIGRATIONS_DIR = path.join(__dirname, '../migrations');

/**
 * Run all pending migrations in alphabetical order.
 * Idempotent: Skips migrations already found in the _migrations table.
 */
async function runMigrations() {
  console.log('[migrations] Checking for pending schema updates...');

  // 1. Ensure the tracking table exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // 2. Read all .sql files in the migrations directory
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.warn(`[migrations] Directory not found: ${MIGRATIONS_DIR}`);
    return;
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort(); // Apply in alphabetical order

  if (files.length === 0) {
    console.log('[migrations] No migration files found.');
    return;
  }

  // 3. Apply pending migrations
  let appliedCount = 0;
  for (const file of files) {
    const { rows } = await db.query('SELECT filename FROM _migrations WHERE filename = $1', [file]);
    
    if (rows.length === 0) {
      console.log(`[migrations] Applying: ${file}...`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      
      try {
        // Run as a single transaction (transaction wrap is implicit in most psql drivers for multiple statements, 
        // but explicit BEGIN/COMMIT is safer for multi-statement files).
        await db.query(`BEGIN; ${sql}; COMMIT;`);
        await db.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
        appliedCount++;
      } catch (e) {
        console.error(`[migrations] FAILED applying ${file}:`, e.message);
        // If one fails, we stop to prevent partial/corrupt state
        throw new Error(`Migration failure at ${file}: ${e.message}`);
      }
    }
  }

  if (appliedCount > 0) {
    console.log(`[migrations] Successfully applied ${appliedCount} migration(s).`);
  } else {
    console.log('[migrations] DB is up to date.');
  }
}

module.exports = { runMigrations };
