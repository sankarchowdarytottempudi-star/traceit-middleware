/** Build-time branding of the static files (index.html title, web manifest, brand SVGs) per edition.
 *  Pure string functions, no browser or Node APIs: used by the Vite plugin (vite/editionPlugin.ts),
 *  which rewrites what Vite copies from public/, and by the tests. The TraceIT edition is a no-op. */
import type { Edition } from "./constants.ts";

export const EDITION_NAMES: Record<Edition, { product: string; owner: string }> = {
  traceit: { product: "TraceIT Weave", owner: "TraceIT" },
  "cruise-saudi": { product: "Cruise Saudi Weave", owner: "Cruise Saudi" },
};

/** Same rule as constants.ts: only the exact value "cruise-saudi" selects the Cruise Saudi edition. */
export function parseEdition(v: string | undefined | null): Edition {
  return v === "cruise-saudi" ? "cruise-saudi" : "traceit";
}

/** Names a Cruise Saudi user must never see (same pattern as the go-live branding checks B1-B7). */
export const FOREIGN_BRAND = /traceit-tottech|traceit|tottempudi/i;

/** TraceIT's own logo files (traceit-logo-*.svg, traceit-mark-*.svg): the Cruise Saudi build leaves them out. */
export function isForeignBrandFile(relPath: string, edition: Edition): boolean {
  return edition === "cruise-saudi" && FOREIGN_BRAND.test(relPath.split("/").pop() ?? "");
}

/** Product name inside a static text file (manifest name/description, SVG <title> and aria-label). */
export function brandText(text: string, edition: Edition): string {
  if (edition === "traceit") return text;
  return text.replace(/TraceIT Weave/g, EDITION_NAMES[edition].product);
}

/** The <title> of index.html: the product name of the edition. */
export function indexTitle(html: string, edition: Edition): string {
  return html.replace(/<title>[^<]*<\/title>/i, `<title>${EDITION_NAMES[edition].product}</title>`);
}

/** First forbidden name in a text with some context around it, or null when the text is clean. */
export function findForeignBrand(text: string): string | null {
  const m = FOREIGN_BRAND.exec(text);
  if (!m) return null;
  return text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).replace(/\s+/g, " ");
}
