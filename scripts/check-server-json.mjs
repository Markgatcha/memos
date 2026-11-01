#!/usr/bin/env node
/**
 * Validate server.json against the registry's structural rules we depend on,
 * without a network call: name format, version parity with package.json,
 * npm identifier, stdio transport, description length, env var shape.
 *
 * Schema URL:
 * https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const server = JSON.parse(readFileSync(resolve(root, "server.json"), "utf8"));
const errors = [];

if (!/^[a-z0-9.-]+\/[a-z0-9.-]+$/.test(server.name ?? "")) {
  errors.push("name must be reverse-DNS namespace/server");
}
if (typeof server.description !== "string" || server.description.length > 100) {
  errors.push("description must be a string of at most 100 characters");
}
if (server.version !== pkg.version) {
  errors.push(`version ${server.version} != package.json ${pkg.version}`);
}
if (!Array.isArray(server.packages) || server.packages.length === 0) {
  errors.push("packages must be a non-empty array");
}
for (const [index, entry] of (server.packages ?? []).entries()) {
  if (entry.registryType !== "npm") {
    errors.push(`packages[${index}].registryType must be npm`);
  }
  if (entry.identifier !== pkg.name) {
    errors.push(
      `packages[${index}].identifier ${entry.identifier} != ${pkg.name}`,
    );
  }
  if (entry.version !== pkg.version) {
    errors.push(
      `packages[${index}].version ${entry.version} != ${pkg.version}`,
    );
  }
  if (entry.transport?.type !== "stdio") {
    errors.push(`packages[${index}].transport.type must be stdio`);
  }
  for (const variable of entry.environmentVariables ?? []) {
    if (typeof variable.name !== "string" || variable.name.length === 0) {
      errors.push(`packages[${index}] env var without a name`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`[check-server-json] ${error}`);
  process.exit(1);
}
console.log(
  `[check-server-json] OK: ${server.name} ${server.version}, npm ${pkg.name}, stdio`,
);
