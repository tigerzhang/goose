import type { PendingPermission, PermissionAction } from "../types";
import { toolTitleFromPermission } from "../permissions";

type Props = {
  pending: PendingPermission;
  onResolve: (action: PermissionAction) => void;
};

export function PermissionModal({ pending, onResolve }: Props) {
  const { request } = pending;
  const title = toolTitleFromPermission(request);
  const kinds = new Set(request.options.map((o) => o.kind));

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="perm-title"
      >
        <h2 id="perm-title">Tool permission</h2>
        <p className="perm-tool">{title}</p>
        {request.toolCall.rawInput != null && (
          <pre className="code-block small">
            {typeof request.toolCall.rawInput === "string"
              ? request.toolCall.rawInput
              : JSON.stringify(request.toolCall.rawInput, null, 2)}
          </pre>
        )}
        <p className="hint">
          Tools run on the remote host as the goose serve user — not on this
          phone.
        </p>
        <div className="perm-actions">
          {kinds.has("allow_once") && (
            <button
              type="button"
              className="btn primary"
              onClick={() => onResolve("allow_once")}
            >
              Allow once
            </button>
          )}
          {kinds.has("allow_always") && (
            <button
              type="button"
              className="btn"
              onClick={() => onResolve("always_allow")}
            >
              Always allow
            </button>
          )}
          {kinds.has("reject_once") && (
            <button
              type="button"
              className="btn danger"
              onClick={() => onResolve("deny_once")}
            >
              Deny
            </button>
          )}
          {kinds.has("reject_always") && (
            <button
              type="button"
              className="btn danger"
              onClick={() => onResolve("always_deny")}
            >
              Always deny
            </button>
          )}
          <button
            type="button"
            className="btn ghost"
            onClick={() => onResolve("cancel")}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
