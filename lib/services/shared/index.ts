/**
 * Shared backend services.
 *
 * These services encapsulate common logic used across specialized chat services:
 * - ModelSelector: Model selection, validation, and automatic upgrades
 * - ToneService: Tone application to system prompts
 * - StreamingService: Streaming and temperature configuration
 *
 * All shared services are designed for dependency injection and easy testing.
 */

export { ModelSelector } from './ModelSelector';
export { ToneService } from './ToneService';
export { StreamingService } from './StreamingService';
export { RateLimiter } from './RateLimiter';
