import { BrowserWindow, screen } from 'electron';

export type IndicatorStatus = 'recording' | 'processing' | 'success' | 'error';

export interface IndicatorState {
  visible: boolean;
  status: IndicatorStatus;
  duration?: number;
  message?: string;
}

export class FloatingIndicator {
  private window: BrowserWindow | null = null;
  private timerInterval: NodeJS.Timeout | null = null;
  private displayPollInterval: NodeJS.Timeout | null = null;
  private startTime: number = 0;
  private lastDisplayId: number | null = null;

  /**
   * Create the floating indicator window
   */
  private createWindow(): BrowserWindow {
    const cursorPoint = screen.getCursorScreenPoint();
    const activeDisplay = screen.getDisplayNearestPoint(cursorPoint);
    this.lastDisplayId = activeDisplay.id;

    const windowWidth = 200;
    const windowHeight = 80;

    const { x, y } = this.getTopRightPosition(activeDisplay);

    const win = new BrowserWindow({
      width: windowWidth,
      height: windowHeight,
      x,
      y,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      focusable: false,  // Critical: prevents stealing focus
      skipTaskbar: true,
      resizable: false,
      movable: false,
      hasShadow: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    // Prevent the window from being focused
    win.setIgnoreMouseEvents(true, { forward: true });

    // macOS: visible on all Spaces including fullscreen apps to prevent Space switching
    // when recording while in fullscreen. Uses NSWindowCollectionBehavior.canJoinAllSpaces
    // and .fullScreenAuxiliary via Electron's setVisibleOnAllWorkspaces.
    // Ref: https://developer.apple.com/documentation/appkit/nswindowcollectionbehavior
    // Ref: https://www.electronjs.org/docs/latest/api/browser-window#winsetvisibleonallworkspacesvisible-options
    if (process.platform === 'darwin') {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }

    // Load inline HTML directly (no external file needed)
    win.loadURL(`data:text/html,${encodeURIComponent(this.getInlineHTML())}`);

    return win;
  }

  /**
   * Calculate top-right position for a given display
   */
  private getTopRightPosition(display: Electron.Display): { x: number; y: number } {
    const windowWidth = 200;
    const { x: areaX, y: areaY, width: areaWidth } = display.workArea;
    return {
      x: areaX + areaWidth - windowWidth - 20,
      y: areaY + 20,
    };
  }

  /**
   * Move the indicator to the display the cursor is currently on
   */
  private repositionToActiveDisplay(): void {
    if (!this.window || this.window.isDestroyed()) return;

    const cursorPoint = screen.getCursorScreenPoint();
    const activeDisplay = screen.getDisplayNearestPoint(cursorPoint);

    if (this.lastDisplayId === activeDisplay.id) return;

    this.lastDisplayId = activeDisplay.id;
    const { x, y } = this.getTopRightPosition(activeDisplay);
    this.window.setPosition(x, y, false);
  }

  /**
   * Get inline HTML for the indicator
   * Uses Sumi-e design system to match Koe UI
   */
  private getInlineHTML(): string {
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
      "img-src data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ');

    return `
<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@300;400&family=Source+Sans+3:wght@300;400;500&display=swap" rel="stylesheet">
  <style>
    /* Sumi-e Design Tokens */
    :root {
      --sumi-black: #1C1C1C;
      --brushed-gray: #4A4A4A;
      --diluted-ink: #8B8B8B;
      --ink-mist: #C4C4C4;
      --washi-white: #FAF8F5;
      --aged-paper: #F0EBE3;
      --tokonoma: #E8E4DC;
      --vermillion: #C23B22;
      --moss-stone: #6B7B5E;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Source Sans 3', -apple-system, BlinkMacSystemFont, sans-serif;
      background: transparent;
      -webkit-app-region: no-drag;
      user-select: none;
      -webkit-font-smoothing: antialiased;
    }

    .font-display {
      font-family: 'Cormorant Garamond', serif;
    }

    .container {
      background: var(--washi-white);
      border-radius: 4px 20px 4px 20px;
      padding: 16px 20px;
      display: flex;
      align-items: center;
      gap: 14px;
      box-shadow: 0 4px 24px rgba(28, 28, 28, 0.12), 0 2px 8px rgba(28, 28, 28, 0.08);
      border: 1px solid rgba(28, 28, 28, 0.06);
    }

    .indicator-wrapper {
      position: relative;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .pulse-ring {
      position: absolute;
      inset: 0;
      border-radius: 50%;
      background: rgba(194, 59, 34, 0.15);
      opacity: 0;
    }

    .pulse-ring.active {
      animation: pulse-ring 2s ease-out infinite;
    }

    .pulse-ring.delay {
      animation-delay: 0.5s;
    }

    .indicator {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      z-index: 1;
      color: var(--washi-white);
    }

    .indicator.recording {
      background: var(--vermillion);
      box-shadow: 0 2px 8px rgba(194, 59, 34, 0.3);
    }

    .indicator.processing {
      background: var(--sumi-black);
    }

    .indicator.success {
      background: var(--moss-stone);
    }

    .indicator.error {
      background: var(--vermillion);
    }

    .indicator svg {
      width: 12px;
      height: 12px;
      stroke: var(--washi-white);
      fill: none;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .indicator.processing svg {
      animation: spin 1.5s linear infinite;
    }

    @keyframes pulse-ring {
      0% { transform: scale(0.8); opacity: 0.6; }
      100% { transform: scale(1.6); opacity: 0; }
    }

    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    @keyframes breathe {
      0%, 100% { opacity: 0.6; }
      50% { opacity: 1; }
    }

    .content {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .status {
      color: var(--sumi-black);
      font-size: 14px;
      font-weight: 400;
    }

    .status.recording {
      color: var(--vermillion);
    }

    .timer {
      font-family: 'Cormorant Garamond', serif;
      color: var(--brushed-gray);
      font-size: 18px;
      font-weight: 300;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.02em;
    }

    .timer.recording {
      color: var(--vermillion);
    }

    .message {
      color: var(--diluted-ink);
      font-size: 12px;
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      letter-spacing: 0.02em;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="indicator-wrapper">
      <div id="pulseRing1" class="pulse-ring"></div>
      <div id="pulseRing2" class="pulse-ring delay"></div>
      <div id="indicator" class="indicator recording">
        <svg id="indicatorIcon" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"></circle>
        </svg>
      </div>
    </div>
    <div class="content">
      <div id="status" class="status recording">Recording</div>
      <div id="timer" class="timer font-display recording">00:00</div>
      <div id="message" class="message" style="display: none;"></div>
    </div>
  </div>
  <script>
    window.updateState = function(state) {
      const indicator = document.getElementById('indicator');
      const indicatorIcon = document.getElementById('indicatorIcon');
      const status = document.getElementById('status');
      const timer = document.getElementById('timer');
      const message = document.getElementById('message');
      const pulseRing1 = document.getElementById('pulseRing1');
      const pulseRing2 = document.getElementById('pulseRing2');

      // Reset classes
      indicator.className = 'indicator ' + state.status;
      status.className = 'status';
      timer.className = 'timer font-display';

      // Update pulse rings
      if (state.status === 'recording') {
        pulseRing1.classList.add('active');
        pulseRing2.classList.add('active');
        status.classList.add('recording');
        timer.classList.add('recording');
      } else {
        pulseRing1.classList.remove('active');
        pulseRing2.classList.remove('active');
      }

      // Update icon and text based on status
      switch (state.status) {
        case 'recording':
          status.textContent = 'Recording';
          indicatorIcon.innerHTML = '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"></circle>';
          break;
        case 'processing':
          status.textContent = 'Processing';
          indicatorIcon.innerHTML = '<path d="M21 12a9 9 0 1 1-6.219-8.56"></path>';
          break;
        case 'success':
          status.textContent = 'Complete';
          indicatorIcon.innerHTML = '<polyline points="20 6 9 17 4 12"></polyline>';
          break;
        case 'error':
          status.textContent = 'Error';
          indicatorIcon.innerHTML = '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>';
          break;
      }

      if (state.duration !== undefined) {
        const mins = Math.floor(state.duration / 60);
        const secs = state.duration % 60;
        timer.textContent = mins.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0');
        timer.style.display = 'block';
      } else {
        timer.style.display = 'none';
      }

      if (state.message) {
        message.textContent = state.message;
        message.style.display = 'block';
        timer.style.display = 'none';
      } else {
        message.style.display = 'none';
      }
    };
  </script>
</body>
</html>
    `;
  }

  /**
   * Start polling cursor position to follow active display
   */
  private startDisplayPolling(): void {
    this.stopDisplayPolling();
    this.displayPollInterval = setInterval(() => {
      this.repositionToActiveDisplay();
    }, 500);
  }

  /**
   * Stop display polling
   */
  private stopDisplayPolling(): void {
    if (this.displayPollInterval) {
      clearInterval(this.displayPollInterval);
      this.displayPollInterval = null;
    }
  }

  /**
   * Handle display configuration changes while indicator is visible
   */
  private onDisplayChanged = (): void => {
    this.lastDisplayId = null; // force reposition on next poll
    this.repositionToActiveDisplay();
  };

  /**
   * Show the indicator with given state
   */
  show(state: IndicatorState): void {
    try {
      if (!this.window || this.window.isDestroyed()) {
        this.window = this.createWindow();
      }

      this.repositionToActiveDisplay();
      this.updateState(state);

      // Use setImmediate to avoid blocking the main process
      setImmediate(() => {
        if (this.window && !this.window.isDestroyed()) {
          this.window.showInactive();
        }
      });

      // Start timer and display polling if recording
      if (state.status === 'recording') {
        this.startTimer();
        this.startDisplayPolling();
        screen.removeListener('display-added', this.onDisplayChanged);
        screen.removeListener('display-removed', this.onDisplayChanged);
        screen.on('display-added', this.onDisplayChanged);
        screen.on('display-removed', this.onDisplayChanged);
      }
    } catch (err) {
      console.error('Error showing floating indicator:', err);
    }
  }

  /**
   * Hide the indicator
   */
  hide(): void {
    this.stopTimer();
    this.stopDisplayPolling();
    screen.removeListener('display-added', this.onDisplayChanged);
    screen.removeListener('display-removed', this.onDisplayChanged);
    this.lastDisplayId = null;
    if (this.window && !this.window.isDestroyed()) {
      this.window.hide();
    }
  }

  /**
   * Update the indicator state
   */
  private updateState(state: IndicatorState): void {
    if (!this.window || this.window.isDestroyed()) return;

    this.window.webContents.executeJavaScript(`
      if (window.updateState) {
        window.updateState(${JSON.stringify(state)});
      }
    `).catch(console.error);
  }

  /**
   * Start the recording timer
   */
  private startTimer(): void {
    this.stopTimer();
    this.startTime = Date.now();

    this.timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
      this.updateDuration(elapsed);
    }, 1000);
  }

  /**
   * Stop the recording timer
   */
  private stopTimer(): void {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  /**
   * Update the displayed duration
   */
  updateDuration(seconds: number): void {
    if (!this.window || this.window.isDestroyed()) return;

    this.window.webContents.executeJavaScript(`
      if (window.updateState) {
        const timer = document.getElementById('timer');
        if (timer) {
          const mins = Math.floor(${seconds} / 60);
          const secs = ${seconds} % 60;
          timer.textContent = mins.toString().padStart(2, '0') + ':' + secs.toString().padStart(2, '0');
        }
      }
    `).catch(console.error);
  }

  /**
   * Show a result briefly before hiding
   */
  showResult(text: string, duration: number = 2000): void {
    this.stopTimer();

    const truncatedText = text.length > 50 ? text.substring(0, 47) + '...' : text;

    this.show({
      visible: true,
      status: 'success',
      message: truncatedText,
    });

    setTimeout(() => {
      this.hide();
    }, duration);
  }

  /**
   * Show an error briefly
   */
  showError(message: string, duration: number = 3000): void {
    this.stopTimer();

    this.show({
      visible: true,
      status: 'error',
      message,
    });

    setTimeout(() => {
      this.hide();
    }, duration);
  }

  /**
   * Pre-create the window (hidden) to avoid creation during recording
   */
  preCreate(): void {
    if (!this.window || this.window.isDestroyed()) {
      this.window = this.createWindow();
      this.window.hide();
      console.log('Floating indicator window pre-created');
    }
  }

  /**
   * Destroy the window
   */
  destroy(): void {
    this.stopTimer();
    this.stopDisplayPolling();
    screen.removeListener('display-added', this.onDisplayChanged);
    screen.removeListener('display-removed', this.onDisplayChanged);
    this.lastDisplayId = null;
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = null;
  }
}

// Singleton instance
let floatingIndicatorInstance: FloatingIndicator | null = null;

export function getFloatingIndicator(): FloatingIndicator {
  if (!floatingIndicatorInstance) {
    floatingIndicatorInstance = new FloatingIndicator();
  }
  return floatingIndicatorInstance;
}

/**
 * Pre-create the indicator window at app startup (hidden)
 * This prevents window creation during recording which can cause issues
 */
export function initFloatingIndicator(): void {
  const indicator = getFloatingIndicator();
  indicator.preCreate();
}
