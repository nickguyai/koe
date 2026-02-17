import Store from 'electron-store';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { HotkeyConfig, DEFAULT_HOTKEY } from '../hotkey-service';

export interface AppConfig {
  hotkey: HotkeyConfig;
  insertionMethod: 'paste' | 'clipboard_only';
  showFloatingIndicator: boolean;
  minRecordingDuration: number;  // ms, default 200
  meetingDetectionEnabled: boolean;
  meetingPromptDismissedApps: Record<string, boolean>;
}

const DEFAULT_CONFIG: AppConfig = {
  hotkey: DEFAULT_HOTKEY,
  insertionMethod: 'paste',
  showFloatingIndicator: true,
  minRecordingDuration: 200,
  meetingDetectionEnabled: false,
  meetingPromptDismissedApps: {},
};

export class ConfigService {
  private store: Store<AppConfig>;

  constructor() {
    // Migrate config from gammawave-config to koe-config
    ConfigService.migrateFromGammawave();

    this.store = new Store<AppConfig>({
      name: 'koe-config',
      defaults: DEFAULT_CONFIG,
    });

    const currentInsertion = this.store.get('insertionMethod');
    if (!currentInsertion || currentInsertion === 'clipboard_only') {
      this.store.set('insertionMethod', 'paste');
    }

    const currentHotkey = this.store.get('hotkey');
    if (!currentHotkey || currentHotkey.accelerator === 'Shift+Z' || currentHotkey.accelerator === 'F13') {
      this.store.set('hotkey', DEFAULT_HOTKEY);
    }
  }

  /**
   * Load the full configuration
   */
  load(): AppConfig {
    return {
      hotkey: this.getHotkey(),
      insertionMethod: this.store.get('insertionMethod', DEFAULT_CONFIG.insertionMethod),
      showFloatingIndicator: this.store.get('showFloatingIndicator', DEFAULT_CONFIG.showFloatingIndicator),
      minRecordingDuration: this.store.get('minRecordingDuration', DEFAULT_CONFIG.minRecordingDuration),
      meetingDetectionEnabled: this.getMeetingDetectionEnabled(),
      meetingPromptDismissedApps: this.getMeetingPromptDismissedApps(),
    };
  }

  /**
   * Save partial configuration
   */
  save(config: Partial<AppConfig>): void {
    if (config.hotkey !== undefined) {
      this.setHotkey(config.hotkey);
    }
    if (config.insertionMethod !== undefined) {
      this.store.set('insertionMethod', config.insertionMethod);
    }
    if (config.showFloatingIndicator !== undefined) {
      this.store.set('showFloatingIndicator', config.showFloatingIndicator);
    }
    if (config.minRecordingDuration !== undefined) {
      this.store.set('minRecordingDuration', config.minRecordingDuration);
    }
    if (config.meetingDetectionEnabled !== undefined) {
      this.store.set('meetingDetectionEnabled', Boolean(config.meetingDetectionEnabled));
    }
    if (config.meetingPromptDismissedApps !== undefined) {
      this.store.set('meetingPromptDismissedApps', config.meetingPromptDismissedApps);
    }
  }

  /**
   * Get hotkey configuration
   */
  getHotkey(): HotkeyConfig {
    const stored = this.store.get('hotkey');
    if (!stored) return { ...DEFAULT_HOTKEY };
    return {
      accelerator: stored.accelerator || DEFAULT_HOTKEY.accelerator,
      enabled: stored.enabled !== undefined ? stored.enabled : DEFAULT_HOTKEY.enabled,
    };
  }

  /**
   * Set hotkey configuration
   */
  setHotkey(config: HotkeyConfig): void {
    this.store.set('hotkey', config);
  }

  /**
   * Get insertion method
   */
  getInsertionMethod(): 'paste' | 'clipboard_only' {
    return this.store.get('insertionMethod', DEFAULT_CONFIG.insertionMethod);
  }

  /**
   * Set insertion method
   */
  setInsertionMethod(method: 'paste' | 'clipboard_only'): void {
    this.store.set('insertionMethod', method);
  }

  /**
   * Get minimum recording duration
   */
  getMinRecordingDuration(): number {
    return this.store.get('minRecordingDuration', DEFAULT_CONFIG.minRecordingDuration);
  }

  /**
   * Set minimum recording duration
   */
  setMinRecordingDuration(duration: number): void {
    this.store.set('minRecordingDuration', duration);
  }

  /**
   * Get floating indicator visibility
   */
  getShowFloatingIndicator(): boolean {
    return this.store.get('showFloatingIndicator', DEFAULT_CONFIG.showFloatingIndicator);
  }

  /**
   * Set floating indicator visibility
   */
  setShowFloatingIndicator(show: boolean): void {
    this.store.set('showFloatingIndicator', show);
  }

  getMeetingDetectionEnabled(): boolean {
    return this.store.get('meetingDetectionEnabled', DEFAULT_CONFIG.meetingDetectionEnabled);
  }

  setMeetingDetectionEnabled(enabled: boolean): void {
    this.store.set('meetingDetectionEnabled', Boolean(enabled));
  }

  getMeetingPromptDismissedApps(): Record<string, boolean> {
    return { ...(this.store.get('meetingPromptDismissedApps', DEFAULT_CONFIG.meetingPromptDismissedApps) || {}) };
  }

  shouldPromptForMeetingApp(appName: string): boolean {
    const key = this.normalizeMeetingAppName(appName);
    if (!key) {
      return false;
    }
    const dismissed = this.getMeetingPromptDismissedApps();
    return dismissed[key] !== true;
  }

  setMeetingPromptDismissedForApp(appName: string, dismissed: boolean): void {
    const key = this.normalizeMeetingAppName(appName);
    if (!key) {
      return;
    }
    const next = this.getMeetingPromptDismissedApps();
    if (dismissed) {
      next[key] = true;
    } else {
      delete next[key];
    }
    this.store.set('meetingPromptDismissedApps', next);
  }

  private normalizeMeetingAppName(appName: string): string {
    return String(appName || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  /**
   * Reset to defaults
   */
  reset(): void {
    this.store.clear();
  }

  /**
   * Migrate config from old gammawave-config to koe-config.
   * electron-store saves to ~/Library/Application Support/<app>/config.json on macOS.
   * We copy the old file if the new one doesn't exist yet.
   */
  private static migrateFromGammawave(): void {
    try {
      const userData = app.getPath('userData');
      const oldPath = path.join(path.dirname(userData), 'gammawave', 'gammawave-config.json');
      const newPath = path.join(userData, 'koe-config.json');

      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
        fs.copyFileSync(oldPath, newPath);
        console.log(`Migrated config from ${oldPath} to ${newPath}`);
      }
    } catch (err) {
      console.warn('Config migration skipped:', err);
    }
  }
}

// Singleton instance
let configServiceInstance: ConfigService | null = null;

export function getConfigService(): ConfigService {
  if (!configServiceInstance) {
    configServiceInstance = new ConfigService();
  }
  return configServiceInstance;
}
