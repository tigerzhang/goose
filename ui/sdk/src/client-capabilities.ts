import type { GooseMcpHostCapabilities } from "./mcp-apps.js";

export interface OpenDuckClientCapabilities {
  mcpHostCapabilities?: GooseMcpHostCapabilities;
  customNotifications?: boolean;
  recipeParameterRequests?: boolean;
}

export interface OpenDuckClientCapabilitiesMeta {
  openduck?: OpenDuckClientCapabilities;
  goose?: OpenDuckClientCapabilities;
}

export type GooseClientCapabilitiesMeta = OpenDuckClientCapabilitiesMeta;

