/**
 * The "Recommended" tag on featured-tier models — the pill on list rows and
 * the suffix on version chips — is intentionally hidden for now. Flip this to
 * true to bring it back; the rendering code is still in place.
 *
 * While off, the 'featured' tier still fronts series rows (see
 * seriesRepresentative in lib/utils/app/modelSeries.ts); it just carries no
 * visible tag.
 */
export const SHOW_RECOMMENDED_TAG: boolean = false;
