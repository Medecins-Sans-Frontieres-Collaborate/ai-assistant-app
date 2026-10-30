import { useSettingsStore } from '@/client/stores/settingsStore';
import { describe, expect, it } from 'vitest';

const skill = {
  id: 'report',
  name: 'Report',
  description: 'Weekly report',
  instructions: 'Summarize progress',
  activation: 'auto' as const,
  enabled: true,
};
describe('personal skill storage', () => {
  it('persists personal skills with the browser settings payload', () => {
    useSettingsStore.getState().setUserSkills([skill]);
    const options = useSettingsStore.persist.getOptions();
    expect(options.version).toBe(72);
    expect(options.partialize!(useSettingsStore.getState())).toHaveProperty(
      'userSkills',
      [skill],
    );
  });
  it('migrates earlier settings without inventing personal content', async () => {
    const migrate = useSettingsStore.persist.getOptions().migrate!;
    const result = (await migrate({ prompts: [] }, 70)) as {
      userSkills: unknown[];
    };
    expect(result.userSkills).toEqual([]);
  });
  it('keeps valid imported skills beside corrupt persisted entries', async () => {
    const migrate = useSettingsStore.persist.getOptions().migrate!;
    const result = (await migrate(
      { userSkills: [skill, null, skill] },
      70,
    )) as { userSkills: unknown[] };
    expect(result.userSkills).toEqual([skill]);
  });
});
