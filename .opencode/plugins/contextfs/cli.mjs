#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { mergeConfig } from "./src/config.mjs";
import { ContextFsStorage } from "./src/storage.mjs";
import { runCtxCommand } from "./src/commands.mjs";
import { buildContextPack } from "./src/packer.mjs";
import { loadContextFsEnv } from "./src/env.mjs";

async function main() {
  await loadContextFsEnv();
  const args = process.argv.slice(2);
  const cwd = process.cwd();
  const config = mergeConfig();
  const storage = new ContextFsStorage(cwd, config);
  await storage.ensureInitialized();

  if (args[0] === "pack") {
    const pack = await buildContextPack(storage, config);
    process.stdout.write(pack.block + "\n");
    return;
  }

  const line = ["ctx", ...args].join(" ");
  const result = await runCtxCommand(line, storage, config);
  process.stdout.write((result.text || "") + "\n");
  process.exitCode = result.exitCode;
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err)}\n`);
  process.exitCode = 1;
});
