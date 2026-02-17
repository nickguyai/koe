import { systemPreferences, shell, dialog, Notification } from 'electron';
import * as os from 'os';

export type PermissionState = 'granted' | 'denied' | 'not_determined' | 'restricted' | 'unknown';

export interface PermissionStatus {
  microphone: PermissionState;
  systemAudio: PermissionState;
  accessibility: PermissionState;
}

export class PermissionService {
  /**
   * Check all required permissions
   */
  async checkAll(): Promise<PermissionStatus> {
    return {
      microphone: await this.checkMicrophone(),
      systemAudio: await this.checkSystemAudioPermission(),
      accessibility: this.checkAccessibility(),
    };
  }

  /**
   * Check microphone permission
   */
  async checkMicrophone(): Promise<PermissionState> {
    if (process.platform !== 'darwin') {
      return 'granted'; // Assume granted on non-macOS
    }

    const status = systemPreferences.getMediaAccessStatus('microphone');
    return this.mapMediaStatus(status);
  }

  /**
   * Request microphone permission
   */
  async requestMicrophone(): Promise<boolean> {
    if (process.platform !== 'darwin') {
      return true;
    }

    try {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      return granted;
    } catch (err) {
      console.error('Error requesting microphone permission:', err);
      return false;
    }
  }

  /**
   * Check system audio recording permission.
   * AudioTee requires macOS 14.2+ and system audio capture permission.
   */
  async checkSystemAudioPermission(): Promise<PermissionState> {
    if (process.platform !== 'darwin') {
      return 'granted';
    }

    if (!this.isMacOS14_2OrLater()) {
      return 'restricted';
    }

    try {
      const rawStatus = (systemPreferences as any).getMediaAccessStatus?.('audio');
      if (!rawStatus) {
        return 'unknown';
      }
      return this.mapMediaStatus(String(rawStatus));
    } catch {
      return 'unknown';
    }
  }

  /**
   * Request system audio recording permission.
   */
  async requestSystemAudioPermission(): Promise<boolean> {
    if (process.platform !== 'darwin') {
      return true;
    }

    if (!this.isMacOS14_2OrLater()) {
      return false;
    }

    try {
      const askForMediaAccess = (systemPreferences as any).askForMediaAccess;
      if (typeof askForMediaAccess !== 'function') {
        // Some Electron builds don't expose explicit system-audio permission APIs.
        // Allow capture attempt so native layer can request/fail gracefully.
        return true;
      }
      const granted = await askForMediaAccess.call(systemPreferences, 'audio');
      return Boolean(granted);
    } catch (err) {
      console.error('Error requesting system audio permission:', err);
      return false;
    }
  }

  /**
   * Check accessibility permission (needed for keyboard simulation)
   */
  checkAccessibility(): PermissionState {
    if (process.platform !== 'darwin') {
      return 'granted';
    }

    const trusted = systemPreferences.isTrustedAccessibilityClient(false);
    return trusted ? 'granted' : 'denied';
  }

  /**
   * Prompt for accessibility permission
   * This will show the system dialog asking to add the app to accessibility
   */
  promptAccessibility(): boolean {
    if (process.platform !== 'darwin') {
      return true;
    }

    // This will prompt the user if not already trusted
    return systemPreferences.isTrustedAccessibilityClient(true);
  }

  /**
   * Open System Preferences to Accessibility settings
   */
  openAccessibilitySettings(): void {
    if (process.platform === 'darwin') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    }
  }

  /**
   * Open System Preferences to Microphone settings
   */
  openMicrophoneSettings(): void {
    if (process.platform === 'darwin') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
    }
  }

  /**
   * Open System Preferences to System Audio Recording settings
   */
  openSystemAudioSettings(): void {
    if (process.platform === 'darwin') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture');
    }
  }

  /**
   * Show permission setup dialog
   */
  async showPermissionDialog(status: PermissionStatus): Promise<void> {
    const missingPermissions: string[] = [];

    if (status.microphone !== 'granted') {
      missingPermissions.push('Microphone (for voice recording)');
    }
    if (status.systemAudio !== 'granted') {
      missingPermissions.push('System Audio Recording (for meeting capture of remote participants)');
    }
    if (status.accessibility !== 'granted') {
      missingPermissions.push('Accessibility (for text insertion)');
    }

    if (missingPermissions.length === 0) {
      return;
    }

    const result = await dialog.showMessageBox({
      type: 'info',
      title: 'Permissions Required',
      message: 'Koe needs additional permissions to work properly.',
      detail: `The following permissions are required:\n\n${missingPermissions.map(p => `• ${p}`).join('\n')}\n\nWould you like to open System Preferences to grant these permissions?`,
      buttons: ['Open Settings', 'Later'],
      defaultId: 0,
    });

    if (result.response === 0) {
      // Open the appropriate settings
      if (status.microphone !== 'granted') {
        this.openMicrophoneSettings();
      } else if (status.systemAudio !== 'granted') {
        this.openSystemAudioSettings();
      } else if (status.accessibility !== 'granted') {
        this.openAccessibilitySettings();
      }
    }
  }

  /**
   * Show notification about missing permissions
   */
  showPermissionNotification(permission: 'microphone' | 'system_audio' | 'accessibility'): void {
    const titles: Record<string, string> = {
      microphone: 'Microphone Access Required',
      system_audio: 'System Audio Access Required',
      accessibility: 'Accessibility Access Required',
    };

    const bodies: Record<string, string> = {
      microphone: 'Please grant microphone access in System Preferences to use voice transcription.',
      system_audio: 'Please grant system audio recording access to capture meeting audio from other participants.',
      accessibility: 'Please grant accessibility access in System Preferences to enable text insertion.',
    };

    const notification = new Notification({
      title: titles[permission],
      body: bodies[permission],
    });

    notification.on('click', () => {
      if (permission === 'microphone') {
        this.openMicrophoneSettings();
      } else if (permission === 'system_audio') {
        this.openSystemAudioSettings();
      } else {
        this.openAccessibilitySettings();
      }
    });

    notification.show();
  }

  /**
   * Map Electron media status to our PermissionState
   */
  private mapMediaStatus(status: string): PermissionState {
    switch (status) {
      case 'granted':
        return 'granted';
      case 'denied':
        return 'denied';
      case 'not-determined':
        return 'not_determined';
      case 'restricted':
        return 'restricted';
      default:
        return 'unknown';
    }
  }

  private isMacOS14_2OrLater(): boolean {
    if (process.platform !== 'darwin') {
      return true;
    }

    const [major, minor] = os.release()
      .split('.')
      .map((part) => Number.parseInt(part, 10));
    if (Number.isNaN(major)) {
      return false;
    }
    if (major > 23) {
      return true;
    }
    if (major < 23) {
      return false;
    }
    return !Number.isNaN(minor) && minor >= 2;
  }
}

// Singleton instance
let permissionServiceInstance: PermissionService | null = null;

export function getPermissionService(): PermissionService {
  if (!permissionServiceInstance) {
    permissionServiceInstance = new PermissionService();
  }
  return permissionServiceInstance;
}
