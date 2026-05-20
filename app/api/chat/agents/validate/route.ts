import { NextRequest, NextResponse } from 'next/server';

import { isValidAgentId } from '@/lib/utils/app/agentId';

import { auth } from '@/auth';
import { env } from '@/config/environment';
import { AIProjectClient } from '@azure/ai-projects';
import { DefaultAzureCredential } from '@azure/identity';

/**
 * Validates that an Azure AI Foundry agent is accessible
 * POST /api/chat/agents/validate
 *
 * Accepts both legacy (asst_xxxxx) and new (agent-name) formats.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { agentId } = await req.json();

    if (!agentId || typeof agentId !== 'string') {
      return NextResponse.json(
        { error: 'Agent ID is required' },
        { status: 400 },
      );
    }

    // Validate agent ID format (supports both legacy asst_xxx and new agent-name)
    if (!isValidAgentId(agentId)) {
      return NextResponse.json(
        {
          error: 'Invalid agent ID format',
          details: 'Agent ID must match format: agent-name or asst_xxxxx',
        },
        { status: 400 },
      );
    }

    // AI Foundry uses a separate project endpoint (services.ai.azure.com)
    const endpoint = env.AZURE_AI_FOUNDRY_ENDPOINT;
    if (!endpoint) {
      return NextResponse.json(
        {
          error: 'Azure AI Foundry endpoint not configured',
          details:
            'Server configuration error. Please contact your administrator.',
        },
        { status: 500 },
      );
    }

    // Test connection to the agent
    try {
      const project = new AIProjectClient(
        endpoint,
        new DefaultAzureCredential(),
      );

      // Try to retrieve the agent to verify it exists and is accessible
      const agent = await project.agents.get(agentId);

      if (!agent) {
        return NextResponse.json(
          {
            error: 'Agent not found',
            details: `Agent "${agentId}" does not exist in the MSF AI Assistant Foundry instance.`,
          },
          { status: 404 },
        );
      }

      // Success - agent exists and is accessible
      return NextResponse.json({
        valid: true,
        agentId: agentId,
        agentName: agent.name || 'Unknown',
        message: 'Agent validated successfully',
      });
    } catch (agentError: any) {
      console.error('Agent validation error:', agentError);

      // Handle specific Azure errors
      if (agentError.statusCode === 404 || agentError.code === 'NotFound') {
        return NextResponse.json(
          {
            error: 'Agent not found',
            details: `Agent "${agentId}" does not exist in the MSF AI Assistant Foundry instance. Please verify the ID with your administrator.`,
          },
          { status: 404 },
        );
      }

      if (agentError.statusCode === 403 || agentError.code === 'Forbidden') {
        return NextResponse.json(
          {
            error: 'Access denied',
            details:
              'The server does not have permission to access this agent. Please contact your administrator.',
          },
          { status: 403 },
        );
      }

      // Generic error
      return NextResponse.json(
        {
          error: 'Validation failed',
          details:
            agentError.message ||
            'Unable to connect to the agent. Please verify the Agent ID and try again.',
        },
        { status: 500 },
      );
    }
  } catch (error: any) {
    console.error('Agent validation error:', error);
    return NextResponse.json(
      {
        error: 'Server error',
        details:
          error.message || 'An unexpected error occurred during validation.',
      },
      { status: 500 },
    );
  }
}
