/**
 * Strict ARM resource-path validator for Foundry Cognitive Services projects.
 *
 * Locked down to prevent path-injection / SSRF when an untrusted `sources`
 * query param is forwarded to ARM. Accepts only the exact shape of a
 * Microsoft.CognitiveServices/accounts (with optional /projects/{name}) path.
 */
const FOUNDRY_RESOURCE_PATH_REGEX =
  /^\/subscriptions\/[a-zA-Z0-9-]{1,64}\/resourceGroups\/[a-zA-Z0-9._()-]{1,90}\/providers\/Microsoft\.CognitiveServices\/accounts\/[a-zA-Z0-9-]{2,64}(?:\/projects\/[a-zA-Z0-9-]{2,64})?$/;

export function isValidFoundryResourcePath(path: string): boolean {
  if (typeof path !== 'string') return false;
  if (path.length > 512) return false;
  if (path.includes('..') || path.includes('//')) return false;
  return FOUNDRY_RESOURCE_PATH_REGEX.test(path);
}

/**
 * Character/length constraint for ARM account, project, and agent-application
 * names. Exported as a raw pattern source so callers can embed it in larger
 * regexes (e.g. extracting an account name from a path) without re-deriving it.
 */
export const ARM_NAME_PATTERN = '[a-zA-Z0-9-]{2,64}';

const SUBSCRIPTION_ID_REGEX = /^[a-zA-Z0-9-]{1,64}$/;
const RESOURCE_GROUP_REGEX = /^[a-zA-Z0-9._()-]{1,90}$/;
const ACCOUNT_NAME_REGEX = new RegExp(`^${ARM_NAME_PATTERN}$`);

export function isValidSubscriptionId(id: string): boolean {
  return SUBSCRIPTION_ID_REGEX.test(id);
}

export function isValidResourceGroup(name: string): boolean {
  return RESOURCE_GROUP_REGEX.test(name);
}

export function isValidAccountName(name: string): boolean {
  return ACCOUNT_NAME_REGEX.test(name);
}

/**
 * Strips an optional trailing `/projects/{name}` segment so a project-scoped
 * Foundry resource path collapses to its parent account path.
 *
 * Our `AZURE_AI_FOUNDRY_RESOURCE_ID_*` env vars point at the *project* (correct
 * for agent discovery, which lists `/applications` under the project). Model
 * deployments, however, are account-scoped — ARM rejects
 * `/accounts/{acct}/projects/{name}/deployments` as an invalid scope — so model
 * discovery must call `/accounts/{acct}/deployments`. The returned path still
 * satisfies `isValidFoundryResourcePath`.
 */
export function stripToAccountPath(path: string): string {
  return path.replace(/\/projects\/[a-zA-Z0-9-]{2,64}\/?$/, '');
}
