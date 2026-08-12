import type {
  RequestPermissionRequest,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";

export type ConnectionConfig = {
  baseUrl: string;
  secretKey: string;
  /** Stored for native/future pinning; browsers cannot pin TLS certs. */
  certFingerprint: string;
  /** Working directory on the *remote* host (not the phone). */
  cwd: string;
};

export type ConnectionState =
  | "disconnected"
  | "checking"
  | "connected"
  | "error";

export type PermissionAction =
  | "allow_once"
  | "always_allow"
  | "deny_once"
  | "always_deny"
  | "cancel";

export type ChatRole = "user" | "assistant" | "system";

export type ToolCallEntry = {
  toolCallId: string;
  title: string;
  status: ToolCallStatus;
  kind?: ToolKind;
  summary?: string;
  expanded: boolean;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  streaming?: boolean;
  toolCalls?: ToolCallEntry[];
};

export type PendingPermission = {
  key: string;
  request: RequestPermissionRequest;
};

export const DEFAULT_CONNECTION: ConnectionConfig = {
  baseUrl: "",
  secretKey: "",
  certFingerprint: "",
  /** Absolute path on the remote host; empty until the user sets one. */
  cwd: "",
};

export const STORAGE_KEY = "goose-mobile-connection-v1";
