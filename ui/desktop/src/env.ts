export function getPrefixedEnv(suffix: string): string | undefined {
  return process.env[`OPENDUCK_${suffix}`] ?? process.env[`GOOSE_${suffix}`];
}

export function getPrefixedEnvFlag(suffix: string): boolean {
  const value = getPrefixedEnv(suffix);
  return value === 'true' || value === '1';
}

export function applyPrefixedEnv(
  env: Record<string, string | undefined>,
  suffix: string,
  value: string | undefined
): void {
  const openduckKey = `OPENDUCK_${suffix}`;
  const gooseKey = `GOOSE_${suffix}`;
  if (value === undefined) {
    delete env[openduckKey];
    delete env[gooseKey];
    return;
  }
  env[openduckKey] = value;
  env[gooseKey] = value;
}
