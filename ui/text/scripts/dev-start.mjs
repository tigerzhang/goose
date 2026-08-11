#!/usr/bin/env node

// Development entrypoint: ensures a goose binary is available, then launches the TUI
// Skips the cargo build if GOOSE_BINARY is already set or if --server is provided

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, "..");
const repoRoot = join(__dirname, "..", "..", "..");
const args = process.argv.slice(2);
const hasServerFlag = args.some(
  (arg) =>
    arg === "--server" ||
    arg === "-s" ||
    arg.startsWith("--server=") ||
    arg.startsWith("-s="),
);

function resolveTsx() {
  const binName = process.platform === "win32" ? "tsx.cmd" : "tsx";
  const localBin = join(packageRoot, "node_modules", ".bin", binName);
  if (existsSync(localBin)) return localBin;
  // Fall back to PATH (global install / pnpm exec)
  return "tsx";
}

if (!hasServerFlag && !process.env.GOOSE_BINARY) {
  const binName = process.platform === "win32" ? "goose.exe" : "goose";
  const binaryPath = join(repoRoot, "target", "debug", binName);

  console.log("Building goose (debug)…");
  execFileSync("cargo", ["build", "-p", "goose-cli"], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (!existsSync(binaryPath)) {
    console.error(`Build succeeded but binary not found at ${binaryPath}`);
    process.exit(1);
  }

  process.env.GOOSE_BINARY = binaryPath;
}

const tsx = resolveTsx();
const tuiEntry = join(packageRoot, "src", "tui.tsx");

try {
  execFileSync(tsx, [tuiEntry, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
} catch (err) {
  if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
    console.error(
      "tsx not found. Install TUI deps first:\n  cd ui/text && pnpm install --ignore-workspace --config.engine-strict=false",
    );
    process.exit(1);
  }
  // execFileSync throws on non-zero exit; preserve the child's status.
  const status =
    err && typeof err === "object" && "status" in err && typeof err.status === "number"
      ? err.status
      : 1;
  process.exit(status ?? 1);
}
