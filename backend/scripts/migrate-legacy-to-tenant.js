"use strict";

const { getDb } = require("../src/firebase");
const { runLegacyMigration } = require("../src/legacyMigration");

function parseArguments(args) {
  const options = { execute: false };
  for (const argument of args) {
    if (argument === "--execute") options.execute = true;
    else if (argument.startsWith("--organization=")) options.organizationId = argument.slice("--organization=".length);
    else if (argument.startsWith("--owner=")) options.ownerUid = argument.slice("--owner=".length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options.organizationId || !options.ownerUid) {
    throw new Error("Usage: node backend/scripts/migrate-legacy-to-tenant.js --organization=ORG_ID --owner=FIREBASE_UID [--execute]");
  }
  const result = await runLegacyMigration(getDb(), options);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (require.main === module) {
  main().catch(error => {
    console.error("Legacy migration failed:", error.message || error);
    process.exitCode = 1;
  });
}

module.exports = { parseArguments, main };
