// What this edition of the Factory offers. The default (TraceIT) edition offers every source technology
// and every target platform the server lists. The Cruise Saudi edition (VITE_WEAVE_EDITION=cruise-saudi,
// chosen when the UI is built) migrates MuleSoft (Mule 4) to WSO2 (Ballerina) only: the other sources,
// the other targets, "From requirements" and the Boomi / Workato import are not offered. The server
// refuses them too when it runs with WEAVE_EDITION=cruise-saudi, so this is not only a screen rule.
import { IS_CRUISE_SAUDI } from "@traceit/weave-brand";

/** Mule 4 to WSO2 only (the Cruise Saudi edition). */
export const MULE_TO_WSO2_ONLY: boolean = IS_CRUISE_SAUDI;
/** The one source technology and the one target of the Mule-only edition (the server's ids). */
export const ONLY_SOURCE = "mule4";
export const ONLY_TARGET = "wso2";
export const ONLY_SOURCE_LABEL = "MuleSoft (Mule 4)";
export const ONLY_TARGET_LABEL = "WSO2 (Ballerina service)";

/** The source technologies this edition offers, from the list the server sent. */
export function offeredSources<T extends { id: string }>(list: readonly T[]): T[] {
  return MULE_TO_WSO2_ONLY ? list.filter((t) => t.id === ONLY_SOURCE) : [...list];
}
/** The target platforms this edition offers, from the list the server sent. */
export function offeredTargets<T extends { id: string }>(list: readonly T[]): T[] {
  return MULE_TO_WSO2_ONLY ? list.filter((t) => t.id === ONLY_TARGET) : [...list];
}
/** The technology chosen when the form opens: Mule in the Mule-only edition, otherwise "detect it". */
export const DEFAULT_SOURCE: string = MULE_TO_WSO2_ONLY ? ONLY_SOURCE : "auto";
/** "From requirements" (a service drafted from a requirement document): not in the Mule-only edition. */
export const OFFERS_REQUIREMENTS: boolean = !MULE_TO_WSO2_ONLY;
/** Boomi / Workato accounts and the import into them: not in the Mule-only edition. */
export const OFFERS_TARGET_PLATFORMS: boolean = !MULE_TO_WSO2_ONLY;
