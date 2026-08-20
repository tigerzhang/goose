export const APP_PROTOCOL_SCHEME = 'openduck';
export const LEGACY_PROTOCOL_SCHEME = 'goose';
export const APP_PROTOCOL_SCHEMES = [APP_PROTOCOL_SCHEME, LEGACY_PROTOCOL_SCHEME] as const;

export type AppProtocolScheme = (typeof APP_PROTOCOL_SCHEMES)[number];

export function isAppProtocolUrl(url: string | undefined | null): url is string {
  if (!url) {
    return false;
  }
  return APP_PROTOCOL_SCHEMES.some((scheme) => url.startsWith(`${scheme}://`));
}

export function appProtocolUrl(pathAndQuery: string): string {
  const trimmed = pathAndQuery.replace(/^\/+/, '');
  return `${APP_PROTOCOL_SCHEME}://${trimmed}`;
}

export function isRecipeConfigDeeplink(url: string): boolean {
  return /^(openduck|goose):\/\/recipe\?config=/.test(url.trim());
}

export function recipeConfigPayload(url: string): string {
  return url.trim().replace(/^(openduck|goose):\/\/recipe\?config=/, '');
}

export function isSessionNostrDeeplink(url: string): boolean {
  return /^(openduck|goose):\/\/sessions\/nostr/.test(url.trim());
}
