import { GET } from '@/app/api/terms/route';
import { describe, expect, it } from 'vitest';

describe('GET /api/terms', () => {
  it('returns 200 OK status', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
  });

  it('returns terms data with correct structure', async () => {
    const response = await GET();
    const data = await response.json();

    expect(data).toHaveProperty('platformTerms');
    expect(data.platformTerms).toHaveProperty('localized');
    expect(data.platformTerms).toHaveProperty('version');
    expect(data.platformTerms).toHaveProperty('required');
  });

  it('includes English terms', async () => {
    const response = await GET();
    const data = await response.json();

    expect(data.platformTerms.localized).toHaveProperty('en');
    expect(data.platformTerms.localized.en).toHaveProperty('content');
    expect(data.platformTerms.localized.en).toHaveProperty('hash');
    expect(data.platformTerms.localized.en.content).toContain('ai.msf.org');
  });

  it('includes French terms', async () => {
    const response = await GET();
    const data = await response.json();

    expect(data.platformTerms.localized).toHaveProperty('fr');
    expect(data.platformTerms.localized.fr).toHaveProperty('content');
    expect(data.platformTerms.localized.fr).toHaveProperty('hash');
    expect(data.platformTerms.localized.fr.content).toContain('ai.msf.org');
  });

  it('has valid version number', async () => {
    const response = await GET();
    const data = await response.json();

    expect(data.platformTerms.version).toBeTruthy();
    expect(typeof data.platformTerms.version).toBe('string');
    expect(data.platformTerms.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('marks terms as required', async () => {
    const response = await GET();
    const data = await response.json();

    expect(data.platformTerms.required).toBe(true);
  });

  it('includes content hash for English terms', async () => {
    const response = await GET();
    const data = await response.json();

    const hash = data.platformTerms.localized.en.hash;
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(64); // SHA-256 hex string length
  });

  it('includes content hash for French terms', async () => {
    const response = await GET();
    const data = await response.json();

    const hash = data.platformTerms.localized.fr.hash;
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(64); // SHA-256 hex string length
  });

  it('includes prohibited use cases in English terms', async () => {
    const response = await GET();
    const data = await response.json();
    const content = data.platformTerms.localized.en.content;

    expect(content).toContain('Health care');
    expect(content).toContain('Surveillance');
    expect(content).toContain('Employment-related decisions');
    expect(content).toContain('Automated decision-making');
  });

  it('includes privacy section in English terms', async () => {
    const response = await GET();
    const data = await response.json();
    const content = data.platformTerms.localized.en.content;

    expect(content).toContain('Privacy:');
    expect(content).toContain('Personal data');
    expect(content).toContain('Highly sensitive data');
  });
});
