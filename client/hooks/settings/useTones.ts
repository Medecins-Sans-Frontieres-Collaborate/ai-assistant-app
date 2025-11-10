import { Tone } from '@/types/tone';

import { useSettingsStore } from '../../stores/settingsStore';

export function useTones() {
  const tones = useSettingsStore((state) => state.tones);
  const addTone = useSettingsStore((state) => state.addTone);
  const updateTone = useSettingsStore((state) => state.updateTone);
  const deleteTone = useSettingsStore((state) => state.deleteTone);
  const setTones = useSettingsStore((state) => state.setTones);

  return {
    tones,
    addTone,
    updateTone,
    deleteTone,
    setTones,
  };
}
