import { NextRequest } from 'next/server';

import { POST } from '@/app/api/chat/feedback/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuth = vi.hoisted(() => vi.fn());
const logCustomMetric = vi.hoisted(() => vi.fn());

vi.mock('@/auth', () => ({ auth: mockAuth }));
vi.mock('@/lib/services/observability/AzureMonitorLoggingService', () => ({
  getAzureMonitorLogger: () => ({ logCustomMetric }),
}));

const user = { id: 'u1', mail: 'a@example.org' };

const post = (body: unknown) =>
  POST(
    new NextRequest('https://app.example.com/api/chat/feedback', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

describe('POST /api/chat/feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user });
  });

  it('logs a good rating as MessageFeedback with value 1 and the ids as tags', async () => {
    const response = await post({
      rating: 'good',
      messageId: 'm1',
      conversationId: 'c1',
      model: 'gpt-5.4',
    });

    expect(response.status).toBe(200);
    expect(logCustomMetric).toHaveBeenCalledWith({
      user,
      metricName: 'MessageFeedback',
      metricValue: 1,
      tags: { messageId: 'm1', conversationId: 'c1', model: 'gpt-5.4' },
    });
  });

  it('logs a bad rating with value -1', async () => {
    await post({ rating: 'bad' });

    expect(logCustomMetric).toHaveBeenCalledWith(
      expect.objectContaining({ metricValue: -1, tags: {} }),
    );
  });

  it('rejects unauthenticated requests', async () => {
    mockAuth.mockResolvedValue(null);

    const response = await post({ rating: 'good' });

    expect(response.status).toBe(401);
    expect(logCustomMetric).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown rating', { rating: 'meh' }],
    ['a missing rating', { messageId: 'm1' }],
    ['an oversized id', { rating: 'good', messageId: 'x'.repeat(129) }],
    ['malformed JSON', '{not json'],
  ])('rejects %s', async (_, body) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(logCustomMetric).not.toHaveBeenCalled();
  });
});
