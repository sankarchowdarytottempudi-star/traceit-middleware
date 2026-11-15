// Where this app is served. "" when it has a host of its own; "/factory" when it shares the
// Weave address with the Gateway. The server states it in the page it sends (a meta tag), so one
// build runs at either place.
function read(): string {
  if (typeof document === "undefined") return "";
  const v = document.querySelector('meta[name="weave-base"]')?.getAttribute("content") ?? "";
  return /^(\/[A-Za-z0-9_-]+)+$/.test(v) ? v : "";
}
export const BASE: string = read();
/** The address of a path of this server ("/api/...", "/healthz") as the browser must ask for it. */
export const at = (path: string): string => `${BASE}${path}`;
