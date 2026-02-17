import { BrowserWindow, screen } from 'electron';
import * as path from 'path';

export type WidgetState = 'idle' | 'recording' | 'processing' | 'success' | 'error';

export class RecordingWidget {
  private widgets: Map<number, BrowserWindow> = new Map();
  private currentState: WidgetState = 'idle';
  private onDisplayAdded: ((_event: Electron.Event, display: Electron.Display) => void) | null = null;
  private onDisplayRemoved: ((_event: Electron.Event, display: Electron.Display) => void) | null = null;
  private onDisplayMetricsChanged: ((_event: Electron.Event, display: Electron.Display) => void) | null = null;

  /**
   * Create one widget per connected display
   */
  init(): void {
    const displays = screen.getAllDisplays();
    for (const display of displays) {
      this.createWidgetForDisplay(display);
    }

    this.onDisplayAdded = (_event, display) => {
      this.createWidgetForDisplay(display);
    };
    screen.on('display-added', this.onDisplayAdded);

    this.onDisplayRemoved = (_event, display) => {
      this.destroyWidgetForDisplay(display.id);
    };
    screen.on('display-removed', this.onDisplayRemoved);

    this.onDisplayMetricsChanged = (_event, display) => {
      const win = this.widgets.get(display.id);
      if (win && !win.isDestroyed()) {
        const { x, y } = this.getBottomRightPosition(display);
        win.setPosition(x, y, false);
      }
    };
    screen.on('display-metrics-changed', this.onDisplayMetricsChanged);

    for (const display of displays) {
      const { x, y, width, height } = display.bounds;
      console.log(`RecordingWidget: display ${display.id} bounds=(${x},${y},${width}x${height}) internal=${display.internal}`);
    }
    console.log(`RecordingWidget: created ${this.widgets.size} widget(s) across ${displays.length} display(s)`);
  }

  /**
   * Create a 60x60 frameless widget at bottom-right of a display.
   * Uses loadFile() instead of data: URL for reliable rendering on all
   * displays under hardened runtime (code-signed / packaged builds).
   */
  private createWidgetForDisplay(display: Electron.Display): void {
    if (this.widgets.has(display.id)) return;

    const pos = this.getBottomRightPosition(display);

    // Create without x/y — setBounds() after creation is more reliable
    // for secondary displays in packaged builds.
    const win = new BrowserWindow({
      width: 60,
      height: 60,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      hasShadow: true,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'widget-preload.js'),
      },
    });

    // Position after creation for reliable multi-display placement
    win.setBounds({ x: pos.x, y: pos.y, width: 60, height: 60 });
    console.log(`RecordingWidget: widget for display ${display.id} positioned at (${pos.x}, ${pos.y})`);

    // macOS: highest z-level + visible on fullscreen spaces
    if (process.platform === 'darwin') {
      win.setAlwaysOnTop(true, 'screen-saver');
      const setVisibleOnAllWorkspaces = (
        win as unknown as {
          setVisibleOnAllWorkspaces?: (visible: boolean, options?: { visibleOnFullScreen?: boolean }) => void;
        }
      ).setVisibleOnAllWorkspaces;
      setVisibleOnAllWorkspaces?.call(win, true, { visibleOnFullScreen: true });
    }

    // file:// protocol renders reliably on all displays under hardened runtime
    const htmlPath = path.join(__dirname, '..', '..', 'assets', 'recording-widget.html');
    win.loadFile(htmlPath);

    // Show after content is rendered; fallback timeout prevents invisible widgets
    let shown = false;
    const show = () => {
      if (shown || win.isDestroyed()) return;
      shown = true;
      win.showInactive();
    };

    win.webContents.once('did-finish-load', () => {
      show();
      // Push current state so late-added displays reflect the active state
      if (this.currentState !== 'idle' && !win.isDestroyed()) {
        win.webContents.send('widget-state-update', { status: this.currentState, mode: this._meetingMode ? 'meeting' : 'dictation' });
      }
    });

    setTimeout(show, 500);

    this.widgets.set(display.id, win);
  }

  /**
   * Destroy widget for a disconnected display
   */
  private destroyWidgetForDisplay(displayId: number): void {
    const win = this.widgets.get(displayId);
    if (win && !win.isDestroyed()) {
      win.destroy();
    }
    this.widgets.delete(displayId);
  }

  /**
   * Bottom-right position within the display's work area
   */
  private getBottomRightPosition(display: Electron.Display): { x: number; y: number } {
    const size = 60;
    const margin = 20;
    const { x: aX, y: aY, width: aW, height: aH } = display.workArea;
    return {
      x: aX + aW - size - margin,
      y: aY + aH - size - margin,
    };
  }

  /**
   * Push state to all widget windows
   */
  private _meetingMode: boolean = false;

  setMeetingMode(enabled: boolean): void {
    this._meetingMode = Boolean(enabled);
  }

  updateAllWidgets(state: WidgetState): void {
    this.currentState = state;
    for (const [id, win] of this.widgets) {
      if (win.isDestroyed()) {
        this.widgets.delete(id);
        continue;
      }
      win.webContents.send('widget-state-update', { status: state, mode: this._meetingMode ? 'meeting' : 'dictation' });
    }
  }

  /**
   * Destroy all widgets and remove listeners
   */
  destroy(): void {
    for (const [id, win] of this.widgets) {
      if (!win.isDestroyed()) {
        win.destroy();
      }
      this.widgets.delete(id);
    }
    if (this.onDisplayAdded) {
      screen.removeListener('display-added', this.onDisplayAdded);
      this.onDisplayAdded = null;
    }
    if (this.onDisplayRemoved) {
      screen.removeListener('display-removed', this.onDisplayRemoved);
      this.onDisplayRemoved = null;
    }
    if (this.onDisplayMetricsChanged) {
      screen.removeListener('display-metrics-changed', this.onDisplayMetricsChanged);
      this.onDisplayMetricsChanged = null;
    }
  }

}

// Singleton
let recordingWidgetInstance: RecordingWidget | null = null;

export function getRecordingWidget(): RecordingWidget {
  if (!recordingWidgetInstance) {
    recordingWidgetInstance = new RecordingWidget();
  }
  return recordingWidgetInstance;
}

export function initRecordingWidget(): void {
  const widget = getRecordingWidget();
  widget.init();
}
