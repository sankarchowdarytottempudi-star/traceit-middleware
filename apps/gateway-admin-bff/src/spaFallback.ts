// Decides what an unmatched URL gets: a JSON 404 (API), a plain 404 (missing file) or the console page.

export type Unmatched = "api" | "file" | "page";

/** "/api" and "/api/..." are API calls. "/apis" is a console screen and must get the page. */
export function classifyUnmatched(rawUrl: string): Unmatched {
  const path = (rawUrl || "/").split("?")[0].split("#")[0];
  if (path === "/api" || path.startsWith("/api/")) return "api";
  // Screens that carry a name in the address (for example /analytics/api/<name>) may contain dots.
  if (path.startsWith("/analytics/")) return "page";
  const last = path.substring(path.lastIndexOf("/") + 1);
  // A concrete file that does not exist must be a 404, never HTML (a stale script would be parsed as JS).
  return last.includes(".") ? "file" : "page";
}
