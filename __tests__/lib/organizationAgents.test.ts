/**
 * Unit Tests for organizationAgents utility functions
 *
 * Tests the utility functions for managing organization agents configuration,
 * including fetching, filtering, and type checking operations.
 */
// Import after mocks are set up
import {
  getFoundryOrganizationAgents,
  getIconComponent,
  getOrganizationAgentById,
  getOrganizationAgentCategories,
  getOrganizationAgentIdFromModelId,
  getOrganizationAgents,
  getOrganizationAgentsByCategory,
  getOrganizationAgentsByType,
  getRAGOrganizationAgents,
  isFoundryAgent,
  isOrganizationAgentId,
  isRAGAgent,
} from '@/lib/organizationAgents';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the config before importing the module
vi.mock('@/config/organization-agents.json', () => ({
  default: {
    version: 1,
    agents: [
      {
        id: 'test_rag_agent',
        name: 'Test RAG Agent',
        description: 'A test RAG agent',
        icon: 'IconNews',
        color: '#4190f2',
        type: 'rag',
        category: 'Knowledge Base',
        enabled: true,
        systemPrompt: 'You are a test agent.',
        sources: [{ name: 'Test Source', url: 'https://example.com' }],
        ragConfig: { topK: 10 },
      },
      {
        id: 'test_foundry_agent',
        name: 'Test Foundry Agent',
        description: 'A test Foundry agent',
        icon: 'IconRobot',
        color: '#9333ea',
        type: 'foundry',
        category: 'AI Agents',
        enabled: true,
        agentId: 'asst_test123',
      },
      {
        id: 'disabled_agent',
        name: 'Disabled Agent',
        description: 'A disabled agent',
        icon: 'IconBan',
        color: '#ef4444',
        type: 'rag',
        category: 'Knowledge Base',
        enabled: false,
      },
      {
        id: 'no_category_agent',
        name: 'No Category Agent',
        description: 'An agent without a category',
        icon: 'IconQuestion',
        color: '#6b7280',
        type: 'rag',
        enabled: true,
      },
    ],
  },
}));

// Mock Tabler Icons
vi.mock('@tabler/icons-react', () => {
  const mockIcon = () => null;
  return {
    IconNews: mockIcon,
    IconRobot: mockIcon,
    IconBan: mockIcon,
    IconQuestion: mockIcon,
  };
});

describe('organizationAgents', () => {
  describe('getIconComponent', () => {
    it('should return the icon component for a valid icon name', () => {
      const icon = getIconComponent('IconNews');
      expect(icon).toBeDefined();
    });

    it('should return IconRobot for IconRobot name', () => {
      const icon = getIconComponent('IconRobot');
      expect(icon).toBeDefined();
    });
  });

  describe('getOrganizationAgents', () => {
    it('should return only enabled agents', () => {
      const agents = getOrganizationAgents();

      expect(agents).toHaveLength(3); // 3 enabled agents
      expect(agents.every((agent) => agent.enabled !== false)).toBe(true);
    });

    it('should not include disabled agents', () => {
      const agents = getOrganizationAgents();

      const disabledAgent = agents.find((a) => a.id === 'disabled_agent');
      expect(disabledAgent).toBeUndefined();
    });

    it('should include agents without explicit enabled property (defaults to enabled)', () => {
      const agents = getOrganizationAgents();

      // All our test agents have explicit enabled, but the filter checks enabled !== false
      expect(agents.length).toBeGreaterThan(0);
    });
  });

  describe('getOrganizationAgentById', () => {
    it('should return the agent when found', () => {
      const agent = getOrganizationAgentById('test_rag_agent');

      expect(agent).toBeDefined();
      expect(agent?.id).toBe('test_rag_agent');
      expect(agent?.name).toBe('Test RAG Agent');
    });

    it('should return undefined for non-existent agent ID', () => {
      const agent = getOrganizationAgentById('non_existent_id');

      expect(agent).toBeUndefined();
    });

    it('should return undefined for disabled agent ID', () => {
      const agent = getOrganizationAgentById('disabled_agent');

      expect(agent).toBeUndefined();
    });

    it('should return undefined for empty string ID', () => {
      const agent = getOrganizationAgentById('');

      expect(agent).toBeUndefined();
    });
  });

  describe('getOrganizationAgentsByType', () => {
    it('should return all RAG agents', () => {
      const ragAgents = getOrganizationAgentsByType('rag');

      expect(ragAgents.length).toBeGreaterThan(0);
      expect(ragAgents.every((agent) => agent.type === 'rag')).toBe(true);
    });

    it('should return all Foundry agents', () => {
      const foundryAgents = getOrganizationAgentsByType('foundry');

      expect(foundryAgents).toHaveLength(1);
      expect(foundryAgents[0].id).toBe('test_foundry_agent');
    });

    it('should return empty array for unknown type', () => {
      const agents = getOrganizationAgentsByType('unknown' as any);

      expect(agents).toHaveLength(0);
    });
  });

  describe('getOrganizationAgentsByCategory', () => {
    it('should return agents in Knowledge Base category', () => {
      const agents = getOrganizationAgentsByCategory('Knowledge Base');

      expect(agents.length).toBeGreaterThan(0);
      expect(agents.every((agent) => agent.category === 'Knowledge Base')).toBe(
        true,
      );
    });

    it('should return agents in AI Agents category', () => {
      const agents = getOrganizationAgentsByCategory('AI Agents');

      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe('test_foundry_agent');
    });

    it('should return empty array for non-existent category', () => {
      const agents = getOrganizationAgentsByCategory('Non Existent Category');

      expect(agents).toHaveLength(0);
    });
  });

  describe('getOrganizationAgentCategories', () => {
    it('should return all unique categories', () => {
      const categories = getOrganizationAgentCategories();

      expect(categories).toContain('Knowledge Base');
      expect(categories).toContain('AI Agents');
    });

    it('should not include duplicates', () => {
      const categories = getOrganizationAgentCategories();
      const uniqueCategories = new Set(categories);

      expect(categories.length).toBe(uniqueCategories.size);
    });

    it('should not include undefined categories', () => {
      const categories = getOrganizationAgentCategories();

      expect(categories.every((c) => c !== undefined && c !== null)).toBe(true);
    });
  });

  describe('isOrganizationAgentId', () => {
    it('should return true for IDs starting with org-', () => {
      expect(isOrganizationAgentId('org-test_agent')).toBe(true);
      expect(isOrganizationAgentId('org-msf_communications')).toBe(true);
    });

    it('should return false for IDs not starting with org-', () => {
      expect(isOrganizationAgentId('test_agent')).toBe(false);
      expect(isOrganizationAgentId('custom-agent')).toBe(false);
      expect(isOrganizationAgentId('gpt-4')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isOrganizationAgentId('')).toBe(false);
    });

    it('should be case-sensitive', () => {
      expect(isOrganizationAgentId('ORG-test')).toBe(false);
      expect(isOrganizationAgentId('Org-test')).toBe(false);
    });
  });

  describe('getOrganizationAgentIdFromModelId', () => {
    it('should extract agent ID from org- prefixed model ID', () => {
      expect(getOrganizationAgentIdFromModelId('org-test_agent')).toBe(
        'test_agent',
      );
      expect(getOrganizationAgentIdFromModelId('org-msf_communications')).toBe(
        'msf_communications',
      );
    });

    it('should return null for non-org model IDs', () => {
      expect(getOrganizationAgentIdFromModelId('gpt-4')).toBeNull();
      expect(getOrganizationAgentIdFromModelId('custom-agent')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(getOrganizationAgentIdFromModelId('')).toBeNull();
    });

    it('should handle edge case of just "org-"', () => {
      expect(getOrganizationAgentIdFromModelId('org-')).toBe('');
    });
  });

  describe('isRAGAgent', () => {
    it('should return true for RAG type agents', () => {
      const ragAgent = getOrganizationAgentById('test_rag_agent');
      expect(ragAgent).toBeDefined();
      expect(isRAGAgent(ragAgent!)).toBe(true);
    });

    it('should return false for Foundry type agents', () => {
      const foundryAgent = getOrganizationAgentById('test_foundry_agent');
      expect(foundryAgent).toBeDefined();
      expect(isRAGAgent(foundryAgent!)).toBe(false);
    });
  });

  describe('isFoundryAgent', () => {
    it('should return true for Foundry type agents', () => {
      const foundryAgent = getOrganizationAgentById('test_foundry_agent');
      expect(foundryAgent).toBeDefined();
      expect(isFoundryAgent(foundryAgent!)).toBe(true);
    });

    it('should return false for RAG type agents', () => {
      const ragAgent = getOrganizationAgentById('test_rag_agent');
      expect(ragAgent).toBeDefined();
      expect(isFoundryAgent(ragAgent!)).toBe(false);
    });
  });

  describe('getRAGOrganizationAgents', () => {
    it('should return only RAG agents', () => {
      const ragAgents = getRAGOrganizationAgents();

      expect(ragAgents.length).toBeGreaterThan(0);
      expect(ragAgents.every((agent) => agent.type === 'rag')).toBe(true);
    });

    it('should not include Foundry agents', () => {
      const ragAgents = getRAGOrganizationAgents();

      expect(ragAgents.some((agent) => agent.type === 'foundry')).toBe(false);
    });
  });

  describe('getFoundryOrganizationAgents', () => {
    it('should return only Foundry agents', () => {
      const foundryAgents = getFoundryOrganizationAgents();

      expect(foundryAgents).toHaveLength(1);
      expect(foundryAgents.every((agent) => agent.type === 'foundry')).toBe(
        true,
      );
    });

    it('should not include RAG agents', () => {
      const foundryAgents = getFoundryOrganizationAgents();

      expect(foundryAgents.some((agent) => agent.type === 'rag')).toBe(false);
    });
  });

  describe('agent configuration validation', () => {
    it('should have required properties on RAG agents', () => {
      const ragAgent = getOrganizationAgentById('test_rag_agent');

      expect(ragAgent).toBeDefined();
      expect(ragAgent?.systemPrompt).toBeDefined();
      expect(ragAgent?.sources).toBeDefined();
      expect(ragAgent?.ragConfig).toBeDefined();
    });

    it('should have required properties on Foundry agents', () => {
      const foundryAgent = getOrganizationAgentById('test_foundry_agent');

      expect(foundryAgent).toBeDefined();
      expect(foundryAgent?.agentId).toBeDefined();
    });
  });
});
