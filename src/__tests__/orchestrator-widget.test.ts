import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  ipcHandlers,
  mockIpcMain,
  mockStateMachine,
  mockTextInsertionService,
  mockIndicator,
  mockWidget,
  mockHotkeyService,
  mockConfigService,
  mockPermissionService,
  mockSystemAudioService,
  mockElectronApp,
} = vi.hoisted(() => {
  const capturedHandlers: Record<string, Function> = {};

  const stateMachine = {
    currentState: 'idle' as string,
    on: vi.fn(),
    transition: vi.fn((trigger: string) => {
      if (trigger === 'hotkey_press' && stateMachine.currentState === 'idle') {
        stateMachine.currentState = 'recording';
        return true;
      }
      if ((trigger === 'hotkey_release' || trigger === 'hotkey_press') && stateMachine.currentState === 'recording') {
        stateMachine.currentState = 'processing';
        return true;
      }
      return true;
    }),
    setMeetingMode: vi.fn(),
    reset: vi.fn(() => {
      stateMachine.currentState = 'idle';
    }),
    getRecordingDuration: vi.fn(() => 0),
  };

  return {
    ipcHandlers: capturedHandlers,
    mockIpcMain: {
      on: vi.fn((channel: string, handler: Function) => {
        capturedHandlers[channel] = handler;
      }),
      handle: vi.fn((channel: string, handler: Function) => {
        capturedHandlers[channel] = handler;
      }),
    },
    mockStateMachine: stateMachine,
    mockTextInsertionService: {
      captureActiveApp: vi.fn(),
    },
    mockIndicator: {
      show: vi.fn(),
      hide: vi.fn(),
      showError: vi.fn(),
      showResult: vi.fn(),
      destroy: vi.fn(),
    },
    mockWidget: {
      updateAllWidgets: vi.fn(),
      setMeetingMode: vi.fn(),
      destroy: vi.fn(),
    },
    mockHotkeyService: {
      onPress: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
    },
    mockConfigService: {
      getHotkey: vi.fn(() => ({ accelerator: 'F1', enabled: true })),
      getInsertionMethod: vi.fn(() => 'paste'),
      getMeetingDetectionEnabled: vi.fn(() => false),
      setMeetingDetectionEnabled: vi.fn(),
      shouldPromptForMeetingApp: vi.fn(() => true),
      setMeetingPromptDismissedForApp: vi.fn(),
    },
    mockPermissionService: {
      checkAll: vi.fn(),
      checkSystemAudioPermission: vi.fn().mockResolvedValue('granted'),
      requestMicrophone: vi.fn(),
      promptAccessibility: vi.fn(),
      showPermissionNotification: vi.fn(),
    },
    mockSystemAudioService: {
      currentStatus: 'idle' as string,
      on: vi.fn(),
      start: vi.fn().mockResolvedValue(true),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    mockElectronApp: {
      dock: {
        show: vi.fn(),
      },
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  BrowserWindow: vi.fn(),
  app: mockElectronApp,
}));

vi.mock('../state-machine', () => ({
  getStateMachine: () => mockStateMachine,
}));

vi.mock('../hotkey-service', () => ({
  getHotkeyService: () => mockHotkeyService,
}));

vi.mock('../text-insertion-service', () => ({
  getTextInsertionService: () => mockTextInsertionService,
}));

vi.mock('../floating-indicator', () => ({
  getFloatingIndicator: () => mockIndicator,
}));

vi.mock('../recording-widget', () => ({
  getRecordingWidget: () => mockWidget,
}));

vi.mock('../permission-service', () => ({
  getPermissionService: () => mockPermissionService,
}));

vi.mock('../system-audio-service', () => ({
  getSystemAudioService: () => mockSystemAudioService,
}));

vi.mock('../config-service', () => ({
  getConfigService: () => mockConfigService,
}));

import { Orchestrator } from '../orchestrator';

describe('Orchestrator widget-toggle-recording IPC', () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockStateMachine.currentState = 'idle';
    // Clear captured handlers
    Object.keys(ipcHandlers).forEach((k) => delete ipcHandlers[k]);
    orchestrator = new Orchestrator();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function triggerWidgetToggle() {
    const handler = ipcHandlers['widget-toggle-recording'];
    expect(handler).toBeDefined();
    return handler();
  }

  it('registers widget-toggle-recording IPC handler', () => {
    expect(ipcHandlers['widget-toggle-recording']).toBeDefined();
  });

  it('starts recording when idle: captures app and transitions', async () => {
    mockStateMachine.currentState = 'idle';

    await triggerWidgetToggle();

    expect(mockTextInsertionService.captureActiveApp).toHaveBeenCalled();
    expect(mockStateMachine.transition).toHaveBeenCalledWith('hotkey_press');
  });

  it('stops recording when recording: transitions to processing', async () => {
    mockStateMachine.currentState = 'recording';

    await triggerWidgetToggle();

    expect(mockStateMachine.transition).toHaveBeenCalledWith('hotkey_press');
    expect(mockTextInsertionService.captureActiveApp).not.toHaveBeenCalled();
  });

  it('ignores click during error state', async () => {
    mockStateMachine.currentState = 'error';

    await triggerWidgetToggle();

    expect(mockStateMachine.transition).not.toHaveBeenCalled();
    expect(mockStateMachine.reset).not.toHaveBeenCalled();
    expect(mockTextInsertionService.captureActiveApp).not.toHaveBeenCalled();
  });

  it('ignores click during processing state', async () => {
    mockStateMachine.currentState = 'processing';

    await triggerWidgetToggle();

    expect(mockStateMachine.transition).not.toHaveBeenCalled();
    expect(mockStateMachine.reset).not.toHaveBeenCalled();
    expect(mockTextInsertionService.captureActiveApp).not.toHaveBeenCalled();
  });

  it('ignores click during inserting state', async () => {
    mockStateMachine.currentState = 'inserting';

    await triggerWidgetToggle();

    expect(mockStateMachine.transition).not.toHaveBeenCalled();
    expect(mockStateMachine.reset).not.toHaveBeenCalled();
    expect(mockTextInsertionService.captureActiveApp).not.toHaveBeenCalled();
  });
});

describe('Orchestrator transcription-error widget feedback', () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockStateMachine.currentState = 'processing';
    Object.keys(ipcHandlers).forEach((k) => delete ipcHandlers[k]);
    orchestrator = new Orchestrator();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows error on widget immediately and idle after 3s if still processing', () => {
    const handler = ipcHandlers['transcription-error'];
    expect(handler).toBeDefined();

    handler({}, 'Transcription failed');

    // Error state shown immediately
    expect(mockWidget.updateAllWidgets).toHaveBeenCalledWith('error');

    // State machine NOT transitioned yet (deferred)
    expect(mockStateMachine.transition).not.toHaveBeenCalledWith('error');

    // Advance 3 seconds — state is still 'processing'
    vi.advanceTimersByTime(3000);

    // Now widget goes idle and state machine transitions
    expect(mockWidget.updateAllWidgets).toHaveBeenCalledWith('idle');
    expect(mockStateMachine.transition).toHaveBeenCalledWith('error');
  });

  it('skips deferred transition if state changed before 3s timeout', () => {
    const handler = ipcHandlers['transcription-error'];
    handler({}, 'Some error');

    // Simulate state changing before the 3s timeout fires
    mockStateMachine.currentState = 'idle';
    mockWidget.updateAllWidgets.mockClear();
    mockStateMachine.transition.mockClear();

    vi.advanceTimersByTime(3000);

    // Timeout fires but state guard prevents action
    expect(mockWidget.updateAllWidgets).not.toHaveBeenCalledWith('idle');
    expect(mockStateMachine.transition).not.toHaveBeenCalledWith('error');
  });

  it('does not overwrite error visual with idle from stateChange', () => {
    const handler = ipcHandlers['transcription-error'];
    handler({}, 'Some error');

    // Capture the stateChange listener
    const stateChangeCalls = mockStateMachine.on.mock.calls.filter(
      (c: unknown[]) => c[0] === 'stateChange',
    );
    expect(stateChangeCalls.length).toBeGreaterThan(0);

    const stateChangeCb = stateChangeCalls[0][1] as Function;

    // Simulate the state machine emitting idle from processing
    // (this would happen if transition('error') was called synchronously)
    mockWidget.updateAllWidgets.mockClear();
    stateChangeCb('idle', 'processing');

    // Widget should NOT be updated to idle by the stateChange handler
    // because previousState is 'processing' — guarded
    expect(mockWidget.updateAllWidgets).not.toHaveBeenCalledWith('idle');
  });
});

describe('Orchestrator desktop switching guard', () => {
  let orchestrator: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(ipcHandlers).forEach((k) => delete ipcHandlers[k]);
    mockStateMachine.currentState = 'idle';
    orchestrator = new Orchestrator();
  });

  it('hides visible background main window before starting recording', async () => {
    const hide = vi.fn();
    const mainWindow = {
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      isFocused: vi.fn(() => false),
      hide,
      webContents: {
        on: vi.fn(),
      },
    } as unknown as Parameters<Orchestrator['initialize']>[0];

    orchestrator.initialize(mainWindow, '/tmp/realtime.html');

    const hotkeyPress = mockHotkeyService.onPress.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
    expect(hotkeyPress).toBeDefined();
    await hotkeyPress!();

    expect(hide).toHaveBeenCalled();
  });

  it('does not hide window if Koe is already focused', async () => {
    const hide = vi.fn();
    const mainWindow = {
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      isFocused: vi.fn(() => true),
      hide,
      webContents: {
        on: vi.fn(),
      },
    } as unknown as Parameters<Orchestrator['initialize']>[0];

    orchestrator.initialize(mainWindow, '/tmp/realtime.html');

    const hotkeyPress = mockHotkeyService.onPress.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
    expect(hotkeyPress).toBeDefined();
    await hotkeyPress!();

    expect(hide).not.toHaveBeenCalled();
  });
});
