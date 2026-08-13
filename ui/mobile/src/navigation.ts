export type MobileView = "chat" | "sessions";

/** Parse the location hash into a connected-app view. */
export function viewFromHash(hash = ""): MobileView {
  const normalized = hash.replace(/^#\/?/, "").replace(/\/+$/, "");
  return normalized === "sessions" ? "sessions" : "chat";
}

export function hashForView(view: MobileView): string {
  return view === "sessions" ? "#/sessions" : "#/";
}
