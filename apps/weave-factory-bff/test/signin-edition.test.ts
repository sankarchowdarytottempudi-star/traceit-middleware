// The server-rendered sign-in and no-access pages name the edition's product: "TraceIT Weave" by default,
// "Cruise Saudi Weave" when WEAVE_EDITION (or VITE_WEAVE_EDITION) is cruise-saudi, never TraceIT/Tottempudi there.
import { describe, it, expect } from "vitest";
import { productName } from "../src/access/settings";
import { noAccessPage, signInPage, SIGNIN_MESSAGES } from "../src/access/pages";

const FORBIDDEN = /traceit-tottech|traceit|tottempudi/i;
const AREA = "__AREA__";

describe("product name on the sign-in page per edition", () => {
  it("TraceIT edition (default) stays TraceIT Weave", () => {
    expect(productName({})).toBe("TraceIT Weave");
    expect(productName({ WEAVE_EDITION: "traceit" })).toBe("TraceIT Weave");
    expect(signInPage({ product: productName({}), area: AREA, base: "", providers: ["wso2"] })).toContain("<h1>TraceIT Weave</h1>");
  });
  it.each([
    [{ WEAVE_EDITION: "cruise-saudi" }],
    [{ VITE_WEAVE_EDITION: "cruise-saudi" }],
    [{ WEAVE_EDITION: " Cruise-Saudi " }],
  ])("Cruise Saudi edition %j: Cruise Saudi Weave", (env) => {
    expect(productName(env as NodeJS.ProcessEnv)).toBe("Cruise Saudi Weave");
  });
  it("Cruise Saudi pages (every provider, every message) never name TraceIT or Tottempudi", () => {
    const product = productName({ WEAVE_EDITION: "cruise-saudi" });
    for (const message of [undefined, ...Object.keys(SIGNIN_MESSAGES)]) {
      const html = signInPage({ product, area: AREA, base: "/x", providers: ["oidc", "wso2", "local"], message });
      expect(html).toContain("<title>Sign in · Cruise Saudi Weave</title>");
      expect(html).toContain("<h1>Cruise Saudi Weave</h1>");
      expect(html).not.toMatch(FORBIDDEN);
      const no = noAccessPage({ product, base: "/x", who: "ana@cruisesaudi.com", message: message ?? "noaccess" });
      expect(no).toContain("Cruise Saudi Weave");
      expect(no).not.toMatch(FORBIDDEN);
    }
  });
  it("WEAVE_PRODUCT_NAME still overrides the edition name", () => {
    expect(productName({ WEAVE_EDITION: "cruise-saudi", WEAVE_PRODUCT_NAME: "Weave" })).toBe("Weave");
  });
});
