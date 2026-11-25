/** Product identity per edition. The edition is chosen when the UI is built: VITE_WEAVE_EDITION
 *  ("traceit" when unset, "cruise-saudi" for the Cruise Saudi installation). One codebase, one switch. */
type Env = { VITE_WEAVE_EDITION?: string };
const env: Env = ((import.meta as unknown as { env?: Env }).env ?? {});
export type Edition = "traceit" | "cruise-saudi";
export const EDITION: Edition = env.VITE_WEAVE_EDITION === "cruise-saudi" ? "cruise-saudi" : "traceit";
export const IS_CRUISE_SAUDI = EDITION === "cruise-saudi";

export const OWNER_NAME = IS_CRUISE_SAUDI ? "Cruise Saudi" : "TraceIT";
export const PRODUCT_NAME = IS_CRUISE_SAUDI ? "Cruise Saudi Weave" : "TraceIT Weave";
export const MODULES = { factory: "Weave Factory", gateway: "Weave Gateway" } as const;
export const TAGLINE = "Monitor it. Weave it.";
export const COMPANY_LINE = IS_CRUISE_SAUDI
  ? "Cruise Saudi Weave is proprietary software of Cruise Saudi"
  : "TraceIT Weave is a product of Tottempudi Software Solutions Pvt Ltd";
/** The sign-in button: the Cruise Saudi edition never names the identity product behind it. */
export const SIGN_IN_LABEL = IS_CRUISE_SAUDI ? "Sign in" : "Sign in with WSO2";
export type BrandTheme = "light" | "dark";
