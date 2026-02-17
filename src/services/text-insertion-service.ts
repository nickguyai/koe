import { clipboard, Notification } from 'electron';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface InsertionResult {
  success: boolean;
  method: 'paste' | 'clipboard_only';
  error?: string;
}

export interface AppInfo {
  name: string;
  bundleId: string;
  pid: number;
}

export class TextInsertionService {
  private _lastActiveApp: AppInfo | null = null;
  private _capturedAppName: string | null = null;

  /**
   * Copy text to clipboard
   */
  copyToClipboard(text: string): void {
    clipboard.writeText(text);
    console.log(`Copied ${text.length} characters to clipboard`);
  }

  /**
   * Copy text to clipboard only (no focus change or paste)
   */
  copyToClipboardOnly(text: string): InsertionResult {
    if (!text || text.trim().length === 0) {
      this.clearCapturedApp();
      return {
        success: false,
        method: 'clipboard_only',
        error: 'Empty text provided',
      };
    }

    this.copyToClipboard(text);
    this.showClipboardNotification();
    this.clearCapturedApp();
    return {
      success: true,
      method: 'clipboard_only',
    };
  }

  /**
   * Read text from clipboard
   */
  readFromClipboard(): string {
    return clipboard.readText();
  }

  /**
   * Simulate Cmd+V paste using AppleScript
   */
  async simulatePaste(): Promise<boolean> {
    try {
      // Small delay to ensure clipboard is ready
      await new Promise(resolve => setTimeout(resolve, 50));

      // Use AppleScript to simulate Cmd+V
      const script = `
        tell application "System Events"
          keystroke "v" using command down
        end tell
      `;

      await execAsync(`osascript -e '${script}'`);
      console.log('Simulated Cmd+V paste via AppleScript');
      return true;
    } catch (err) {
      console.error('Failed to simulate paste:', err);
      return false;
    }
  }

  /**
   * Insert text at cursor position
   * First restores focus to captured app, copies to clipboard, then simulates paste
   */
  async insert(text: string): Promise<InsertionResult> {
    if (!text || text.trim().length === 0) {
      this.clearCapturedApp();
      return {
        success: false,
        method: 'clipboard_only',
        error: 'Empty text provided',
      };
    }

    // Restore focus to the app that was active before recording
    const focusRestored = await this.restoreFocus();
    if (!focusRestored) {
      console.warn('Could not restore focus to original app, paste may go to wrong window');
    }

    // Copy transcription to clipboard
    this.copyToClipboard(text);

    // Try to simulate paste
    const pasteSuccess = await this.simulatePaste();

    // Clear captured app after insertion attempt
    this.clearCapturedApp();

    if (pasteSuccess) {
      return {
        success: true,
        method: 'paste',
      };
    }

    // Fallback: text is already in clipboard
    this.showClipboardNotification();
    return {
      success: true,
      method: 'clipboard_only',
      error: 'Paste simulation failed, text copied to clipboard',
    };
  }

  /**
   * Show notification that text is in clipboard
   */
  private showClipboardNotification(): void {
    const notification = new Notification({
      title: 'Transcription Ready',
      body: 'Text copied to clipboard. Press Cmd+V to paste.',
    });
    notification.show();
  }

  /**
   * Capture the currently active application using AppleScript
   * Call this BEFORE recording starts to remember where to paste
   */
  async captureActiveApp(): Promise<string | null> {
    try {
      const script = `
        tell application "System Events"
          set frontApp to first application process whose frontmost is true
          return name of frontApp
        end tell
      `;
      const { stdout } = await execAsync(`osascript -e '${script}'`);
      const appName = stdout.trim();
      // Don't capture Koe itself
      if (appName && appName !== 'Koe' && appName !== 'Electron') {
        this._capturedAppName = appName;
        console.log(`Captured active app: ${appName}`);
        return appName;
      }
      return null;
    } catch (err) {
      console.error('Failed to capture active app:', err);
      return null;
    }
  }

  /**
   * Get the last captured app name
   */
  getCapturedApp(): string | null {
    return this._capturedAppName;
  }

  /**
   * Restore focus to a previously captured application
   */
  async restoreFocus(): Promise<boolean> {
    if (!this._capturedAppName) {
      console.log('No captured app to restore focus to');
      return false;
    }

    try {
      const script = `
        tell application "${this._capturedAppName}"
          activate
        end tell
      `;
      await execAsync(`osascript -e '${script}'`);
      console.log(`Restored focus to: ${this._capturedAppName}`);
      // Small delay to ensure focus is restored
      await new Promise(resolve => setTimeout(resolve, 100));
      return true;
    } catch (err) {
      console.error(`Failed to restore focus to ${this._capturedAppName}:`, err);
      return false;
    }
  }

  /**
   * Clear the captured app (call after insertion is complete)
   */
  clearCapturedApp(): void {
    this._capturedAppName = null;
  }
}

// Singleton instance
let textInsertionServiceInstance: TextInsertionService | null = null;

export function getTextInsertionService(): TextInsertionService {
  if (!textInsertionServiceInstance) {
    textInsertionServiceInstance = new TextInsertionService();
  }
  return textInsertionServiceInstance;
}
