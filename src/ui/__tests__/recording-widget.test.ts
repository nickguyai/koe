import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockWebContents, mockBrowserWindow, mockScreen, mockBrowserWindowCtor } = vi.hoisted(() => {
  const webContents = {
    send: vi.fn(),
    once: vi.fn(),
  };

  const baseWindow = {
    isDestroyed: vi.fn(() => false),
    destroy: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    showInactive: vi.fn(),
    setPosition: vi.fn(),
    setBounds: vi.fn(),
    webContents,
  };

  const browserWindowCtor = vi.fn(() => ({ ...baseWindow, webContents: { ...webContents } }));

  return {
    mockWebContents: webContents,
    mockBrowserWindow: baseWindow,
    mockScreen: {
      getAllDisplays: vi.fn(() => []),
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    mockBrowserWindowCtor: browserWindowCtor,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: mockBrowserWindowCtor,
  screen: mockScreen,
}));

vi.mock('path', () => ({
  join: vi.fn((...args: string[]) => args.join('/')),
}));

import { RecordingWidget } from '../recording-widget';

function makeDisplay(id: number, x = 0, y = 0, width = 1920, height = 1080): Electron.Display {
  return {
    id,
    workArea: { x, y, width, height },
    bounds: { x, y, width, height },
    internal: false,
  } as unknown as Electron.Display;
}

describe('RecordingWidget', () => {
  let widget: RecordingWidget;

  beforeEach(() => {
    vi.clearAllMocks();
    widget = new RecordingWidget();
  });

  describe('init()', () => {
    it('creates one widget per connected display', () => {
      const displays = [makeDisplay(1), makeDisplay(2)];
      mockScreen.getAllDisplays.mockReturnValue(displays);

      const BrowserWindow = mockBrowserWindowCtor;
      widget.init();

      expect(BrowserWindow).toHaveBeenCalledTimes(2);
    });

    it('registers display-added, display-removed, and display-metrics-changed listeners', () => {
      mockScreen.getAllDisplays.mockReturnValue([]);
      widget.init();

      const events = mockScreen.on.mock.calls.map((c: unknown[]) => c[0]);
      expect(events).toContain('display-added');
      expect(events).toContain('display-removed');
      expect(events).toContain('display-metrics-changed');
    });

    it('does not create duplicate widget for same display id', () => {
      const display = makeDisplay(1);
      mockScreen.getAllDisplays.mockReturnValue([display]);

      const BrowserWindow = mockBrowserWindowCtor;
      widget.init();

      // Simulate display-added for same id
      const addedCb = mockScreen.on.mock.calls.find((c: unknown[]) => c[0] === 'display-added')![1] as Function;
      addedCb({}, display);

      // Only 1 BrowserWindow created (not 2)
      expect(BrowserWindow).toHaveBeenCalledTimes(1);
    });
  });

  describe('destroy()', () => {
    it('uses removeListener (not removeAllListeners) for each event', () => {
      mockScreen.getAllDisplays.mockReturnValue([makeDisplay(1)]);
      widget.init();
      widget.destroy();

      expect(mockScreen.removeListener).toHaveBeenCalledWith('display-added', expect.any(Function));
      expect(mockScreen.removeListener).toHaveBeenCalledWith('display-removed', expect.any(Function));
      expect(mockScreen.removeListener).toHaveBeenCalledWith('display-metrics-changed', expect.any(Function));
    });

    it('removes the exact listener refs that were registered', () => {
      mockScreen.getAllDisplays.mockReturnValue([]);
      widget.init();

      // Capture the handlers registered via screen.on
      const addedHandler = mockScreen.on.mock.calls.find((c: unknown[]) => c[0] === 'display-added')![1];
      const removedHandler = mockScreen.on.mock.calls.find((c: unknown[]) => c[0] === 'display-removed')![1];
      const metricsHandler = mockScreen.on.mock.calls.find((c: unknown[]) => c[0] === 'display-metrics-changed')![1];

      widget.destroy();

      expect(mockScreen.removeListener).toHaveBeenCalledWith('display-added', addedHandler);
      expect(mockScreen.removeListener).toHaveBeenCalledWith('display-removed', removedHandler);
      expect(mockScreen.removeListener).toHaveBeenCalledWith('display-metrics-changed', metricsHandler);
    });

    it('destroys all widget windows', () => {
      const displays = [makeDisplay(1), makeDisplay(2)];
      mockScreen.getAllDisplays.mockReturnValue(displays);

      const BrowserWindow = mockBrowserWindowCtor;
      const windows: any[] = [];
      BrowserWindow.mockImplementation(() => {
        const win = {
          isDestroyed: vi.fn(() => false),
          destroy: vi.fn(),
          setAlwaysOnTop: vi.fn(),
          loadURL: vi.fn(),
          loadFile: vi.fn(),
          showInactive: vi.fn(),
          setPosition: vi.fn(),
          setBounds: vi.fn(),
          webContents: { send: vi.fn(), once: vi.fn() },
        };
        windows.push(win);
        return win;
      });

      widget.init();
      widget.destroy();

      for (const win of windows) {
        expect(win.destroy).toHaveBeenCalled();
      }
    });
  });

  describe('updateAllWidgets()', () => {
    it('sends state to all widget windows', () => {
      const displays = [makeDisplay(1), makeDisplay(2)];
      mockScreen.getAllDisplays.mockReturnValue(displays);

      const BrowserWindow = mockBrowserWindowCtor;
      const windows: any[] = [];
      BrowserWindow.mockImplementation(() => {
        const win = {
          isDestroyed: vi.fn(() => false),
          destroy: vi.fn(),
          setAlwaysOnTop: vi.fn(),
          loadURL: vi.fn(),
          loadFile: vi.fn(),
          showInactive: vi.fn(),
          setPosition: vi.fn(),
          setBounds: vi.fn(),
          webContents: { send: vi.fn(), once: vi.fn() },
        };
        windows.push(win);
        return win;
      });

      widget.init();
      widget.updateAllWidgets('recording');

      for (const win of windows) {
        expect(win.webContents.send).toHaveBeenCalledWith('widget-state-update', { status: 'recording', mode: 'dictation' });
      }
    });

    it('cleans up destroyed windows during update', () => {
      mockScreen.getAllDisplays.mockReturnValue([makeDisplay(1)]);

      const BrowserWindow = mockBrowserWindowCtor;
      const destroyedWin = {
        isDestroyed: vi.fn(() => true),
        destroy: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        loadURL: vi.fn(),
        loadFile: vi.fn(),
        showInactive: vi.fn(),
        setPosition: vi.fn(),
        setBounds: vi.fn(),
        webContents: { send: vi.fn(), once: vi.fn() },
      };
      BrowserWindow.mockReturnValue(destroyedWin);

      widget.init();
      widget.updateAllWidgets('idle');

      expect(destroyedWin.webContents.send).not.toHaveBeenCalled();
    });
  });

  describe('new display gets current state', () => {
    it('pushes current state to newly added widget when not idle', () => {
      mockScreen.getAllDisplays.mockReturnValue([]);

      const BrowserWindow = mockBrowserWindowCtor;
      let createdWin: any = null;
      BrowserWindow.mockImplementation(() => {
        createdWin = {
          isDestroyed: vi.fn(() => false),
          destroy: vi.fn(),
          setAlwaysOnTop: vi.fn(),
          loadURL: vi.fn(),
          loadFile: vi.fn(),
          showInactive: vi.fn(),
          setPosition: vi.fn(),
          setBounds: vi.fn(),
          webContents: { send: vi.fn(), once: vi.fn() },
        };
        return createdWin;
      });

      widget.init();

      // Set state to recording
      widget.updateAllWidgets('recording');

      // Simulate display-added
      const addedCb = mockScreen.on.mock.calls.find((c: unknown[]) => c[0] === 'display-added')![1] as Function;
      addedCb({}, makeDisplay(2));

      // The new window should register a did-finish-load handler
      expect(createdWin.webContents.once).toHaveBeenCalledWith('did-finish-load', expect.any(Function));

      // Simulate the load completing
      const loadCb = createdWin.webContents.once.mock.calls[0][1];
      loadCb();

      expect(createdWin.webContents.send).toHaveBeenCalledWith('widget-state-update', { status: 'recording', mode: 'dictation' });
    });

    it('does not push state for idle (default)', () => {
      mockScreen.getAllDisplays.mockReturnValue([]);

      const BrowserWindow = mockBrowserWindowCtor;
      let createdWin: any = null;
      BrowserWindow.mockImplementation(() => {
        createdWin = {
          isDestroyed: vi.fn(() => false),
          destroy: vi.fn(),
          setAlwaysOnTop: vi.fn(),
          loadURL: vi.fn(),
          loadFile: vi.fn(),
          showInactive: vi.fn(),
          setPosition: vi.fn(),
          setBounds: vi.fn(),
          webContents: { send: vi.fn(), once: vi.fn() },
        };
        return createdWin;
      });

      widget.init();

      // Simulate display-added while idle
      const addedCb = mockScreen.on.mock.calls.find((c: unknown[]) => c[0] === 'display-added')![1] as Function;
      addedCb({}, makeDisplay(2));

      expect(createdWin.webContents.once).toHaveBeenCalledWith('did-finish-load', expect.any(Function));
      const loadCb = createdWin.webContents.once.mock.calls[0][1];
      loadCb();
      expect(createdWin.webContents.send).not.toHaveBeenCalledWith('widget-state-update', { status: 'idle' });
    });
  });

  describe('display-removed', () => {
    it('destroys widget for the disconnected display', () => {
      const display = makeDisplay(1);
      mockScreen.getAllDisplays.mockReturnValue([display]);

      const BrowserWindow = mockBrowserWindowCtor;
      const win = {
        isDestroyed: vi.fn(() => false),
        destroy: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        loadURL: vi.fn(),
        loadFile: vi.fn(),
        showInactive: vi.fn(),
        setPosition: vi.fn(),
        setBounds: vi.fn(),
        webContents: { send: vi.fn(), once: vi.fn() },
      };
      BrowserWindow.mockReturnValue(win);

      widget.init();

      const removedCb = mockScreen.on.mock.calls.find((c: unknown[]) => c[0] === 'display-removed')![1] as Function;
      removedCb({}, display);

      expect(win.destroy).toHaveBeenCalled();
    });
  });

  describe('display-metrics-changed', () => {
    it('repositions widget when display metrics change', () => {
      const display = makeDisplay(1, 0, 0, 1920, 1080);
      mockScreen.getAllDisplays.mockReturnValue([display]);

      const BrowserWindow = mockBrowserWindowCtor;
      const win = {
        isDestroyed: vi.fn(() => false),
        destroy: vi.fn(),
        setAlwaysOnTop: vi.fn(),
        loadURL: vi.fn(),
        loadFile: vi.fn(),
        showInactive: vi.fn(),
        setPosition: vi.fn(),
        setBounds: vi.fn(),
        webContents: { send: vi.fn(), once: vi.fn() },
      };
      BrowserWindow.mockReturnValue(win);

      widget.init();

      // Simulate metrics change with new dimensions
      const metricsCb = mockScreen.on.mock.calls.find((c: unknown[]) => c[0] === 'display-metrics-changed')![1] as Function;
      const updatedDisplay = makeDisplay(1, 0, 0, 2560, 1440);
      metricsCb({}, updatedDisplay);

      // 2560 - 60 - 20 = 2480, 1440 - 60 - 20 = 1360
      expect(win.setPosition).toHaveBeenCalledWith(2480, 1360, false);
    });
  });
});
