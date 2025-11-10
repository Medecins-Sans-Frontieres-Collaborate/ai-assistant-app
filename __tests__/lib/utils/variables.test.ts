import {
  VariableDefinition,
  getVariableDefinitions,
  parseVariableDefinition,
  parseVariables,
  replaceVariables,
  replaceVariablesWithMap,
} from '@/lib/utils/chat/variables';

import { describe, expect, it } from 'vitest';

describe('Variable Parsing and Replacement', () => {
  describe('parseVariableDefinition', () => {
    it('parses required variable without default', () => {
      const result = parseVariableDefinition('recipient');
      expect(result).toEqual({
        name: 'recipient',
        defaultValue: undefined,
        isOptional: false,
      });
    });

    it('parses optional variable with default value', () => {
      const result = parseVariableDefinition('language:English');
      expect(result).toEqual({
        name: 'language',
        defaultValue: 'English',
        isOptional: true,
      });
    });

    it('parses variable with default containing spaces', () => {
      const result = parseVariableDefinition('tone:very professional');
      expect(result).toEqual({
        name: 'tone',
        defaultValue: 'very professional',
        isOptional: true,
      });
    });

    it('handles variable with colon in default value', () => {
      const result = parseVariableDefinition('time:12:30 PM');
      expect(result).toEqual({
        name: 'time',
        defaultValue: '12:30 PM',
        isOptional: true,
      });
    });

    it('trims whitespace from name and default value', () => {
      const result = parseVariableDefinition('  name  :  John Doe  ');
      expect(result).toEqual({
        name: 'name',
        defaultValue: 'John Doe',
        isOptional: true,
      });
    });

    it('handles boolean-like defaults', () => {
      const result = parseVariableDefinition('includeGreeting:true');
      expect(result).toEqual({
        name: 'includeGreeting',
        defaultValue: 'true',
        isOptional: true,
      });
    });
  });

  describe('parseVariables', () => {
    it('extracts variable names from content', () => {
      const content = 'Hello {{name}}, welcome to {{place}}!';
      const result = parseVariables(content);
      expect(result).toEqual(['name', 'place']);
    });

    it('extracts variable names ignoring defaults', () => {
      const content = 'Hello {{name}}, language is {{lang:English}}!';
      const result = parseVariables(content);
      expect(result).toEqual(['name', 'lang']);
    });

    it('handles duplicate variables', () => {
      const content = '{{name}} and {{age}}, {{name}} again';
      const result = parseVariables(content);
      expect(result).toEqual(['name', 'age', 'name']); // parseVariables doesn't deduplicate
    });

    it('returns empty array for content without variables', () => {
      const content = 'Hello world!';
      const result = parseVariables(content);
      expect(result).toEqual([]);
    });

    it('handles multiple variables with defaults', () => {
      const content =
        'Email to {{recipient}} in {{language:English}} with {{tone:professional}} tone';
      const result = parseVariables(content);
      expect(result).toEqual(['recipient', 'language', 'tone']);
    });
  });

  describe('getVariableDefinitions', () => {
    it('extracts variable definitions with defaults', () => {
      const content = 'Hello {{name}}, language is {{lang:English}}!';
      const result = getVariableDefinitions(content);
      expect(result).toEqual([
        {
          name: 'name',
          defaultValue: undefined,
          isOptional: false,
        },
        {
          name: 'lang',
          defaultValue: 'English',
          isOptional: true,
        },
      ]);
    });

    it('deduplicates variables', () => {
      const content = '{{name}} and {{age}}, {{name}} again';
      const result = getVariableDefinitions(content);
      expect(result).toHaveLength(2);
      expect(result.map((v) => v.name)).toEqual(['name', 'age']);
    });

    it('handles complex content with multiple variable types', () => {
      const content = `
        Write a {{tone:professional}} email to {{recipient}} about {{topic}}.
        Use {{language:English}} language and {{includeGreeting:true}} for greeting.
        CC: {{ccRecipient}}
      `;
      const result = getVariableDefinitions(content);
      expect(result).toHaveLength(6);

      const toneVar = result.find((v) => v.name === 'tone');
      expect(toneVar).toEqual({
        name: 'tone',
        defaultValue: 'professional',
        isOptional: true,
      });

      const recipientVar = result.find((v) => v.name === 'recipient');
      expect(recipientVar).toEqual({
        name: 'recipient',
        defaultValue: undefined,
        isOptional: false,
      });
    });

    it('returns empty array for content without variables', () => {
      const content = 'Plain text without any variables';
      const result = getVariableDefinitions(content);
      expect(result).toEqual([]);
    });
  });

  describe('replaceVariables (array-based)', () => {
    it('replaces required variables with provided values', () => {
      const content = 'Hello {{name}}, you are {{age}} years old';
      const variables = ['name', 'age'];
      const values = ['Alice', '25'];
      const result = replaceVariables(content, variables, values);
      expect(result).toBe('Hello Alice, you are 25 years old');
    });

    it('uses default value when value is empty', () => {
      const content = 'Language: {{language:English}}';
      const variables = ['language'];
      const values = [''];
      const result = replaceVariables(content, variables, values);
      expect(result).toBe('Language: English');
    });

    it('overrides default value when value is provided', () => {
      const content = 'Language: {{language:English}}';
      const variables = ['language'];
      const values = ['Spanish'];
      const result = replaceVariables(content, variables, values);
      expect(result).toBe('Language: Spanish');
    });

    it('keeps variable unchanged if no value and no default', () => {
      const content = 'Hello {{name}}';
      const variables = ['other'];
      const values = ['value'];
      const result = replaceVariables(content, variables, values);
      expect(result).toBe('Hello {{name}}');
    });

    it('handles mixed required and optional variables', () => {
      const content =
        'Email {{recipient}} in {{language:English}} with {{tone:professional}} tone';
      const variables = ['recipient', 'language', 'tone'];
      const values = ['john@example.com', '', 'casual'];
      const result = replaceVariables(content, variables, values);
      expect(result).toBe('Email john@example.com in English with casual tone');
    });

    it('handles multiple occurrences of same variable', () => {
      const content = '{{name}} is great! I really like {{name}}.';
      const variables = ['name'];
      const values = ['Alice'];
      const result = replaceVariables(content, variables, values);
      expect(result).toBe('Alice is great! I really like Alice.');
    });
  });

  describe('replaceVariablesWithMap (map-based)', () => {
    it('replaces variables using variable map', () => {
      const content = 'Hello {{name}}, you are {{age}} years old';
      const variableMap = { name: 'Alice', age: '25' };
      const result = replaceVariablesWithMap(content, variableMap);
      expect(result).toBe('Hello Alice, you are 25 years old');
    });

    it('uses default value when variable not in map', () => {
      const content = 'Language: {{language:English}}';
      const variableMap = {};
      const result = replaceVariablesWithMap(content, variableMap);
      expect(result).toBe('Language: English');
    });

    it('uses default value when value is empty string', () => {
      const content = 'Language: {{language:English}}';
      const variableMap = { language: '' };
      const result = replaceVariablesWithMap(content, variableMap);
      expect(result).toBe('Language: English');
    });

    it('overrides default with provided value', () => {
      const content = 'Language: {{language:English}}';
      const variableMap = { language: 'French' };
      const result = replaceVariablesWithMap(content, variableMap);
      expect(result).toBe('Language: French');
    });

    it('keeps variable unchanged if no value and no default', () => {
      const content = 'Hello {{name}}';
      const variableMap = {};
      const result = replaceVariablesWithMap(content, variableMap);
      expect(result).toBe('Hello {{name}}');
    });

    it('handles complex email template scenario', () => {
      const content = `Dear {{recipient}},

Thank you for your {{donationAmount:$100}} donation on {{donationDate}}.

Your generosity supports our work in {{region:global operations}}.

Language: {{language:English}}
Tone: {{tone:professional}}

Best regards,
{{sender:The Team}}`;

      const variableMap = {
        recipient: 'John Doe',
        donationAmount: '$500',
        donationDate: '2025-01-15',
        region: '', // Empty - should use default
        language: 'Spanish', // Override default
        // tone: not provided - should use default
        // sender: not provided - should use default
      };

      const result = replaceVariablesWithMap(content, variableMap);
      expect(result).toContain('Dear John Doe');
      expect(result).toContain('$500 donation');
      expect(result).toContain('2025-01-15');
      expect(result).toContain('global operations'); // default used
      expect(result).toContain('Language: Spanish'); // override
      expect(result).toContain('Tone: professional'); // default used
      expect(result).toContain('The Team'); // default used
    });

    it('handles variables with special characters in defaults', () => {
      const content = 'Format: {{format:JSON {"key": "value"}}}';
      const variableMap = {};
      const result = replaceVariablesWithMap(content, variableMap);
      expect(result).toBe('Format: JSON {"key": "value"}');
    });

    it('handles boolean-like default values', () => {
      const content =
        'Include greeting: {{includeGreeting:true}}, Include signature: {{includeSignature:false}}';
      const variableMap = { includeGreeting: 'false' };
      const result = replaceVariablesWithMap(content, variableMap);
      expect(result).toBe('Include greeting: false, Include signature: false');
    });
  });

  describe('Real-world scenario: Donation email template', () => {
    const donationEmailTemplate = `Dear {{donorName}},

Thank you for your generous donation of {{donationAmount}} {{currencySymbol:$}} on {{donationDate}}.

Your gift of type: {{giftType:one-time}} has been designated as: {{designation:unrestricted}}.

This donation supports our work in {{countryOrRegion:global operations}}, specifically focusing on {{operationsFocus:emergency medical care}}.

We operate in {{countriesCount:70+}} countries, guided by our core values: {{brandValues:humanity, independence, impartiality}}.

Language: {{language:English}}
Format: {{includeHTML:false}}
Length: {{length:standard}}

Best regards,
The Team`;

    it('handles all required variables filled', () => {
      const variableMap = {
        donorName: 'Jane Smith',
        donationAmount: '250',
        donationDate: '2025-11-04',
      };

      const result = replaceVariablesWithMap(
        donationEmailTemplate,
        variableMap,
      );

      expect(result).toContain('Dear Jane Smith');
      expect(result).toContain('donation of 250 $'); // default currency
      expect(result).toContain('2025-11-04');
      expect(result).toContain('type: one-time'); // default
      expect(result).toContain('global operations'); // default
      expect(result).toContain('emergency medical care'); // default
      expect(result).toContain('70+ countries'); // default
      expect(result).toContain('humanity, independence, impartiality'); // default
      expect(result).toContain('Language: English'); // default
    });

    it('handles mixed required and optional with overrides', () => {
      const variableMap = {
        donorName: 'John Doe',
        donationAmount: '1000',
        currencySymbol: '€',
        donationDate: '2025-11-04',
        giftType: 'monthly',
        designation: 'restricted Medical Supplies Program',
        countryOrRegion: 'Sub-Saharan Africa',
        language: 'French',
        includeHTML: 'true',
      };

      const result = replaceVariablesWithMap(
        donationEmailTemplate,
        variableMap,
      );

      expect(result).toContain('Dear John Doe');
      expect(result).toContain('donation of 1000 €'); // overridden
      expect(result).toContain('type: monthly'); // overridden
      expect(result).toContain('restricted Medical Supplies Program'); // overridden
      expect(result).toContain('Sub-Saharan Africa'); // overridden
      expect(result).toContain('emergency medical care'); // default (not overridden)
      expect(result).toContain('Language: French'); // overridden
      expect(result).toContain('Format: true'); // overridden
      expect(result).toContain('Length: standard'); // default
    });

    it('handles missing required variables gracefully', () => {
      const variableMap = {
        donationAmount: '100',
        // donorName missing
        // donationDate missing
      };

      const result = replaceVariablesWithMap(
        donationEmailTemplate,
        variableMap,
      );

      // Required variables without values should remain as-is
      expect(result).toContain('{{donorName}}');
      expect(result).toContain('{{donationDate}}');
      // But provided values should work
      expect(result).toContain('donation of 100');
      // And defaults should still apply
      expect(result).toContain('$'); // default currency
    });

    it('extracts correct variable definitions from template', () => {
      const definitions = getVariableDefinitions(donationEmailTemplate);

      // Check we have the right number of variables
      expect(definitions.length).toBeGreaterThan(0);

      // Check required variables
      const requiredVars = definitions.filter((v) => !v.isOptional);
      expect(requiredVars.map((v) => v.name)).toContain('donorName');
      expect(requiredVars.map((v) => v.name)).toContain('donationAmount');
      expect(requiredVars.map((v) => v.name)).toContain('donationDate');

      // Check optional variables with defaults
      const optionalVars = definitions.filter((v) => v.isOptional);
      expect(optionalVars.length).toBeGreaterThan(0);

      const currencyVar = optionalVars.find((v) => v.name === 'currencySymbol');
      expect(currencyVar?.defaultValue).toBe('$');

      const languageVar = optionalVars.find((v) => v.name === 'language');
      expect(languageVar?.defaultValue).toBe('English');

      const giftTypeVar = optionalVars.find((v) => v.name === 'giftType');
      expect(giftTypeVar?.defaultValue).toBe('one-time');
    });
  });
});
