import { useQuery } from "@tanstack/react-query";
import { apiClient, rolesOf } from "../api.ts";
import { WEAVE_FACTORY_URL } from "../brand.tsx";
import { Card } from "../components/ui.tsx";
import { PageHeader } from "./PageHeader.tsx";

/** Shown for an address this person may not use (or that does not exist). */
export function NoAccess() {
  const me = useQuery({ queryKey: ["me"], queryFn: apiClient.me, retry: false });
  const roles = rolesOf(me.data);
  const gateway = roles.includes("gateway");
  return (
    <>
      <PageHeader area="Access" title={gateway ? "Page not found" : "No access to the Gateway console"}
        subtitle={gateway ? "This address does not exist." : "Your account has not been given access to the Gateway console. Ask an administrator if you need it."} />
      {!gateway && roles.includes("migration") && WEAVE_FACTORY_URL && (
        <Card><p style={{ margin: 0 }}>You can use the Factory: <a className="gw-link" href={WEAVE_FACTORY_URL}>open the Factory</a>.</p></Card>
      )}
    </>
  );
}
