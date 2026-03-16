/**
 * Content Processors
 *
 * Process different types of content (files, images, audio) before chat execution.
 *
 * Processors run in the pipeline's content processing stage:
 * - FileProcessor: Downloads, extracts, and summarizes files (including audio/video)
 * - ImageProcessor: Validates and extracts images (pass-through for vision models)
 *
 * All processors implement PipelineStage and modify ChatContext.processedContent.
 */

export { FileProcessor } from './FileProcessor';
export { ImageProcessor } from './ImageProcessor';
export { ActiveFileProcessor } from './ActiveFileProcessor';
export { ActiveFileInjector } from './ActiveFileInjector';
