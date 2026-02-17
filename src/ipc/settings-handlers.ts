import { ipcMain } from 'electron';
import { AppSettings } from '../backend/config-manager';
import { IpcDependencies } from './types';
import { normalizeSpeakerKey } from './utils';

export function registerSettingsHandlers(deps: IpcDependencies): void {
  ipcMain.handle('get-settings', () => {
    const settings = deps.configManager.getSettings();
    const modeMap: Record<string, string> = { live: 'openai', accuracy: 'gemini' };
    const normalized = modeMap[settings.defaultMode] || settings.defaultMode || settings.defaultProvider;
    return {
      ...settings,
      defaultMode: normalized,
      defaultProvider: normalized,
    };
  });

  ipcMain.handle('set-settings', (_event, updates: Partial<AppSettings>) => {
    const modeMap: Record<string, string> = { live: 'openai', accuracy: 'gemini' };
    const next: Partial<AppSettings> = { ...updates };
    const rawMode = updates.defaultMode || updates.defaultProvider;
    if (rawMode) {
      const normalized = modeMap[rawMode] || rawMode;
      next.defaultMode = normalized;
      next.defaultProvider = normalized;
    }
    const updated = deps.configManager.updateSettings(next);
    if (updates.speakerLabels && deps.memoryManager) {
      deps.memoryManager.syncSpeakerLabels(updated.speakerLabels || {});
    }
    return updated;
  });

  ipcMain.handle('speaker-label-remember', (_event, payload: { speakerKey?: string; label?: string }) => {
    const speakerKey = normalizeSpeakerKey(payload?.speakerKey || '');
    const label = String(payload?.label || '').trim();
    if (!speakerKey || !label) {
      throw new Error('speakerKey and label are required');
    }

    const current = deps.configManager.getSettings().speakerLabels || {};
    const nextLabels = {
      ...current,
      [speakerKey]: label,
    };
    const updated = deps.configManager.updateSettings({ speakerLabels: nextLabels });
    if (deps.memoryManager) {
      deps.memoryManager.rememberSpeakerLabel(speakerKey, label);
    }

    return {
      speakerKey,
      label,
      speakerLabels: updated.speakerLabels,
    };
  });
}
