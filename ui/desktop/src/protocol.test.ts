import { describe, expect, it } from 'vitest';
import {
  appProtocolUrl,
  isAppProtocolUrl,
  isRecipeConfigDeeplink,
  isSessionNostrDeeplink,
  recipeConfigPayload,
} from './protocol';

describe('app protocol helpers', () => {
  it('accepts openduck:// and goose:// URLs', () => {
    expect(isAppProtocolUrl('openduck://recipe?config=abc')).toBe(true);
    expect(isAppProtocolUrl('goose://extension?cmd=npx')).toBe(true);
    expect(isAppProtocolUrl('https://example.com')).toBe(false);
  });

  it('generates openduck:// deeplinks', () => {
    expect(appProtocolUrl('recipe?config=abc')).toBe('openduck://recipe?config=abc');
    expect(appProtocolUrl('/sessions/nostr?nevent=1')).toBe('openduck://sessions/nostr?nevent=1');
  });

  it('accepts recipe config deeplinks for both schemes', () => {
    expect(isRecipeConfigDeeplink('openduck://recipe?config=abc')).toBe(true);
    expect(isRecipeConfigDeeplink('goose://recipe?config=abc')).toBe(true);
    expect(isRecipeConfigDeeplink('openduck://recipe?url=example')).toBe(false);
    expect(recipeConfigPayload('openduck://recipe?config=abc')).toBe('abc');
    expect(recipeConfigPayload('goose://recipe?config=xyz')).toBe('xyz');
  });

  it('accepts nostr session share deeplinks for both schemes', () => {
    expect(isSessionNostrDeeplink('openduck://sessions/nostr?nevent=1')).toBe(true);
    expect(isSessionNostrDeeplink('goose://sessions/nostr?nevent=1')).toBe(true);
    expect(isSessionNostrDeeplink('openduck://sessions/other')).toBe(false);
  });
});
