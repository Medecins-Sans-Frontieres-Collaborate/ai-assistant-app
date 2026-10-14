/**
 * Bounds on an edit payload. The rows are written to local disk as-is, so
 * without a cap a single authorized caller could fill the temp volume of the
 * replica. Real extractions are tens to hundreds of rows; both limits are an
 * order of magnitude above anything the pipeline produces.
 */
export const MAX_SAVE_ROWS = 10_000;
export const MAX_SAVE_BODY_BYTES = 20 * 1024 * 1024;
