/**
 * Access control for Grants Processing.
 *
 * Membership of one Entra security group decides access,
 * if the user engaged in the current session is found to be a member of the group
 * then they are allowed to use the Grants Processing workflow.
 */

export const GRANTS_ENTRA_GROUP_NAME = 'SEC_NYC_GRANTS_WORKFLOW_USERS';
export const GRANTS_ENTRA_GROUP_ID = 'baea9ffd-0302-41a3-a0f6-62210cba94b0';

export function canAccessGrants(
  groupIds?: readonly string[] | null,
  grantsGroupId: string = GRANTS_ENTRA_GROUP_ID,
): boolean {
  const target = grantsGroupId.trim().toLowerCase();
  if (!target || !groupIds) return false;
  return groupIds.some((id) => id.trim().toLowerCase() === target);
}
