import { ipcMain, BrowserWindow } from 'electron';
import { getStateMachine, RecordingState } from './state-machine';
import { getHotkeyService } from './hotkey-service';
import { getTextInsertionService } from './text-insertion-service';
import { getRecordingWidget } from './recording-widget';
import { getPermissionService } from './permission-service';
import { getConfigService } from './config-service';
import { getSystemAudioService, MeetingAppDetectedEvent } from './system-audio-service';

/**
 * Orchestrator connects all services together and manages the recording flow
 */
export class Orchestrator {
  private mainWindow: BrowserWindow | null = null;
  private isRecording: boolean = false;
  private isMeetingModeEnabled: boolean = false;
  private rendererPath: string | null = null;
  private processingTimeout: NodeJS.Timeout | null = null;
  private feedbackTimeout: NodeJS.Timeout | null = null;
  private readonly PROCESSING_TIMEOUT_MS = 30000; // 30 seconds
  private readonly MEETING_PROMPT_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes
  private readonly meetingPromptTimestamps = new Map<string, number>();
  private readonly meetingProcessNames = [
    'zoom.us',
    'zoom',
    'Google Chrome',
    'Google Meet',
    'Microsoft Teams',
    'teams',
  ];
  private meetingDetectionListener: ((event: MeetingAppDetectedEvent) => void) | null = null;
  private meetingDetectionMonitorOperation: Promise<void> = Promise.resolve();

  constructor() {
    this.setupStateMachineListeners();
    this.setupHotkeyListeners();
    this.setupIpcHandlers();
  }

  /**
   * Initialize with main window and renderer path
   */
  initialize(mainWindow: BrowserWindow, rendererPath: string): void {
    this.mainWindow = mainWindow;
    this.rendererPath = rendererPath;
    
    // Listen for renderer crashes and handle gracefully
    this.setupRendererCrashHandling();
  }

  /**
   * Setup handlers for renderer crashes
   */
  private setupRendererCrashHandling(): void {
    if (!this.mainWindow) return;

    this.mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('Renderer process gone:', details.reason);
      this.handleRendererCrash();
    });

    this.mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error('Page failed to load:', errorCode, errorDescription);
    });

    this.mainWindow.webContents.on('crashed', () => {
      console.error('Renderer crashed');
      this.handleRendererCrash();
    });
  }

  /**
   * Handle renderer crash - reset state and try to recover
   */
  private handleRendererCrash(): void {
    const stateMachine = getStateMachine();

    // Reset state
    this.isRecording = false;
    stateMachine.reset();

    // Try to reload the window
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      console.log('Attempting to reload main window...');
      setTimeout(() => {
        if (this.mainWindow && this.rendererPath && !this.mainWindow.isDestroyed()) {
          this.mainWindow.loadFile(this.rendererPath);
        }
      }, 1000);
    }
  }

  /**
   * Start the orchestrator (register hotkeys, check permissions)
   */
  async start(): Promise<void> {
    // Check permissions
    const permissionService = getPermissionService();
    const status = await permissionService.checkAll();

    if (status.microphone !== 'granted') {
      const granted = await permissionService.requestMicrophone();
      if (!granted) {
        permissionService.showPermissionNotification('microphone');
      }
    }

    if (status.accessibility !== 'granted') {
      permissionService.promptAccessibility();
    }

    // Load config and register hotkey
    const configService = getConfigService();
    const hotkeyConfig = configService.getHotkey();
    
    const hotkeyService = getHotkeyService();
    const registered = hotkeyService.register(hotkeyConfig);
    
    if (!registered) {
      console.error('Failed to register global hotkey');
    }

    await this.setMeetingDetectionMonitorEnabled(true);
  }

  /**
   * Stop the orchestrator
   */
  stop(): void {
    const hotkeyService = getHotkeyService();
    hotkeyService.unregister();

    const widget = getRecordingWidget();
    widget.destroy();

    this.clearProcessingTimeout();
    void this.setMeetingDetectionMonitorEnabled(false);
  }

  /**
   * Clear the processing timeout if active
   */
  private clearProcessingTimeout(): void {
    if (this.processingTimeout) {
      clearTimeout(this.processingTimeout);
      this.processingTimeout = null;
    }
    if (this.feedbackTimeout) {
      clearTimeout(this.feedbackTimeout);
      this.feedbackTimeout = null;
    }
  }

  /**
   * Setup state machine event listeners
   */
  private setupStateMachineListeners(): void {
    const stateMachine = getStateMachine();
    const widget = getRecordingWidget();

    stateMachine.on('stateChange', (state: RecordingState, previousState: RecordingState) => {
      console.log(`Orchestrator: State changed from ${previousState} to ${state}`);

      void this.setMeetingDetectionMonitorEnabled(state === 'idle');

      switch (state) {
        case 'recording':
          widget.updateAllWidgets('recording');
          this.startRecordingInRenderer();
          break;

        case 'meeting_recording':
          widget.updateAllWidgets('recording');
          this.startRecordingInRenderer();
          break;

        case 'processing':
          widget.updateAllWidgets('processing');
          this.stopRecordingInRenderer();
          // Start timeout as safety net
          this.clearProcessingTimeout();
          this.processingTimeout = setTimeout(() => {
            if (stateMachine.currentState === 'processing') {
              console.error('Processing timeout - transcription took too long');
              widget.updateAllWidgets('error');
              this.feedbackTimeout = setTimeout(() => {
                if (stateMachine.currentState === 'processing') {
                  widget.updateAllWidgets('idle');
                  stateMachine.transition('error');
                }
              }, 3000);
            }
          }, this.PROCESSING_TIMEOUT_MS);
          break;

        case 'meeting_processing':
          widget.updateAllWidgets('processing');
          this.stopRecordingInRenderer();
          this.clearProcessingTimeout();
          this.processingTimeout = setTimeout(() => {
            if (stateMachine.currentState === 'meeting_processing') {
              console.error('Meeting processing timeout - transcription/notes took too long');
              widget.updateAllWidgets('error');
              this.feedbackTimeout = setTimeout(() => {
                if (stateMachine.currentState === 'meeting_processing') {
                  widget.updateAllWidgets('idle');
                  stateMachine.transition('error');
                }
              }, 3000);
            }
          }, this.PROCESSING_TIMEOUT_MS);
          break;

        case 'inserting':
          this.clearProcessingTimeout();
          // Handled by transcription complete callback
          break;

        case 'idle':
          this.clearProcessingTimeout();
          this.isRecording = false;
          if (previousState !== 'idle') {
            this.resetRendererRecordingState();
          }
          // Skip widget update when coming from inserting or processing —
          // handled by the success/error feedback timeout in the
          // transcription-complete and transcription-error handlers
          if (previousState !== 'inserting' && previousState !== 'processing' && previousState !== 'meeting_processing') {
            widget.updateAllWidgets('idle');
          }
          break;

        case 'error':
          this.clearProcessingTimeout();
          widget.updateAllWidgets('error');
          break;
      }
    });
  }

  /**
   * Setup hotkey event listeners
   */
  private setupHotkeyListeners(): void {
    const hotkeyService = getHotkeyService();
    const stateMachine = getStateMachine();
    const textInsertionService = getTextInsertionService();

    // On hotkey press, start recording
    hotkeyService.onPress(async () => {
      console.log('Orchestrator: Hotkey pressed');

      if (stateMachine.currentState === 'idle') {
        if (!this.isMeetingModeEnabled) {
          // Capture the active app BEFORE recording starts.
          // Needed for paste-back in regular dictation mode.
          await textInsertionService.captureActiveApp();
        }

        stateMachine.transition('hotkey_press');
        this.isRecording = true;
      } else if (stateMachine.currentState === 'recording') {
        stateMachine.transition('hotkey_press');
        this.isRecording = false;
      } else if (stateMachine.currentState === 'meeting_recording') {
        stateMachine.transition('hotkey_press');
        this.isRecording = false;
      } else if (stateMachine.currentState === 'error') {
        console.warn('Orchestrator: Hotkey pressed during error state, resetting');
        stateMachine.reset();
        if (!this.isMeetingModeEnabled) {
          await textInsertionService.captureActiveApp();
        }
        stateMachine.transition('hotkey_press');
        this.isRecording = true;
      } else {
        console.log(`Orchestrator: Hotkey ignored during ${stateMachine.currentState} state`);
      }
    });

    // Note: globalShortcut doesn't support key-up, so we use toggle mode
    // or rely on the renderer to detect key-up and send IPC
  }

  /**
   * Setup IPC handlers for renderer communication
   */
  private setupIpcHandlers(): void {
    const stateMachine = getStateMachine();
    const textInsertionService = getTextInsertionService();
    const configService = getConfigService();

    // Handle widget toggle recording (same flow as hotkey)
    ipcMain.on('widget-toggle-recording', async () => {
      console.log('Orchestrator: Widget toggle recording');

      if (stateMachine.currentState === 'idle') {
        if (!this.isMeetingModeEnabled) {
          await textInsertionService.captureActiveApp();
        }
        stateMachine.transition('hotkey_press');
        this.isRecording = true;
      } else if (stateMachine.currentState === 'recording' || stateMachine.currentState === 'meeting_recording') {
        stateMachine.transition('hotkey_press');
        this.isRecording = false;
      } else {
        console.log(`Orchestrator: Widget click ignored in state ${stateMachine.currentState}`);
      }
    });

    // Handle transcription complete from renderer
    ipcMain.on('transcription-complete', async (_event, text: string) => {
      console.log('Orchestrator: Transcription complete', text?.substring(0, 50));

      if (stateMachine.currentState === 'processing') {
        stateMachine.transition('transcription_complete');

        const insertionMethod = configService.getInsertionMethod();

        const widget = getRecordingWidget();

        if (insertionMethod === 'clipboard_only') {
          const result = textInsertionService.copyToClipboardOnly(text);
          if (result.success) {
            widget.updateAllWidgets('success');
          } else {
            widget.updateAllWidgets('error');
          }
        } else {
          const result = await textInsertionService.insert(text);
          if (result.success) {
            widget.updateAllWidgets('success');
          } else {
            widget.updateAllWidgets('error');
          }
        }

        // Show success/error feedback for 2s, then transition to idle
        this.feedbackTimeout = setTimeout(() => {
          if (stateMachine.currentState === 'inserting') {
            widget.updateAllWidgets('idle');
            stateMachine.transition('insertion_complete');
          }
        }, 2000);
      } else if (stateMachine.currentState === 'meeting_processing') {
        const widget = getRecordingWidget();
        widget.updateAllWidgets('success');

        this.feedbackTimeout = setTimeout(() => {
          if (stateMachine.currentState === 'meeting_processing') {
            widget.updateAllWidgets('idle');
            stateMachine.transition('notes_complete');
          }
        }, 1500);
      }
    });

    // Handle transcription error from renderer
    ipcMain.on('transcription-error', (_event, error: string) => {
      console.error('Orchestrator: Transcription error', error);

      const widget = getRecordingWidget();
      widget.updateAllWidgets('error');

      // Show error feedback for 3s, then transition to idle
      this.feedbackTimeout = setTimeout(() => {
        if (stateMachine.currentState === 'processing' || stateMachine.currentState === 'meeting_processing') {
          widget.updateAllWidgets('idle');
          stateMachine.transition('error');
        }
      }, 3000);
    });

    // Handle hotkey release from renderer (for push-to-talk mode)
    ipcMain.on('hotkey-release', () => {
      console.log('Orchestrator: Hotkey release from renderer');
      
      if (stateMachine.currentState === 'recording') {
        stateMachine.transition('hotkey_release');
        this.isRecording = false;
      }
    });

    // Handle recording state query
    ipcMain.handle('get-recording-state', () => {
      return {
        state: stateMachine.currentState,
        isRecording: this.isRecording,
        duration: stateMachine.getRecordingDuration(),
      };
    });

    // Handle hotkey config update
    ipcMain.handle('update-hotkey', (_event, accelerator: string) => {
      const hotkeyService = getHotkeyService();
      return hotkeyService.updateConfig({ accelerator, enabled: true });
    });

    // Handle get current hotkey
    ipcMain.handle('get-hotkey', () => {
      const configService = getConfigService();
      return configService.getHotkey();
    });

    ipcMain.handle('set-meeting-mode', async (_event, enabled: boolean) => {
      this.isMeetingModeEnabled = Boolean(enabled);
      stateMachine.setMeetingMode(this.isMeetingModeEnabled);
      const widget = getRecordingWidget();
      widget.setMeetingMode(this.isMeetingModeEnabled);
      if (this.isMeetingModeEnabled) {
        configService.setMeetingDetectionEnabled(true);
        await this.setMeetingDetectionMonitorEnabled(false);
      } else {
        await this.setMeetingDetectionMonitorEnabled(true);
      }
      return this.isMeetingModeEnabled;
    });

    ipcMain.handle('get-meeting-mode', () => {
      return this.isMeetingModeEnabled;
    });

    ipcMain.handle(
      'meeting-mode-suggestion-dismiss',
      async (_event, payload: { appName?: string; dontAskAgain?: boolean }) => {
        const appName = String(payload?.appName || '').trim();
        const dontAskAgain = Boolean(payload?.dontAskAgain);
        if (appName && dontAskAgain) {
          configService.setMeetingPromptDismissedForApp(appName, true);
        }
        return true;
      },
    );

    ipcMain.handle(
      'meeting-mode-suggestion-switch',
      async (_event, payload: { appName?: string; dontAskAgain?: boolean }) => {
        const appName = String(payload?.appName || '').trim();
        const dontAskAgain = Boolean(payload?.dontAskAgain);
        if (appName && dontAskAgain) {
          configService.setMeetingPromptDismissedForApp(appName, true);
        }

        this.isMeetingModeEnabled = true;
        stateMachine.setMeetingMode(true);
        const widget = getRecordingWidget();
        widget.setMeetingMode(true);
        configService.setMeetingDetectionEnabled(true);
        await this.setMeetingDetectionMonitorEnabled(false);
        this.sendRendererEvent('meeting-mode-updated', { enabled: true, source: 'meeting-detection' });

        return this.isMeetingModeEnabled;
      },
    );
  }

  /**
   * Check if the renderer is ready to receive IPC messages
   */
  private isRendererReady(): boolean {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return false;
    }
    if (!this.mainWindow.webContents || this.mainWindow.webContents.isDestroyed()) {
      return false;
    }
    // Check if page is still loading
    if (this.mainWindow.webContents.isLoading()) {
      console.warn('Renderer is still loading, cannot send IPC');
      return false;
    }
    return true;
  }

  /**
   * Tell the renderer to start recording
   */
  private startRecordingInRenderer(): void {
    try {
      if (this.isRendererReady()) {
        console.log('Sending start-recording to renderer');
        this.mainWindow!.webContents.send('start-recording');
      } else {
        console.warn('Cannot send start-recording: renderer not ready');
        // Reset state since we can't start recording
        const stateMachine = getStateMachine();
        stateMachine.reset();
      }
    } catch (err) {
      console.error('Error sending start-recording:', err);
    }
  }

  /**
   * Tell the renderer to stop recording
   */
  private stopRecordingInRenderer(): void {
    try {
      if (this.isRendererReady()) {
        console.log('Sending stop-recording to renderer');
        this.mainWindow!.webContents.send('stop-recording');
      } else {
        console.warn('Cannot send stop-recording: renderer not ready');
      }
    } catch (err) {
      console.error('Error sending stop-recording:', err);
    }
  }

  /**
   * Tell the renderer to reset local recording state
   */
  private resetRendererRecordingState(): void {
    try {
      if (this.isRendererReady()) {
        console.log('Sending reset-recording-state to renderer');
        this.mainWindow!.webContents.send('reset-recording-state');
      } else {
        console.warn('Cannot send reset-recording-state: renderer not ready');
      }
    } catch (err) {
      console.error('Error sending reset-recording-state:', err);
    }
  }

  private async setMeetingDetectionMonitorEnabled(enabled: boolean): Promise<void> {
    this.meetingDetectionMonitorOperation = this.meetingDetectionMonitorOperation
      .then(async () => {
        if (enabled) {
          await this.startMeetingDetectionMonitor();
        } else {
          await this.stopMeetingDetectionMonitor();
        }
      })
      .catch((err) => {
        console.warn('Meeting detection monitor operation failed:', err);
      });

    return this.meetingDetectionMonitorOperation;
  }

  private async startMeetingDetectionMonitor(): Promise<void> {
    if (this.isMeetingModeEnabled || this.isRecording) {
      return;
    }

    const configService = getConfigService();
    if (!configService.getMeetingDetectionEnabled()) {
      return;
    }

    const service = getSystemAudioService();

    if (!this.meetingDetectionListener) {
      this.meetingDetectionListener = (event: MeetingAppDetectedEvent) => {
        this.handleMeetingAppDetected(event);
      };
      service.on('meeting-app-detected', this.meetingDetectionListener);
    }

    if (service.currentStatus === 'recording') {
      return;
    }
    if (service.currentStatus === 'unsupported') {
      return;
    }

    try {
      const permissionStatus = await getPermissionService().checkSystemAudioPermission();
      if (permissionStatus !== 'granted') {
        return;
      }

      await service.start({
        sampleRate: 24000,
        includeProcessNames: this.meetingProcessNames,
      });
    } catch (err) {
      console.warn('Failed to start meeting detection monitor:', err);
    }
  }

  private async stopMeetingDetectionMonitor(): Promise<void> {
    const service = getSystemAudioService();

    if (this.meetingDetectionListener) {
      const detachableService = service as typeof service & {
        off?: (event: string, listener: (event: MeetingAppDetectedEvent) => void) => void;
        removeListener?: (event: string, listener: (event: MeetingAppDetectedEvent) => void) => void;
      };
      if (typeof detachableService.off === 'function') {
        detachableService.off('meeting-app-detected', this.meetingDetectionListener);
      } else if (typeof detachableService.removeListener === 'function') {
        detachableService.removeListener('meeting-app-detected', this.meetingDetectionListener);
      }
      this.meetingDetectionListener = null;
    }

    if (service.currentStatus !== 'recording') {
      return;
    }
    try {
      await service.stop();
    } catch (err) {
      console.warn('Failed to stop meeting detection monitor:', err);
    }
  }

  private handleMeetingAppDetected(event: MeetingAppDetectedEvent): void {
    const appName = String(event?.appName || event?.processName || '').trim();
    if (!appName) {
      return;
    }

    const stateMachine = getStateMachine();
    if (stateMachine.currentState !== 'idle' || this.isRecording || this.isMeetingModeEnabled) {
      return;
    }

    const configService = getConfigService();
    if (!configService.shouldPromptForMeetingApp(appName)) {
      return;
    }

    const appKey = appName.toLowerCase();
    const now = Date.now();
    const lastPromptAt = this.meetingPromptTimestamps.get(appKey) || 0;
    if (now - lastPromptAt < this.MEETING_PROMPT_COOLDOWN_MS) {
      return;
    }
    this.meetingPromptTimestamps.set(appKey, now);

    this.sendRendererEvent('meeting-mode-suggestion', {
      appName,
      processName: event.processName,
      detectedAt: event.detectedAt,
      message: 'Looks like a meeting is starting. Switch to Meeting Capture?',
    });
  }

  private sendRendererEvent(channel: string, payload: Record<string, unknown>): void {
    const mainWindow = this.mainWindow;
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    const webContents = mainWindow.webContents;
    if (!webContents || webContents.isDestroyed()) {
      return;
    }
    if (webContents.isLoading()) {
      console.warn(`Renderer is still loading, cannot send IPC event: ${channel}`);
      return;
    }
    webContents.send(channel, payload);
  }
}

// Singleton instance
let orchestratorInstance: Orchestrator | null = null;

export function getOrchestrator(): Orchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new Orchestrator();
  }
  return orchestratorInstance;
}
