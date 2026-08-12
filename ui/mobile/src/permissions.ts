import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { PermissionAction } from "./types";

function kindForAction(
  action: PermissionAction,
): "allow_once" | "allow_always" | "reject_once" | "reject_always" | undefined {
  switch (action) {
    case "allow_once":
      return "allow_once";
    case "always_allow":
      return "allow_always";
    case "deny_once":
      return "reject_once";
    case "always_deny":
      return "reject_always";
    case "cancel":
      return undefined;
  }
}

export function permissionResponseForAction(
  request: RequestPermissionRequest,
  action: PermissionAction,
): RequestPermissionResponse {
  if (action === "cancel") {
    return { outcome: { outcome: "cancelled" } };
  }

  const kind = kindForAction(action);
  const optionId = kind
    ? request.options.find((o) => o.kind === kind)?.optionId
    : undefined;

  if (!optionId) {
    const fallback = request.options[0]?.optionId;
    if (!fallback) {
      return { outcome: { outcome: "cancelled" } };
    }
    return {
      outcome: { outcome: "selected", optionId: fallback },
    };
  }

  return {
    outcome: { outcome: "selected", optionId },
  };
}

export function permissionKey(
  sessionId: string,
  toolCallId: string,
): string {
  return `${sessionId}\u0000${toolCallId}`;
}

export function toolTitleFromPermission(
  request: RequestPermissionRequest,
): string {
  const toolCall = request.toolCall;
  if (toolCall.title) return toolCall.title;
  if (typeof toolCall.rawInput === "object" && toolCall.rawInput) {
    const name = (toolCall.rawInput as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return toolCall.toolCallId;
}
