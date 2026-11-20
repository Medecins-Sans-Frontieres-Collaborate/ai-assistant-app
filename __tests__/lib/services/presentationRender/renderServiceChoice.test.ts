import { beforeEach, describe, expect, it, vi } from 'vitest';

/** RENDER_SERVICE picks the implementation; callers do not change. */

const env = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock('@/config/environment', () => ({ env }));

const SERVICE_KEY = Symbol.for('ai-assistant.render-service');

beforeEach(() => {
  delete (globalThis as Record<symbol, unknown>)[SERVICE_KEY];
  for (const key of Object.keys(env)) delete env[key];
});

describe('getRenderService', () => {
  it('reaches a separate service over HTTP when configured', async () => {
    Object.assign(env, {
      RENDER_SERVICE: 'http',
      RENDER_SERVICE_URL: 'http://render.internal',
    });
    const { getRenderService } =
      await import('@/lib/services/presentationRender/renderService');
    const { HttpRenderService } =
      await import('@/lib/services/presentationRender/httpRenderService');
    expect(getRenderService()).toBeInstanceOf(HttpRenderService);
  });

  it('refuses http without an address', async () => {
    Object.assign(env, { RENDER_SERVICE: 'http' });
    const { getRenderService } =
      await import('@/lib/services/presentationRender/renderService');
    expect(() => getRenderService()).toThrow('RENDER_SERVICE_URL');
  });

  it('runs LibreOffice in process by default', async () => {
    Object.assign(env, {
      RENDER_MAX_CONCURRENT: 1,
      RENDER_MAX_QUEUED: 5,
      RENDER_INTERACTIVE_BURST: 3,
    });
    const { getRenderService, InProcessRenderService } =
      await import('@/lib/services/presentationRender/renderService');
    expect(getRenderService()).toBeInstanceOf(InProcessRenderService);
  });
});
