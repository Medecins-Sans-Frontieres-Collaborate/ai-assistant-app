/**
 * Synchronous snapshot of the config-based global admin roster.
 *
 * `isGlobalAdmin()` (lib/services/agentAccess/adminAuth.ts) has ~60
 * synchronous call sites, most of them `resolveAdminStatus(session.user,
 * config)` right after a `getSnapshot()`. Rather than make all of them async,
 * this module holds the last successfully read roster as a Set, and the
 * Node-only GlobalAdminRosterService publishes into it after every successful
 * refresh. The `auth()` session callback awaits one `ensureFresh()`, so every
 * gate downstream of `auth()` reads the same ≤60s snapshot — the same
 * warm-then-read-sync convention as AgentAccessService and groupMembership.
 *
 * NO imports, on purpose: adminAuth.ts must stay free of storage so the tests
 * that mock only `@/config/environment` keep passing, and so the identity
 * module cannot pull Azure into a client bundle via a type-only import.
 *
 * Cold (never published) = env roster only. That can fail to recognise a
 * config admin but can never grant, which is what keeps `AGENT_ACCESS_ADMINS`
 * the un-lockable bootstrap.
 */

let admins: ReadonlySet<string> = new Set();
let loaded = false;

/** `normalizedMail` must already be trimmed + lowercased. */
export function isConfigGlobalAdmin(normalizedMail: string): boolean {
  return admins.has(normalizedMail);
}

/** Replaces the snapshot; entries are canonicalized and empties dropped. */
export function publishGlobalAdminSnapshot(mails: readonly string[]): void {
  admins = new Set(
    mails.map((mail) => mail.trim().toLowerCase()).filter(Boolean),
  );
  loaded = true;
}

/** False until the first successful roster read (or until a test publishes). */
export function isGlobalAdminSnapshotLoaded(): boolean {
  return loaded;
}

/** Test seam only — returns the module to its cold state. */
export function __resetGlobalAdminSnapshotForTests(): void {
  admins = new Set();
  loaded = false;
}
