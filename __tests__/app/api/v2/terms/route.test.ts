import { GET } from '@/app/api/terms/route';
import { describe, expect, it, vi } from 'vitest';

describe('Terms API Route', () => {
  it('should return terms data with 200 status code', async () => {
    // Call the GET handler (no request parameter needed)
    const response = await GET();

    // Verify the response
    expect(response.status).toBe(200);

    // Parse the response JSON
    const data = await response.json();

    // Verify the structure of the response
    expect(data).toHaveProperty('platformTerms');
    // expect(data).toHaveProperty('privacyPolicy');

    // Verify the platformTerms properties
    // expect(data.platformTerms).toHaveProperty('content');
    expect(data.platformTerms).toHaveProperty('version');
    // expect(data.platformTerms).toHaveProperty('hash');
    expect(data.platformTerms).toHaveProperty('required');
    expect(data.platformTerms.required).toBe(true);

    // Verify the privacyPolicy properties
    // expect(data.privacyPolicy).toHaveProperty('content');
    // expect(data.privacyPolicy).toHaveProperty('version');
    // expect(data.privacyPolicy).toHaveProperty('hash');
    // expect(data.privacyPolicy).toHaveProperty('required');
    // expect(data.privacyPolicy.required).toBe(true);
  });

  it('should return the correct content for terms and privacy policy', async () => {
    // TODO: Change when we get final structure for Terms and Privacy Policy
    const response = await GET();

    const data = await response.json();

    // expect(data.platformTerms.content).toContain('ai.msf.org Terms of Use');

    // expect(data.privacyPolicy.content).toContain('Privacy Policy');
    // expect(data.privacyPolicy.content).toContain('Information We Collect');
    // expect(data.privacyPolicy.content).toContain('How We Use Information');
    // expect(data.privacyPolicy.content).toContain('Information Sharing');
    // expect(data.privacyPolicy.content).toContain('Data Security');
    // expect(data.privacyPolicy.content).toContain('Changes to This Policy');
  });
});
