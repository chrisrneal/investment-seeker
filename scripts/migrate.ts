#!/usr/bin/env npx tsx
/**
 * Database migration runner.
 *
 * Reads .sql files from /migrations in order, tracks applied migrations
 * in a `_migrations` table, and runs any pending ones.
 *
 * Usage:
 *   npx tsx scripts/migrate.ts            # apply pending migrations
 *   npx tsx scripts/migrate.ts --status   # list migration status
 *
 * Requires DATABASE_URL in .env.local
 */

import dns from "dns";
import fs from "fs";
import path from "path";
import postgres from "postgres";

// Force IPv4 — many dev machines lack IPv6 connectivity to Supabase
dns.setDefaultResultOrder("ipv4first");

// ── Load .env.local ────────────────────────────────────────────────

const envPath = path.resolve(__dirname, "../.env.local");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set in .env.local");
  console.error("   Get it from: Supabase Dashboard → Settings → Database → Connection string (URI)");
  process.exit(1);
}

// ── Connect ────────────────────────────────────────────────────────

const sql = postgres(DATABASE_URL, { ssl: "require" });

const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");

async function ensureMigrationsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id serial PRIMARY KEY,
      name text NOT NULL UNIQUE,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

async function getApplied(): Promise<Set<string>> {
  const rows = await sql<{ name: string }[]>`SELECT name FROM _migrations ORDER BY id`;
  return new Set(rows.map((r) => r.name));
}

function getPendingFiles(applied: Set<string>): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`❌ No migrations directory at ${MIGRATIONS_DIR}`);
    process.exit(1);
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => !applied.has(f));
}

async function runMigration(filename: string) {
  const filePath = path.join(MIGRATIONS_DIR, filename);
  const sqlText = fs.readFileSync(filePath, "utf-8");
  await sql.begin(async (tx) => {
    await tx.unsafe(sqlText);
    await tx`INSERT INTO _migrations (name) VALUES (${filename})`;
  });
}

async function main() {
  const statusOnly = process.argv.includes("--status");

  await ensureMigrationsTable();
  const applied = await getApplied();

  if (statusOnly) {
    const allFiles = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    console.log("\nMigration Status:\n");
    for (const f of allFiles) {
      const status = applied.has(f) ? "✅ applied" : "⏳ pending";
      console.log(`  ${status}  ${f}`);
    }
    console.log();
    await sql.end();
    return;
  }

  const pending = getPendingFiles(applied);

  if (pending.length === 0) {
    console.log("✅ All migrations already applied.");
    await sql.end();
    return;
  }

  console.log(`\n🔄 Running ${pending.length} pending migration(s)...\n`);

  for (const filename of pending) {
    process.stdout.write(`  ▸ ${filename} ... `);
    try {
      await runMigration(filename);
      console.log("✅");
    } catch (err) {
      console.log("❌");
      console.error(`\nFailed on ${filename}:`);
      console.error(err instanceof Error ? err.message : err);
      await sql.end();
      process.exit(1);
    }
  }

  console.log("\n✅ All migrations applied.\n");
  await sql.end();
}

main();
