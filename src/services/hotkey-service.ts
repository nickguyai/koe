import { globalShortcut } from 'electron';
import { EventEmitter } from 'events';
import { GlobalKeyboardListener, IGlobalKeyDownMap, IGlobalKeyEvent } from 'keyspy';
import { getConfigService } from '../config/config-service';

export interface HotkeyConfig {
  accelerator: string;  // Electron accelerator format, e.g., "CommandOrControl+Shift+Space"
  enabled: boolean;
}

export const DEFAULT_HOTKEY: HotkeyConfig = {
  accelerator: 'Fn',
  enabled: true,
};

// Preset hotkey options
export const HOTKEY_PRESETS: { name: string; accelerator: string }[] = [
  { name: 'Fn', accelerator: 'Fn' },
  { name: 'F13', accelerator: 'F13' },
  { name: 'Shift+Z', accelerator: 'Shift+Z' },
  { name: 'Ctrl+Space', accelerator: 'Control+Space' },
  { name: 'Cmd+Shift+Space', accelerator: 'CommandOrControl+Shift+Space' },
  { name: 'Ctrl+Option+R', accelerator: 'Control+Alt+R' },
];

export interface HotkeyServiceEvents {
  press: () => void;
  release: () => void;
  error: (error: Error) => void;
}

export class GlobalHotkeyService extends EventEmitter {
  private _config: HotkeyConfig;
  private _isRegistered: boolean = false;
  private _pressCallback: (() => void) | null = null;
  private _releaseCallback: (() => void) | null = null;
  private _keyspy: GlobalKeyboardListener | null = null;
  private _keyspyListener: ((event: IGlobalKeyEvent, down: IGlobalKeyDownMap) => boolean) | null = null;
  private _fnPressed: boolean = false;

  constructor(config?: HotkeyConfig) {
    super();
    this._config = config || { ...DEFAULT_HOTKEY };
  }

  get config(): HotkeyConfig {
    return { ...this._config };
  }

  get isRegistered(): boolean {
    return this._isRegistered;
  }

  /**
   * Register the global hotkey
   * Note: Electron's globalShortcut only supports key-down, not key-up.
   * For push-to-talk, we use a toggle approach or rely on the renderer's keyup.
   */
  register(config?: HotkeyConfig): boolean {
    if (config) {
      this._config = { ...config };
    }

    if (!this._config.enabled) {
      console.log('Hotkey disabled in config');
      return false;
    }

    // Unregister existing hotkey first
    this.unregister();

    try {
      if (GlobalHotkeyService.isFnAccelerator(this._config.accelerator)) {
        this.registerFnHotkey();
        this._isRegistered = true;
        console.log('Hotkey registered: Fn');
        return true;
      }

      const success = globalShortcut.register(this._config.accelerator, () => {
        console.log(`Hotkey pressed: ${this._config.accelerator}`);
        this.emit('press');
        this._pressCallback?.();
      });

      if (success) {
        this._isRegistered = true;
        console.log(`Hotkey registered: ${this._config.accelerator}`);
        return true;
      } else {
        const error = new Error(`Failed to register hotkey: ${this._config.accelerator}`);
        console.error(error.message);
        this.emit('error', error);
        return false;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`Error registering hotkey: ${error.message}`);
      this.emit('error', error);
      return false;
    }
  }

  /**
   * Unregister the current hotkey
   */
  unregister(): void {
    if (this._isRegistered && this._config.accelerator) {
      try {
        if (GlobalHotkeyService.isFnAccelerator(this._config.accelerator)) {
          if (this._keyspy && this._keyspyListener) {
            this._keyspy.removeListener(this._keyspyListener);
          }
          if (this._keyspy) {
            this._keyspy.kill();
          }
          this._keyspy = null;
          this._keyspyListener = null;
          this._fnPressed = false;
        } else {
          globalShortcut.unregister(this._config.accelerator);
        }
        console.log(`Hotkey unregistered: ${this._config.accelerator}`);
      } catch (err) {
        console.warn(`Error unregistering hotkey: ${err}`);
      }
    }
    this._isRegistered = false;
  }

  /**
   * Update hotkey configuration and re-register
   */
  updateConfig(config: Partial<HotkeyConfig>): boolean {
    this._config = { ...this._config, ...config };

    // Save to persistent config
    const configService = getConfigService();
    configService.setHotkey(this._config);

    if (this._config.enabled) {
      return this.register();
    } else {
      this.unregister();
      return true;
    }
  }

  /**
   * Set callback for hotkey press
   */
  onPress(callback: () => void): void {
    this._pressCallback = callback;
  }

  /**
   * Set callback for hotkey release
   * Note: This requires additional handling since globalShortcut doesn't support key-up
   */
  onRelease(callback: () => void): void {
    this._releaseCallback = callback;
  }

  /**
   * Manually trigger release (called from renderer or timeout)
   */
  triggerRelease(): void {
    console.log('Hotkey released (manual trigger)');
    this.emit('release');
    this._releaseCallback?.();
  }

  /**
   * Validate an accelerator string
   */
  static validateAccelerator(accelerator: string): boolean {
    if (GlobalHotkeyService.isFnAccelerator(accelerator)) {
      return true;
    }
    // Basic validation - Electron will throw if invalid
    const validModifiers = ['Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta'];
    const validKeys = [
      // Letters
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
      // Numbers
      ...'0123456789'.split(''),
      // Function keys
      ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
      // Special keys
      'Space', 'Tab', 'Capslock', 'Numlock', 'Scrolllock', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc', 'Plus',
    ];

    const parts = accelerator.split('+').map(p => p.trim());
    if (parts.length === 0) return false;

    const key = parts[parts.length - 1];
    const modifiers = parts.slice(0, -1);

    // Check if key is valid
    if (!validKeys.includes(key) && !validKeys.includes(key.toUpperCase())) {
      return false;
    }

    // Check if all modifiers are valid
    for (const mod of modifiers) {
      if (!validModifiers.includes(mod)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if accelerator conflicts with system shortcuts
   * This is a basic check - some conflicts may not be detectable
   */
  static checkConflicts(accelerator: string): string | null {
    if (GlobalHotkeyService.isFnAccelerator(accelerator)) {
      return null;
    }
    const systemShortcuts: Record<string, string> = {
      'CommandOrControl+Q': 'Quit application',
      'CommandOrControl+W': 'Close window',
      'CommandOrControl+H': 'Hide application',
      'CommandOrControl+M': 'Minimize window',
      'CommandOrControl+Tab': 'Switch applications',
      'CommandOrControl+Space': 'Spotlight search',
      'Control+Space': 'Input source switch',
    };

    // Normalize the accelerator for comparison
    const normalized = accelerator
      .replace(/Cmd/g, 'Command')
      .replace(/Ctrl/g, 'Control')
      .replace(/CmdOrCtrl/g, 'CommandOrControl');

    for (const [shortcut, description] of Object.entries(systemShortcuts)) {
      if (normalized === shortcut) {
        return description;
      }
    }

    return null;
  }

  private static isFnAccelerator(accelerator: string): boolean {
    return accelerator.trim().toLowerCase() === 'fn';
  }

  private registerFnHotkey(): void {
    if (this._keyspy) {
      try {
        this._keyspy.kill();
      } catch {
        // Ignore cleanup errors.
      }
    }

    this._keyspy = new GlobalKeyboardListener({ appName: 'Koe' });
    this._fnPressed = false;

    this._keyspyListener = (event: IGlobalKeyEvent, _down: IGlobalKeyDownMap) => {
      const name = (event.name || event.rawKey?.name || event.rawKey?._nameRaw || '').toString();
      const isFn = name.toUpperCase() === 'FN' || name === 'Function' || event.rawKey?._nameRaw === 'kVK_Function' || event.vKey === 0x3f;

      if (!isFn) {
        return false;
      }

      if (event.state === 'DOWN') {
        if (this._fnPressed) {
          return true;
        }
        this._fnPressed = true;
        console.log('Hotkey pressed: Fn');
        this.emit('press');
        this._pressCallback?.();
      } else if (event.state === 'UP') {
        this._fnPressed = false;
        this.emit('release');
        this._releaseCallback?.();
      }
      return true;
    };

    this._keyspy.addListener(this._keyspyListener).catch((err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`Error registering Fn hotkey: ${error.message}`);
      this.emit('error', error);
      this._isRegistered = false;
    });
  }
}

// Singleton instance
let hotkeyServiceInstance: GlobalHotkeyService | null = null;

export function getHotkeyService(): GlobalHotkeyService {
  if (!hotkeyServiceInstance) {
    hotkeyServiceInstance = new GlobalHotkeyService();
  }
  return hotkeyServiceInstance;
}
