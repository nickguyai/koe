import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';


export interface HotkeySettings {
  code: string;
  key?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface AppSettings {
  openaiApiKey: string;
  geminiApiKey: string;
  defaultProvider: string;
  defaultMode: string;
  autoDetectSpeakers: boolean;
  language: string;
  punctuation: boolean;
  timestamps: boolean;
  summaryLength: string;
  maxRecordings: number;
  audioFormat: string;
  geminiModel: string;
  preserveOriginalLanguage: boolean;
  hotkey: HotkeySettings;
  autoPolish: boolean;
  polishStyle: string;
  customPolishPrompt: string;
  customTranscriptionPrompt: string;
  consensusEnabled: boolean;
  consensusMemoryEnabled: boolean;
  meetingCaptureEnabled: boolean;
  meetingNotesModel: string;
  speakerLabels: Record<string, string>;
}

const DEFAULT_HOTKEY: HotkeySettings = {
  code: 'Space',
  key: ' ',
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
};

const DEFAULT_SETTINGS: AppSettings = {
  openaiApiKey: '',
  geminiApiKey: '',
  defaultProvider: 'gemini',
  defaultMode: 'gemini',
  autoDetectSpeakers: true,
  language: 'en',
  punctuation: true,
  timestamps: true,
  summaryLength: 'medium',
  maxRecordings: 100,
  audioFormat: 'wav',
  geminiModel: 'gemini-3-flash-preview',
  preserveOriginalLanguage: true,
  hotkey: { ...DEFAULT_HOTKEY },
  autoPolish: false,
  polishStyle: 'natural',
  customPolishPrompt: '',
  customTranscriptionPrompt: '',
  consensusEnabled: false,
  consensusMemoryEnabled: true,
  meetingCaptureEnabled: false,
  meetingNotesModel: 'gpt-5.2-2025-12-11',
  speakerLabels: {},
};

export class ConfigManager {
  private settingsPath: string;
  private recordingsDir: string;
  private settings: AppSettings;

  constructor() {
    const baseDir = app.getPath('userData');
    this.settingsPath = path.join(baseDir, 'settings.json');
    this.recordingsDir = path.join(baseDir, 'recordings');
    this.settings = this.loadSettings();
  }

  private loadSettings(): AppSettings {
    let fromDisk: Partial<AppSettings> = {};
    if (fs.existsSync(this.settingsPath)) {
      try {
        const raw = fs.readFileSync(this.settingsPath, 'utf-8');
        fromDisk = JSON.parse(raw) as Partial<AppSettings>;
      } catch (err) {
        console.warn('Failed to read settings.json, using defaults:', err);
      }
    }

    const merged: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...fromDisk,
      hotkey: this.sanitizeHotkey(fromDisk.hotkey),
      speakerLabels: this.sanitizeSpeakerLabels(fromDisk.speakerLabels),
    };

    this.saveSettings(merged);
    return merged;
  }

  private saveSettings(settings: AppSettings): void {
    try {
      fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true });
      fs.writeFileSync(this.settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    } catch (err) {
      console.warn('Failed to save settings.json:', err);
    }
  }

  private sanitizeHotkey(hotkey?: Partial<HotkeySettings>): HotkeySettings {
    if (!hotkey) {
      return { ...DEFAULT_HOTKEY };
    }
    return {
      code: String(hotkey.code ?? DEFAULT_HOTKEY.code),
      key: hotkey.key ? String(hotkey.key) : DEFAULT_HOTKEY.key,
      ctrlKey: Boolean(hotkey.ctrlKey ?? DEFAULT_HOTKEY.ctrlKey),
      shiftKey: Boolean(hotkey.shiftKey ?? DEFAULT_HOTKEY.shiftKey),
      altKey: Boolean(hotkey.altKey ?? DEFAULT_HOTKEY.altKey),
      metaKey: Boolean(hotkey.metaKey ?? DEFAULT_HOTKEY.metaKey),
    };
  }

  private sanitizeSpeakerLabels(labels?: Record<string, unknown>): Record<string, string> {
    if (!labels || typeof labels !== 'object') {
      return {};
    }
    const normalized: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(labels)) {
      const key = String(rawKey || '')
        .trim()
        .toLowerCase();
      const value = String(rawValue || '').trim();
      if (!key || !value) {
        continue;
      }
      normalized[key] = value;
    }
    return normalized;
  }

  getSettings(): AppSettings {
    return JSON.parse(JSON.stringify(this.settings)) as AppSettings;
  }

  updateSettings(partial: Partial<AppSettings>): AppSettings {
    const next: AppSettings = {
      ...this.settings,
      ...partial,
    };
    if (partial.hotkey) {
      next.hotkey = this.sanitizeHotkey(partial.hotkey);
    }
    if (partial.speakerLabels) {
      next.speakerLabels = this.sanitizeSpeakerLabels(partial.speakerLabels as unknown as Record<string, unknown>);
    }
    this.settings = next;
    this.saveSettings(this.settings);
    return this.getSettings();
  }

  getApiKey(provider: 'openai' | 'gemini'): string {
    if (provider === 'openai') {
      return this.settings.openaiApiKey || '';
    }
    return this.settings.geminiApiKey || '';
  }

  setApiKey(provider: 'openai' | 'gemini', value: string): void {
    if (provider === 'openai') {
      this.updateSettings({ openaiApiKey: value || '' });
    } else {
      this.updateSettings({ geminiApiKey: value || '' });
    }
  }

  getRecordingsDir(): string {
    fs.mkdirSync(this.recordingsDir, { recursive: true });
    return this.recordingsDir;
  }
}
