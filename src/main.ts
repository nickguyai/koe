import { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
import { getOrchestrator } from './orchestrator';
import { initRecordingWidget } from './recording-widget';
import { ConfigManager } from './backend/config-manager';
import { GeminiTranscriber } from './backend/gemini-transcriber';
import { TranscriptionJobQueue } from './jobs';
import { OpenAIRealtimeClient } from './backend/openai-realtime';
import { MemoryManager } from './backend/memory-manager';
import { OpenAITranscriber } from './backend/openai-transcriber';
import { SynthesisProcessor } from './backend/synthesis-processor';
import { ConsensusTranscriber } from './backend/consensus-transcriber';
import { MeetingNotesGenerator, NotionMcpService } from './meeting';
import { getSystemAudioService } from './system-audio-service';
import { getPermissionService } from './permission-service';
import { registerAllHandlers } from './ipc';

// Handle EPIPE errors on stdout/stderr to prevent crashes when terminal is closed
process.stdout?.on('error', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
    return;
  }
  console.error('stdout error:', err);
});

process.stderr?.on('error', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
    return;
  }
});

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isAppQuitting = false;

let configManager: ConfigManager | null = null;
let geminiTranscriber: GeminiTranscriber | null = null;
let jobQueue: TranscriptionJobQueue | null = null;
let openAIClient: OpenAIRealtimeClient | null = null;
let meetingNotesGenerator: MeetingNotesGenerator | null = null;
let memoryManager: MemoryManager | null = null;
let notionMcpService: NotionMcpService | null = null;
let realtimeMeetingMode = false;
// Queue of system audio chunks for synchronized mixing with mic audio.
// Using a queue instead of a single pointer prevents temporal misalignment:
// - Single pointer causes duplication (same chunk mixed into multiple mic frames)
// - Single pointer causes drops (intermediate chunks overwritten before mixing)
const systemAudioQueue: Buffer[] = [];
const MAX_SYSTEM_AUDIO_QUEUE_SIZE = 10; // ~400ms of audio at 24kHz with 960-sample chunks
let systemAudioListenersBound = false;

function bindSystemAudioEvents(): void {
  if (systemAudioListenersBound) {
    return;
  }
  const systemAudio = getSystemAudioService();
  systemAudio.on('audio-data', (chunk: Buffer) => {
    systemAudioQueue.push(chunk);
    // Limit queue size to prevent unbounded memory growth if mic events lag
    while (systemAudioQueue.length > MAX_SYSTEM_AUDIO_QUEUE_SIZE) {
      systemAudioQueue.shift();
    }
  });
  systemAudio.on('status', (status: string) => {
    sendRealtimeEvent({ type: 'system_audio_status', status });
  });
  systemAudio.on('error', (err: Error) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[SystemAudio] Error, clearing audio queue:', message);
    systemAudioQueue.length = 0;
    sendRealtimeEvent({ type: 'system_audio_error', content: message });
  });
  systemAudio.on('recovery-scheduled', (info: { attempt: number; maxAttempts: number; delayMs: number }) => {
    sendRealtimeEvent({ type: 'system_audio_recovering', ...info });
  });
  systemAudio.on('recovery-succeeded', () => {
    sendRealtimeEvent({ type: 'system_audio_recovered' });
  });
  systemAudio.on('recovery-failed', () => {
    sendRealtimeEvent({ type: 'system_audio_recovery_failed' });
  });
  systemAudioListenersBound = true;
}

async function startSystemAudioCapture(): Promise<boolean> {
  bindSystemAudioEvents();

  const permissionService = getPermissionService();
  let permission = await permissionService.checkSystemAudioPermission();
  if (permission !== 'granted' && permission !== 'unknown') {
    const granted = await permissionService.requestSystemAudioPermission();
    if (granted) {
      permission = 'granted';
    }
  }

  if (permission !== 'granted' && permission !== 'unknown') {
    sendRealtimeEvent({ type: 'system_audio_permission', status: permission });
    return false;
  }

  const systemAudio = getSystemAudioService();
  const started = await systemAudio.start({ sampleRate: 24000 });
  if (!started) {
    sendRealtimeEvent({ type: 'system_audio_permission', status: 'unavailable' });
  } else if (realtimeMeetingMode) {
    systemAudio.enableRecovery();
  }
  return started;
}

async function stopSystemAudioCapture(): Promise<void> {
  systemAudioQueue.length = 0;
  const systemAudio = getSystemAudioService();
  systemAudio.disableRecovery();
  await systemAudio.stop();
}

function getRendererPath(): string {
  return path.join(__dirname, '..', 'assets', 'realtime.html');
}

function sendRealtimeEvent(payload: Record<string, unknown>): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('openai-realtime-event', payload);
}

async function generateMeetingNotesInBackground(jobId: string, transcriptText: string): Promise<void> {
  if (!meetingNotesGenerator || !jobQueue) {
    return;
  }

  try {
    const notes = await meetingNotesGenerator.generate(transcriptText);
    const updated = jobQueue.updateMeetingNotes(jobId, notes);
    sendRealtimeEvent({
      type: 'meeting_notes_ready',
      jobId,
      meetingNotes: updated.meeting_notes,
      updatedAt: updated.updated_at,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Meeting notes generation failed for job ${jobId}:`, message);
    sendRealtimeEvent({
      type: 'meeting_notes_failed',
      jobId,
      content: message,
    });
  }
}

// Create the main window (hidden by default for menu bar app)
function createWindow(): void {
  const rendererPath = getRendererPath();
  mainWindow = new BrowserWindow({
    width: 800,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
    titleBarStyle: 'hiddenInset',
    show: true,
    skipTaskbar: false,
  });

  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowedPermissions = ['media', 'mediaKeySystem', 'audioCapture', 'clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'];
    if (allowedPermissions.includes(permission)) {
      console.log(`Permission granted: ${permission}`);
      callback(true);
    } else {
      console.log(`Permission denied: ${permission}`);
      callback(false);
    }
  });

  mainWindow.webContents.session.setPermissionCheckHandler((_webContents, permission) => {
    const allowedPermissions = ['media', 'mediaKeySystem', 'audioCapture', 'clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'];
    return allowedPermissions.includes(permission);
  });

  console.log('Preload script path:', path.join(__dirname, 'preload.js'));

  mainWindow.webContents.session.clearCache().then(() => {
    console.log('Cache cleared');
    mainWindow!.loadFile(rendererPath);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('Main window finished loading');
  });

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    console.log(`Renderer [${level}]: ${message}`);
  });

  mainWindow.on('close', (event) => {
    if (!isAppQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      // Keep dock icon visible when window is hidden
      app.dock?.show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Create the menu bar tray icon
function createTray(): void {
  const iconPath = path.join(__dirname, '..', 'assets', 'trayIcon.png');
  let icon: Electron.NativeImage;

  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      icon = createDefaultTrayIcon();
    }
  } catch {
    icon = createDefaultTrayIcon();
  }

  icon = icon.resize({ width: 22, height: 22 });
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('Koe - Fn to record');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Window',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    {
      label: 'Start Recording (Fn)',
      click: () => {
        mainWindow?.webContents.send('start-recording');
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isAppQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
      app.dock?.show();
    } else {
      mainWindow?.show();
      mainWindow?.focus();
    }
  });
}

function createDefaultTrayIcon(): Electron.NativeImage {
  return nativeImage.createEmpty();
}

app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
app.commandLine.appendSwitch('enable-speech-dispatcher');

app.whenReady().then(async () => {
  configManager = new ConfigManager();
  geminiTranscriber = new GeminiTranscriber(configManager);
  meetingNotesGenerator = new MeetingNotesGenerator(configManager);
  notionMcpService = new NotionMcpService();

  // Initialize consensus transcription services
  memoryManager = new MemoryManager(configManager);
  const openAITranscriber = new OpenAITranscriber(configManager);
  const synthesisProcessor = new SynthesisProcessor(configManager);
  const consensusTranscriber = new ConsensusTranscriber(configManager, openAITranscriber, synthesisProcessor, memoryManager);

  jobQueue = new TranscriptionJobQueue(configManager, geminiTranscriber, consensusTranscriber);
  jobQueue.start();

  // Set dock icon for dev mode (packaged builds use icon.icns from build config)
  try {
    const dockIconPath = path.join(__dirname, '..', 'assets', 'icon.png');
    app.dock?.setIcon(dockIconPath);
  } catch (e) {
    console.error('Failed to set dock icon:', e);
  }

  createWindow();
  createTray();
  registerAllHandlers({
    configManager,
    geminiTranscriber,
    jobQueue,
    meetingNotesGenerator,
    notionMcpService,
    memoryManager,
    getMainWindow: () => mainWindow,
    getOpenAIClient: () => openAIClient,
    setOpenAIClient: (client) => { openAIClient = client; },
    getRealtimeMeetingMode: () => realtimeMeetingMode,
    setRealtimeMeetingMode: (mode) => { realtimeMeetingMode = mode; },
    getSystemAudioQueue: () => systemAudioQueue,
    startSystemAudioCapture,
    stopSystemAudioCapture,
    sendRealtimeEvent,
    generateMeetingNotesInBackground,
  });

  // macOS dock menu with Quit option
  if (app.dock) {
    const dockMenu = Menu.buildFromTemplate([
      {
        label: 'Show Window',
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isAppQuitting = true;
          app.quit();
        },
      },
    ]);
    app.dock.setMenu(dockMenu);
  }

  initRecordingWidget();

  const orchestrator = getOrchestrator();
  if (mainWindow) {
    orchestrator.initialize(mainWindow, getRendererPath());
    await orchestrator.start();
  }

  mainWindow?.show();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
    // Only bring the window forward if it's currently hidden.
    // Unconditional show()+focus() causes macOS to switch Spaces/Desktops
    // when the app is activated via widget clicks or system events.
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => {
  // Menu bar app stays alive until explicit quit.
});

app.on('before-quit', () => {
  isAppQuitting = true;
});

app.on('will-quit', (event) => {
  const orchestrator = getOrchestrator();
  orchestrator.stop();

  globalShortcut.unregisterAll();

  if (tray) {
    tray.destroy();
    tray = null;
  }

  if (jobQueue) {
    jobQueue.stop();
  }

  if (openAIClient) {
    void openAIClient.disconnect();
    openAIClient = null;
  }
  void stopSystemAudioCapture();

  // Force exit after cleanup — keyspy child process can keep the app alive
  // if SIGTERM doesn't kill the native binary fast enough.
  event.preventDefault();
  setTimeout(() => process.exit(0), 200);
});
