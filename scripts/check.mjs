import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of fs.readdirSync(path.join(root, "src")).filter(name => name.endsWith(".js"))) {
  const result = spawnSync(process.execPath, ["--check", path.join(root, "src", name)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
