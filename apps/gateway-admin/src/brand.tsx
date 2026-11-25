/** One place for product identity. Values come from @traceit/weave-brand. */
export { PRODUCT_NAME, MODULES, TAGLINE, COMPANY_LINE, SIGN_IN_LABEL, OWNER_NAME, pageTitle } from "@traceit/weave-brand";
export { WeaveMark, WeaveLockup, TraceItLogo, OwnerLogo } from "@traceit/weave-brand";
import { MODULES, PRODUCT_NAME } from "@traceit/weave-brand";

export const BRAND = { name: PRODUCT_NAME, section: "Weave", area: MODULES.gateway } as const;
/** External Weave Factory URL; the Factory nav item is hidden when empty. */
export const WEAVE_FACTORY_URL: string = (import.meta.env.VITE_WEAVE_FACTORY_URL as string | undefined) ?? "";
