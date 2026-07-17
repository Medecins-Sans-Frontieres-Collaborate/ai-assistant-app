/**
 * Compatibility shim: the edit-application module is shared by the
 * translation and document review flows and now lives under
 * lib/utils/shared/review/. Import from there in new code.
 */
export * from '../review/editApplication';
