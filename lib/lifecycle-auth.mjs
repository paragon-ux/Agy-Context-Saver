/** Runtime lifecycle authorization for restrictive transcript-isolation cohorts. */
import { readPolicies, getLineage, hasRestrictivePolicy } from "./transcript-policy.mjs";
import { resolveCallerIdentity } from "./hook-identity.mjs";
import { getBrainDirs } from "./path-guards.mjs";

export function stripLifecycleGrant(argv) {
  const grants = argv.filter((arg) => arg.startsWith("--hook-grant="));
  if (grants.length > 1) throw new Error("Duplicate hook identity grant.");
  return {
    argv: argv.filter((arg) => !arg.startsWith("--hook-grant=")),
    nonce: grants[0]?.slice("--hook-grant=".length)
  };
}

export function assertLifecycleAuthorized(argv) {
  const stripped = stripLifecycleGrant(argv);
  const identity = resolveCallerIdentity(stripped.nonce, "lifecycle");
  const owner = identity.callerConvId;
  if (!owner || !hasRestrictivePolicy(readPolicies())) return stripped.argv;
  if (!stripped.nonce) {
    throw new Error("Lifecycle mutations require a verified hook identity grant while transcript isolation is restrictive.");
  }
  const lineage = getLineage(owner, getBrainDirs(identity));
  if (lineage.isChild || !lineage.found || lineage.unresolved) {
    throw new Error("Only a confirmed top-level session may mutate lifecycle installation state.");
  }
  return stripped.argv;
}
