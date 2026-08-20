import { accessSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const PLATFORMS: Record<string, string> = {
  "darwin-arm64": "@aaif/goose-binary-darwin-arm64",
  "darwin-x64": "@aaif/goose-binary-darwin-x64",
  "linux-arm64": "@aaif/goose-binary-linux-arm64",
  "linux-x64": "@aaif/goose-binary-linux-x64",
  "win32-x64": "@aaif/goose-binary-win32-x64",
};

/**
 * Resolves the path to the OpenDuck (legacy: goose) binary.
 *
 * Resolution order:
 *   1. `OPENDUCK_BINARY` or `GOOSE_BINARY` environment variable
 *   2. Platform-specific `@aaif/goose-binary-*` optional dependency
 *      (`openduck` first, then the `goose` alias)
 *
 * @throws if no binary can be found
 */
export function resolveGooseBinary(): string {
  return resolveOpenDuckBinary();
}

export function resolveOpenDuckBinary(): string {
  const envBinary = process.env.OPENDUCK_BINARY ?? process.env.GOOSE_BINARY;
  if (envBinary) return envBinary;

  const key = `${process.platform}-${process.arch}`;
  const pkg = PLATFORMS[key];
  if (!pkg) {
    throw new Error(
      `No OpenDuck binary available for ${key}. Set OPENDUCK_BINARY (or GOOSE_BINARY) to the path of an openduck binary.`,
    );
  }

  try {
    const require = createRequire(import.meta.url);
    const pkgDir = dirname(require.resolve(`${pkg}/package.json`));
    const binNames =
      process.platform === "win32"
        ? ["openduck.exe", "goose.exe"]
        : ["openduck", "goose"];
    for (const binName of binNames) {
      const candidate = join(pkgDir, "bin", binName);
      try {
        accessSync(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    throw new Error("binary file missing");
  } catch {
    throw new Error(
      `openduck binary package ${pkg} is not installed. Set OPENDUCK_BINARY or install the native package.`,
    );
  }
}
