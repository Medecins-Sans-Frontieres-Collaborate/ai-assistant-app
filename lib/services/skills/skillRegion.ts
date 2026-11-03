/** Region policy for skill and routing data, independent of model SDK fallbacks. */
import { resolveChatRegion } from '@/lib/utils/shared/modelRegion';
import type { UserRegion } from '@/lib/utils/shared/region';

/** EU identities cannot opt out; unknown identities take the constrained route. */
export function auxiliaryRegion(
  userRegion?: UserRegion | null,
  requested?: UserRegion | null,
): UserRegion {
  if (userRegion !== 'US' && userRegion !== 'EU') return 'EU';
  return resolveChatRegion(userRegion, requested) ?? userRegion ?? 'EU';
}

/** A constrained request cannot query an organization corpus configured outside the EU. */
export function assertSkillDataRegion(
  dataRegion: UserRegion,
  requestRegion?: UserRegion,
): void {
  if (requestRegion === 'EU' && dataRegion !== 'EU')
    throw new Error(
      'EU skill requests require an EU skill document index and embedding endpoint',
    );
}
