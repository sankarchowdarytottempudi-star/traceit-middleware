/** One place for product identity. This app is the "Factory" area of Weave. */
export { PRODUCT_NAME, MODULES, TAGLINE, COMPANY_LINE, SIGN_IN_LABEL, OWNER_NAME } from "@traceit/weave-brand";
export { WeaveMark, WeaveLockup, TraceItLogo, OwnerLogo } from "@traceit/weave-brand";
import { MODULES, PRODUCT_NAME } from "@traceit/weave-brand";

export const BRAND = { name: PRODUCT_NAME, section: "Weave", area: MODULES.factory } as const;
/** External Weave Gateway URL; the Gateway nav item is hidden when empty. */
export const WEAVE_GATEWAY_URL: string = (import.meta.env.VITE_WEAVE_GATEWAY_URL as string | undefined) ?? "";
