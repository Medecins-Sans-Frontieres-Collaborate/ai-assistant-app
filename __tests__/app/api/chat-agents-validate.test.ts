import { NextRequest } from 'next/server';

import {
  createMockRequest,
  createMockSession,
  parseJsonResponse,
} from './helpers';

import { POST } from '@/app/api/chat/agents/validate/route';
import { auth } from '@/auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist mocks before imports
const mockAuth = vi.hoisted(() => vi.fn());
const mockDefaultAzureCredential = vi.hoisted(() => vi.fn());
const mockAIProjectClient = vi.hoisted(() => vi.fn());
const mockGetAgent = vi.hoisted(() => vi.fn());
const mockEnv = vi.hoisted(() => ({
  AZURE_AI_FOUNDRY_ENDPOINT: 'https://test-foundry.services.ai.azure.com',
}));

// Mock dependencies
vi.mock('@/auth', () => ({
  auth: mockAuth,
}));

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: mockDefaultAzureCredential,
}));

vi.mock('@azure/ai-projects', () => ({
  AIProjectClient: mockAIProjectClient,
}));

vi.mock('@/config/environment', () => ({
  env: mockEnv,
}));

/**
 * Tests for POST /api/chat/agents/validate
 * Azure AI Foundry agent validation endpoint
 */
describe('/api/chat/agents/validate', () => {
  const mockSession = createMockSession();
  const validLegacyAgentId = 'asst_abc123_test';
  const validNewAgentName = 'my-agent-name';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup auth mock
    mockAuth.mockResolvedValue(mockSession as any);

    // Setup Azure Identity mocks
    mockDefaultAzureCredential.mockImplementation(function (this: any) {
      return {};
    });

    // Setup AIProjectClient mock
    mockGetAgent.mockResolvedValue({
      id: validLegacyAgentId,
      name: 'Test Agent',
    });

    mockAIProjectClient.mockImplementation(function (this: any) {
      return {
        agents: {
          get: mockGetAgent,
        },
      };
    });

    // Mock environment variable
    process.env.AZURE_AI_FOUNDRY_ENDPOINT =
      'https://test-foundry.services.ai.azure.com';
  });

  const createValidateRequest = (options: {
    body?: any;
    url?: string;
  }): NextRequest => {
    const {
      body = {
        agentId: validLegacyAgentId,
      },
      url = 'http://localhost:3000/api/chat/agents/validate',
    } = options;

    return createMockRequest({
      method: 'POST',
      url,
      body,
    });
  };

  describe('Authentication', () => {
    it('returns 401 when session is not found', async () => {
      mockAuth.mockResolvedValue(null);

      const request = createValidateRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(401);
      expect(data.error).toBe('Unauthorized');
    });

    it('returns 401 when session has no user', async () => {
      mockAuth.mockResolvedValue({ user: null } as any);

      const request = createValidateRequest({});
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('allows authenticated requests', async () => {
      const request = createValidateRequest({});
      const response = await POST(request);

      if (response.status !== 200) {
        const data = await parseJsonResponse(response);
        console.log('Response data:', data);
      }

      expect(response.status).toBe(200);
    });
  });

  describe('Request Validation', () => {
    it('returns 400 when agentId is missing', async () => {
      const request = createValidateRequest({
        body: {},
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Agent ID is required');
    });

    it('returns 400 when agentId is not a string', async () => {
      const request = createValidateRequest({
        body: {
          agentId: 12345,
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Agent ID is required');
    });

    it('returns 400 when agentId has invalid characters', async () => {
      const request = createValidateRequest({
        body: {
          agentId: 'asst_abc@123',
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid agent ID format');
    });

    it('returns 400 when agentId starts with special character', async () => {
      const request = createValidateRequest({
        body: {
          agentId: '-invalid-start',
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Invalid agent ID format');
      expect(data.details).toContain('agent-name or asst_xxxxx');
    });

    it('accepts valid legacy agentId with underscores', async () => {
      const request = createValidateRequest({
        body: {
          agentId: 'asst_test_agent_123',
        },
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it('accepts valid legacy agentId with hyphens', async () => {
      const request = createValidateRequest({
        body: {
          agentId: 'asst_test-agent-123',
        },
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it('accepts valid legacy agentId with mixed case', async () => {
      const request = createValidateRequest({
        body: {
          agentId: 'asst_TestAgent123',
        },
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it('accepts new agent name format', async () => {
      mockGetAgent.mockResolvedValue({
        id: validNewAgentName,
        name: 'My Agent',
      });

      const request = createValidateRequest({
        body: {
          agentId: validNewAgentName,
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.agentId).toBe(validNewAgentName);
    });

    it('accepts new agent name with hyphens', async () => {
      mockGetAgent.mockResolvedValue({
        id: 'gpt-41',
        name: 'GPT 4.1 Agent',
      });

      const request = createValidateRequest({
        body: {
          agentId: 'gpt-41',
        },
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it('accepts new agent name with underscores', async () => {
      mockGetAgent.mockResolvedValue({
        id: 'my_agent_name',
        name: 'My Agent',
      });

      const request = createValidateRequest({
        body: {
          agentId: 'my_agent_name',
        },
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
    });
  });

  describe('Environment Configuration', () => {
    it('returns 500 when AZURE_AI_FOUNDRY_ENDPOINT is not configured', async () => {
      // Temporarily remove the endpoint from mock
      const originalEndpoint = mockEnv.AZURE_AI_FOUNDRY_ENDPOINT;
      mockEnv.AZURE_AI_FOUNDRY_ENDPOINT = undefined as any;

      const request = createValidateRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Azure AI Foundry endpoint not configured');
      expect(data.details).toContain('Server configuration error');

      // Restore for other tests
      mockEnv.AZURE_AI_FOUNDRY_ENDPOINT = originalEndpoint;
    });
  });

  describe('Agent Validation', () => {
    it('creates AIProjectClient with correct endpoint and credentials', async () => {
      const request = createValidateRequest({});
      await POST(request);

      expect(mockAIProjectClient).toHaveBeenCalledWith(
        'https://test-foundry.services.ai.azure.com',
        expect.any(Object),
      );
      expect(mockDefaultAzureCredential).toHaveBeenCalled();
    });

    it('calls agents.getAgent with provided agentId', async () => {
      const request = createValidateRequest({
        body: {
          agentId: 'asst_custom_agent',
        },
      });

      await POST(request);

      expect(mockGetAgent).toHaveBeenCalledWith('asst_custom_agent');
    });

    it('calls agents.getAgent with new-format agent name', async () => {
      mockGetAgent.mockResolvedValue({
        id: 'my-custom-agent',
        name: 'My Custom Agent',
      });

      const request = createValidateRequest({
        body: {
          agentId: 'my-custom-agent',
        },
      });

      await POST(request);

      expect(mockGetAgent).toHaveBeenCalledWith('my-custom-agent');
    });

    it('returns success response when agent exists', async () => {
      mockGetAgent.mockResolvedValue({
        id: validLegacyAgentId,
        name: 'Production Agent',
      });

      const request = createValidateRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.agentId).toBe(validLegacyAgentId);
      expect(data.agentName).toBe('Production Agent');
      expect(data.message).toBe('Agent validated successfully');
    });

    it('returns agent name as "Unknown" when name is missing', async () => {
      mockGetAgent.mockResolvedValue({
        id: validLegacyAgentId,
        // name is missing
      });

      const request = createValidateRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.agentName).toBe('Unknown');
    });

    it('returns 404 when agent is null', async () => {
      mockGetAgent.mockResolvedValue(null);

      const request = createValidateRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(404);
      expect(data.error).toBe('Agent not found');
      expect(data.details).toContain(validLegacyAgentId);
    });
  });

  describe('Error Handling - Azure Errors', () => {
    it('returns 404 when Azure returns NotFound error', async () => {
      const notFoundError = new Error('Not found') as any;
      notFoundError.statusCode = 404;

      mockGetAgent.mockRejectedValue(notFoundError);

      const request = createValidateRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(404);
      expect(data.error).toBe('Agent not found');
      expect(data.details).toContain(validLegacyAgentId);
      expect(data.details).toContain('verify the ID');
    });

    it('returns 404 when Azure returns code "NotFound"', async () => {
      const notFoundError = new Error('Not found') as any;
      notFoundError.code = 'NotFound';

      mockGetAgent.mockRejectedValue(notFoundError);

      const request = createValidateRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(404);
      expect(data.error).toBe('Agent not found');
    });

    it('returns 403 when Azure returns Forbidden error', async () => {
      const forbiddenError = new Error('Forbidden') as any;
      forbiddenError.statusCode = 403;

      mockGetAgent.mockRejectedValue(forbiddenError);

      const request = createValidateRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(403);
      expect(data.error).toBe('Access denied');
      expect(data.details).toContain('does not have permission');
    });

    it('returns 403 when Azure returns code "Forbidden"', async () => {
      const forbiddenError = new Error('Forbidden') as any;
      forbiddenError.code = 'Forbidden';

      mockGetAgent.mockRejectedValue(forbiddenError);

      const request = createValidateRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(403);
      expect(data.error).toBe('Access denied');
    });

    it('returns 500 for generic Azure errors', async () => {
      const genericError = new Error('Connection timeout') as any;

      mockGetAgent.mockRejectedValue(genericError);

      const request = createValidateRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Validation failed');
      expect(data.details).toBe('Connection timeout');
    });

    it('returns 500 with default message when error has no message', async () => {
      const genericError = new Error() as any;
      genericError.message = '';

      mockGetAgent.mockRejectedValue(genericError);

      const request = createValidateRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Validation failed');
      expect(data.details).toContain('Unable to connect to the agent');
    });

    it('logs agent validation errors to console', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      const testError = new Error('Test error');

      mockGetAgent.mockRejectedValue(testError);

      const request = createValidateRequest({});
      await POST(request);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Agent validation error:',
        testError,
      );

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Error Handling - General Errors', () => {
    it('returns 500 on authentication errors', async () => {
      mockAuth.mockRejectedValue(new Error('Auth service down'));

      const request = createValidateRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Server error');
      expect(data.details).toBe('Auth service down');
    });

    it('handles request body parsing gracefully', async () => {
      const request = createValidateRequest({
        body: {},
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(400);
      expect(data.error).toBe('Agent ID is required');
    });

    it('logs general errors to console', async () => {
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      mockAuth.mockRejectedValue(new Error('General error'));

      const request = createValidateRequest({});
      await POST(request);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Agent validation error:',
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
    });

    it('handles errors without message property', async () => {
      mockAuth.mockRejectedValue('String error without message');

      const request = createValidateRequest({});
      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(500);
      expect(data.error).toBe('Server error');
      expect(data.details).toContain('unexpected error');
    });
  });

  describe('Integration Scenarios', () => {
    it('handles complete validation workflow with legacy ID', async () => {
      mockGetAgent.mockResolvedValue({
        id: 'asst_production_agent_v2',
        name: 'Production Search Agent',
        description: 'Bing-grounded search agent',
      });

      const request = createValidateRequest({
        body: {
          agentId: 'asst_production_agent_v2',
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.agentId).toBe('asst_production_agent_v2');
      expect(data.agentName).toBe('Production Search Agent');
      expect(data.message).toBe('Agent validated successfully');

      // Verify all required steps
      expect(auth).toHaveBeenCalled();
      expect(mockAIProjectClient).toHaveBeenCalled();
      expect(mockGetAgent).toHaveBeenCalledWith('asst_production_agent_v2');
    });

    it('handles complete validation workflow with new agent name', async () => {
      mockGetAgent.mockResolvedValue({
        id: 'gpt-41',
        name: 'GPT 4.1 Search Agent',
      });

      const request = createValidateRequest({
        body: {
          agentId: 'gpt-41',
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(200);
      expect(data.valid).toBe(true);
      expect(data.agentId).toBe('gpt-41');
      expect(data.agentName).toBe('GPT 4.1 Search Agent');
    });

    it('handles agent not found scenario with clear error message', async () => {
      const notFoundError = new Error('Resource not found') as any;
      notFoundError.statusCode = 404;

      mockGetAgent.mockRejectedValue(notFoundError);

      const request = createValidateRequest({
        body: {
          agentId: 'asst_nonexistent_agent',
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(404);
      expect(data.error).toBe('Agent not found');
      expect(data.details).toContain('asst_nonexistent_agent');
      expect(data.details).toContain('does not exist');
    });

    it('handles permission denied scenario with helpful message', async () => {
      const forbiddenError = new Error('Insufficient permissions') as any;
      forbiddenError.statusCode = 403;

      mockGetAgent.mockRejectedValue(forbiddenError);

      const request = createValidateRequest({
        body: {
          agentId: 'asst_restricted_agent',
        },
      });

      const response = await POST(request);
      const data = await parseJsonResponse(response);

      expect(response.status).toBe(403);
      expect(data.error).toBe('Access denied');
      expect(data.details).toContain('does not have permission');
      expect(data.details).toContain('contact your administrator');
    });

    it('validates multiple different agent IDs (legacy and new formats)', async () => {
      const testAgents = [
        'asst_agent_1',
        'asst_agent-with-hyphens',
        'asst_Agent_With_Mixed_Case',
        'asst_123456789',
        'my-agent',
        'gpt-41',
        'claude-sonnet-46',
      ];

      for (const agentId of testAgents) {
        mockGetAgent.mockResolvedValue({
          id: agentId,
          name: `Test Agent ${agentId}`,
        });

        const request = createValidateRequest({
          body: { agentId },
        });

        const response = await POST(request);
        const data = await parseJsonResponse(response);

        expect(response.status).toBe(200);
        expect(data.agentId).toBe(agentId);
        expect(mockGetAgent).toHaveBeenCalledWith(agentId);

        vi.clearAllMocks();
        mockAuth.mockResolvedValue(mockSession as any);
        mockDefaultAzureCredential.mockImplementation(function (this: any) {
          return {};
        });
        mockAIProjectClient.mockImplementation(function (this: any) {
          return {
            agents: {
              get: mockGetAgent,
            },
          };
        });
      }
    });
  });
});
