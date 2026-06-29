import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

let loaded = false;

function parseEnvFile(filePath: string) {
  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadRootEnv(): void {
  if (loaded) {
    return;
  }
  loaded = true;
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) {
      try {
        parseEnvFile(candidate);
      } catch {
        // ignore read errors; fall back to whatever is in process.env
      }
      return;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) {
      return;
    }
    dir = parent;
  }
}

loadRootEnv();
