// Koe Transcription App - main.js
// Sumi-e inspired transcription interface

// ============================================
// Global State
// ============================================
let audioContext, processor, source, stream;
let mediaRecorder = null;
let mediaRecorderChunks = [];
let isRecording = false;
let timerInterval;
let startTime;
let audioBuffer = new Int16Array(0);
let streamInitialized = false;
let currentProvider = 'gemini';
let sampleRate = 24000;
let currentJobId = null;
let toastNode = null;
let toastTimer = null;
let activeView = 'home';
let selectedTranscription = null;
let summaryReturnView = null; // tracks where to return when leaving summary
let detailReturnView = null;  // tracks where to return when leaving detail
let detailAudioUrl = null;
let detailAudioRequestId = 0;
let summaryAudioUrl = null;
let summaryAudioRequestId = 0;

// Pre-warm microphone stream to avoid clipping on first recording
async function initMicrophoneStream() {
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            console.warn('Microphone API not available for pre-warm');
            return;
        }
        stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        streamInitialized = true;
        console.log('Microphone stream pre-warmed');
    } catch (err) {
        console.warn('Microphone pre-warm failed (will retry on first recording):', err.message);
    }
}

// OpenAI Live mode state
let liveAudioContext = null;
let liveAudioWorklet = null;
let liveSource = null;
let liveSessionStarting = false;
let liveSessionActive = false;
let openAIListenerAttached = false;
let liveSavedForSession = false;
let liveMediaRecorder = null;
let liveMediaRecorderChunks = [];
let liveEarlyJobId = null;
let liveRecordingStartTime = null;
let liveRecordingEndTime = null;
let liveMeetingModeActive = false;
let liveMeetingSegments = [];
let liveMeetingDisplaySegments = [];
let liveMeetingTranscript = '';
let liveTranscriptPinned = true;
let liveTranscriptCollapsed = false;
let pendingMeetingSuggestionApp = '';
const activeDiarizationPollers = new Set();

// App settings
let settings = {
    autoDetectSpeakers: true,
    language: 'auto',
    punctuation: true,
    timestamps: true,
    summaryLength: 'medium',
    autoPolish: false,
    polishStyle: 'natural',
    customPolishPrompt: '',
    defaultMode: 'gemini',
    geminiModel: 'gemini-3-flash-preview',
    customTranscriptionPrompt: '',
    consensusEnabled: false,
    consensusMemoryEnabled: true,
    meetingCaptureEnabled: false,
    meetingNotesModel: 'gpt-5.2-2025-12-11',
    speakerLabels: {},
    hotkey: {
        code: 'Space',
        key: ' ',
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
    },
};

// Configuration status flags
let hasGeminiApiKey = false;

// Sample transcriptions data (will be populated from API)
let transcriptions = [];
let jobs = [];
let latestJobResult = null;  // For featured transcription block

// Stone wave animation state
let stoneAnimation = null;

// ============================================
// Stone Wave Animation
// ============================================
let isCircularMode = false;
const STONE_COUNT = 8;

function createStones() {
    const container = document.getElementById('stoneWave');
    if (!container || container.children.length > 0) return; // Already created

    for (let i = 0; i < STONE_COUNT; i++) {
        const stone = document.createElement('div');
        stone.className = 'stone';
        stone.dataset.index = i;
        // Bigger organic shapes
        const sizes = [18, 22, 26, 30];
        const size = sizes[Math.floor(Math.random() * sizes.length)];
        stone.style.width = `${size}px`;
        stone.style.height = `${size}px`;
        stone.style.borderRadius = `${30 + Math.random() * 40}% ${20 + Math.random() * 30}% ${35 + Math.random() * 35}% ${25 + Math.random() * 25}%`;
        container.appendChild(stone);
    }
}

function startRecordingAnimation() {
    const container = document.getElementById('stoneWaveContainer');
    const stoneWave = document.getElementById('stoneWave');
    if (!container || !stoneWave) return;

    // Show container in linear mode (below button)
    container.style.display = 'block';
    container.classList.remove('circular-mode');
    container.classList.add('linear-mode');

    createStones();

    // Reset stone positions for linear layout
    const stones = stoneWave.querySelectorAll('.stone');
    stones.forEach((stone, i) => {
        stone.style.position = '';
        stone.style.left = '';
        stone.style.top = '';
        stone.style.transform = '';
    });

    if (typeof anime === 'undefined') return;

    // Linear wave animation - slower and gentler
    stoneAnimation = anime({
        targets: '.stone',
        translateY: [
            { value: -12, duration: 600 },
            { value: 0, duration: 600 }
        ],
        opacity: [
            { value: 1, duration: 300 },
            { value: 0.5, duration: 900 }
        ],
        delay: anime.stagger(120),
        loop: true,
        easing: 'easeInOutSine'
    });
}

function transitionToCircular() {
    const container = document.getElementById('stoneWaveContainer');
    const stoneWave = document.getElementById('stoneWave');
    const recordBtn = document.getElementById('recordButton');
    if (!container || !stoneWave) return;

    // Grey out the record button
    if (recordBtn) recordBtn.classList.add('processing');

    // Stop current animation but keep stones in place
    if (stoneAnimation) {
        stoneAnimation.pause();
        stoneAnimation = null;
    }

    // Get current positions of stones before switching modes
    const stones = stoneWave.querySelectorAll('.stone');
    const startPositions = [];
    stones.forEach((stone) => {
        const rect = stone.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        startPositions.push({
            x: rect.left - containerRect.left + rect.width / 2,
            y: rect.top - containerRect.top + rect.height / 2
        });
    });

    // Switch to circular mode
    container.classList.remove('linear-mode');
    container.classList.add('circular-mode');

    if (typeof anime === 'undefined') return;

    const radius = 85; // Circle radius around button
    const containerSize = 200; // Container width/height
    const centerX = containerSize / 2;
    const centerY = containerSize / 2;

    // Animate stones from their current wave positions to circular positions
    stones.forEach((stone, i) => {
        const angle = (i / STONE_COUNT) * 2 * Math.PI - Math.PI / 2; // Start from top
        const targetX = centerX + Math.cos(angle) * radius;
        const targetY = centerY + Math.sin(angle) * radius;

        // Set initial position based on where stone was in the wave
        stone.style.left = `${startPositions[i].x}px`;
        stone.style.top = `${startPositions[i].y}px`;
        stone.style.transform = 'translate(-50%, -50%)';

        anime({
            targets: stone,
            left: `${targetX}px`,
            top: `${targetY}px`,
            duration: 1000,
            delay: i * 80,
            easing: 'easeInOutCubic'
        });
    });

    // After transition, start orbital animation
    setTimeout(() => {
        stoneAnimation = anime.timeline({ loop: true });

        // Slower rotation
        stoneAnimation.add({
            targets: '#stoneWave',
            rotate: '1turn',
            duration: 10000,
            easing: 'linear'
        }, 0);

        // Gentle pulse on stones
        stoneAnimation.add({
            targets: '.stone',
            scale: [1, 1.2, 1],
            opacity: [0.6, 0.95, 0.6],
            duration: 2000,
            delay: anime.stagger(150),
            easing: 'easeInOutSine'
        }, 0);
    }, 1000 + STONE_COUNT * 80);
}

function stopStoneAnimation() {
    if (stoneAnimation) {
        stoneAnimation.pause();
        stoneAnimation = null;
    }

    const container = document.getElementById('stoneWaveContainer');
    const stoneWave = document.getElementById('stoneWave');
    const recordBtn = document.getElementById('recordButton');

    if (container) {
        container.style.display = 'none';
        container.classList.remove('linear-mode', 'circular-mode');
    }
    if (stoneWave) {
        stoneWave.style.transform = '';
        stoneWave.innerHTML = ''; // Clear stones for fresh start
    }
    if (recordBtn) {
        recordBtn.classList.remove('processing');
    }
}

// ============================================
// Polish Indicator
// ============================================
function updatePolishIndicator() {
    const block = document.getElementById('featuredTranscription');
    const indicator = document.getElementById('polishIndicator');
    if (!block) return;

    if (settings.autoPolish) {
        block.classList.remove('polish-disabled');
        block.classList.add('polish-enabled');
        if (indicator) {
            indicator.innerHTML = '<span class="polish-dot">✦</span><span class="polish-text">Polished</span>';
        }
    } else {
        block.classList.remove('polish-enabled');
        block.classList.add('polish-disabled');
        if (indicator) {
            indicator.innerHTML = '<span class="polish-dot">◇</span><span class="polish-text">Raw transcript</span>';
        }
    }
}

// ============================================
// DOM Elements
// ============================================
const recordButton = document.getElementById('recordButton');
const timer = document.getElementById('timer');
const recordingLabel = document.getElementById('recordingLabel');
const recordingHint = document.getElementById('recordingHint');
const pulseRing1 = document.getElementById('pulseRing1');
const pulseRing2 = document.getElementById('pulseRing2');
const audioFile = document.getElementById('audioFile');
const dropzone = document.getElementById('dropzone');
const toast = document.getElementById('toast');

// Views
const homeView = document.getElementById('homeView');
const libraryView = document.getElementById('libraryView');
const jobsView = document.getElementById('jobsView');
const settingsView = document.getElementById('settingsView');
const detailView = document.getElementById('detailView');
const meetingSummaryView = document.getElementById('meetingSummaryView');

// Navigation
const navTabs = document.querySelectorAll('.nav-tab');
const viewAllBtn = document.getElementById('viewAllBtn');

// Assistant
const assistantToggle = document.getElementById('assistantToggle');
const assistantOverlay = document.getElementById('assistantOverlay');
const assistantClose = document.getElementById('assistantClose');
const assistantInput = document.getElementById('assistantInput');
const assistantSend = document.getElementById('assistantSend');
const assistantMessages = document.getElementById('assistantMessages');
const quickActions = document.querySelectorAll('.quick-action');

// Settings elements
const saveSettingsBtn = document.getElementById('saveSettings');
const openaiKey = document.getElementById('openaiKey');
const geminiKey = document.getElementById('geminiKey');
const geminiModelSelect = document.getElementById('geminiModelSelect');
const meetingNotesModelSelect = document.getElementById('meetingNotesModelSelect');
const languageSelect = document.getElementById('languageSelect');
const summaryOptions = document.querySelectorAll('.summary-option');
const settingToggles = document.querySelectorAll('.setting-toggle');

// Lists
const recentTranscriptions = document.getElementById('recentTranscriptions');
const libraryList = document.getElementById('libraryList');
const jobsList = document.getElementById('jobsList');
const activeJobsList = document.getElementById('activeJobsList');
const processingSection = document.getElementById('processingSection');

// Featured Transcription
const featuredTranscription = document.getElementById('featuredTranscription');
const featuredTitle = document.getElementById('featuredTitle');
const featuredDate = document.getElementById('featuredDate');
const featuredContent = document.getElementById('featuredContent');
const featuredCopyBtn = document.getElementById('featuredCopyBtn');

// Mode Selector
const modeOptions = document.querySelectorAll('.mode-option');

// Meeting detection prompt
const meetingDetectPrompt = document.getElementById('meetingDetectPrompt');
const meetingDetectPromptMessage = document.getElementById('meetingDetectPromptMessage');
const meetingDetectDontAskAgain = document.getElementById('meetingDetectDontAskAgain');
const meetingDetectNotNowBtn = document.getElementById('meetingDetectNotNowBtn');
const meetingDetectSwitchBtn = document.getElementById('meetingDetectSwitchBtn');
const meetingDetectClose = document.getElementById('meetingDetectClose');

// Live transcript panel
const liveTranscriptPanel = document.getElementById('liveTranscriptPanel');
const liveTranscriptPanelBody = document.getElementById('liveTranscriptPanelBody');
const liveTranscriptCollapseBtn = document.getElementById('liveTranscriptCollapseBtn');
const liveTranscriptPinToggle = document.getElementById('liveTranscriptPinToggle');

// Polish Settings
const polishStyleSelect = document.getElementById('polishStyleSelect');
const customPolishPrompt = document.getElementById('customPolishPrompt');

// Model and Advanced Settings
const customTranscriptionPrompt = document.getElementById('customTranscriptionPrompt');

// Hotkey Settings
const hotkeyInput = document.getElementById('hotkeyInput');
const hotkeyRecordBtn = document.getElementById('hotkeyRecordBtn');
const hotkeyResetBtn = document.getElementById('hotkeyResetBtn');
let isRecordingHotkey = false;

// ============================================
// Utility Functions
// ============================================
const isMobileDevice = () => /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

// XSS prevention - escape HTML entities
function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function showToast(message) {
    if (!message || !toast) return;
    toast.textContent = message;
    toast.classList.add('visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove('visible');
    }, 2500);
}

function showSystemAudioWarning(message) {
    const el = document.getElementById('systemAudioWarning');
    if (!el) return;
    el.textContent = message;
    el.style.display = 'block';
}

function hideSystemAudioWarning() {
    const el = document.getElementById('systemAudioWarning');
    if (!el) return;
    el.style.display = 'none';
}

async function copyToClipboard(text) {
    if (!text) return;
    try {
        await navigator.clipboard.writeText(text);
        showToast('Copied to clipboard');
    } catch (err) {
        console.error('Clipboard copy failed:', err);
    }
}

function isElectronEnvironment() {
    return typeof window.electronAPI !== 'undefined' || navigator.userAgent.includes('Electron');
}

async function syncMeetingModeToMainProcess() {
    if (!window.electronAPI || !window.electronAPI.setMeetingMode) return;
    try {
        await window.electronAPI.setMeetingMode(!!settings.meetingCaptureEnabled);
    } catch (e) {
        console.warn('Failed to sync meeting mode to main process:', e);
    }
}

function normalizeSpeakerKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function resolveSpeakerLabel(rawSpeakerName, fallbackName = 'Speaker') {
    const key = normalizeSpeakerKey(rawSpeakerName);
    if (key && settings.speakerLabels && settings.speakerLabels[key]) {
        return settings.speakerLabels[key];
    }
    const raw = String(rawSpeakerName || '').trim();
    return raw || fallbackName;
}

function applyModeSelection(mode, options = {}) {
    const persist = options.persist !== false;
    const syncMainProcess = options.syncMainProcess !== false;
    const normalizedMode = mode === 'meeting' ? 'meeting' : (mode === 'openai' ? 'openai' : 'gemini');
    const isMeeting = normalizedMode === 'meeting';

    modeOptions.forEach(option => {
        option.classList.toggle('active', option.dataset.mode === normalizedMode);
    });

    currentProvider = (normalizedMode === 'openai' || isMeeting) ? 'openai' : 'gemini';
    settings.defaultMode = normalizedMode;
    settings.meetingCaptureEnabled = isMeeting;

    const settingsToggle = document.querySelector('[data-setting="meetingCaptureEnabled"] .toggle-switch');
    if (settingsToggle) {
        settingsToggle.classList.toggle('active', isMeeting);
    }

    const meetingBanner = document.getElementById('meetingBanner');
    if (meetingBanner) {
        meetingBanner.style.display = isMeeting ? 'block' : 'none';
    }

    document.body.classList.toggle('meeting-mode', isMeeting);
    updateRecordingUI(isRecording);

    if (!isMeeting) {
        hideMeetingModeSuggestionPrompt();
    }

    if (persist) {
        api.setSettings({
            meetingCaptureEnabled: isMeeting,
            defaultMode: normalizedMode
        }).catch((e) => {
            console.warn('Failed to persist mode selection:', e);
        });
    }

    if (syncMainProcess) {
        syncMeetingModeToMainProcess();
    }
}

function renderLiveTranscriptEmptyState() {
    if (!liveTranscriptPanelBody) return;
    liveTranscriptPanelBody.innerHTML = '<p class="live-transcript-empty">Waiting for speech…</p>';
}

function resetLiveTranscriptPanel(options = {}) {
    const hide = options.hide === true;
    if (!liveTranscriptPanel) return;

    if (hide) {
        liveTranscriptPanel.style.display = 'none';
        if (liveTranscriptPanelBody) {
            liveTranscriptPanelBody.innerHTML = '';
        }
        return;
    }

    liveTranscriptPanel.style.display = 'block';
    liveTranscriptPanel.classList.toggle('collapsed', liveTranscriptCollapsed);
    renderLiveTranscriptEmptyState();
}

function appendLiveTranscriptRow(stamp, text) {
    if (!liveTranscriptPanelBody || !liveTranscriptPanel) return;

    if (liveTranscriptPanelBody.querySelector('.live-transcript-empty')) {
        liveTranscriptPanelBody.innerHTML = '';
    }

    const row = document.createElement('div');
    row.className = 'live-transcript-segment';
    row.innerHTML = `
        <span class="live-transcript-segment-time">${escapeHtml(stamp)}</span>
        <p class="live-transcript-segment-text">${escapeHtml(text)}</p>
    `;
    liveTranscriptPanelBody.appendChild(row);

    if (liveTranscriptPinned) {
        liveTranscriptPanelBody.scrollTop = liveTranscriptPanelBody.scrollHeight;
    }
}

function setupLiveTranscriptPanelListeners() {
    if (liveTranscriptCollapseBtn) {
        liveTranscriptCollapseBtn.addEventListener('click', () => {
            liveTranscriptCollapsed = !liveTranscriptCollapsed;
            if (liveTranscriptPanel) {
                liveTranscriptPanel.classList.toggle('collapsed', liveTranscriptCollapsed);
            }
        });
    }

    if (liveTranscriptPinToggle) {
        liveTranscriptPinToggle.checked = liveTranscriptPinned;
        liveTranscriptPinToggle.addEventListener('change', () => {
            liveTranscriptPinned = !!liveTranscriptPinToggle.checked;
            if (liveTranscriptPinned && liveTranscriptPanelBody) {
                liveTranscriptPanelBody.scrollTop = liveTranscriptPanelBody.scrollHeight;
            }
        });
    }
}

function hideMeetingModeSuggestionPrompt() {
    if (!meetingDetectPrompt) return;
    meetingDetectPrompt.style.display = 'none';
    pendingMeetingSuggestionApp = '';
    if (meetingDetectDontAskAgain) {
        meetingDetectDontAskAgain.checked = false;
    }
}

function hasMeetingSuggestionBridge() {
    return !!(window.electronAPI
        && typeof window.electronAPI.dismissMeetingModeSuggestion === 'function'
        && typeof window.electronAPI.switchMeetingModeSuggestion === 'function');
}

function showMeetingModeSuggestionPrompt(payload = {}) {
    if (!hasMeetingSuggestionBridge()) {
        console.warn('Meeting detection prompt is only available in the Electron app');
        return;
    }
    if (!meetingDetectPrompt) return;
    const appName = String(payload.appName || payload.processName || 'this app').trim();
    pendingMeetingSuggestionApp = appName;
    if (meetingDetectPromptMessage) {
        meetingDetectPromptMessage.textContent = `Looks like a meeting is starting in ${appName}. Switch to Meeting Capture?`;
    }
    if (meetingDetectDontAskAgain) {
        meetingDetectDontAskAgain.checked = false;
    }
    meetingDetectPrompt.style.display = 'block';
}

async function dismissMeetingModeSuggestionPrompt() {
    const dontAskAgain = !!meetingDetectDontAskAgain?.checked;
    if (!window.electronAPI || !window.electronAPI.dismissMeetingModeSuggestion) {
        if (dontAskAgain) {
            showToast('"Don\'t ask again" is only available in the desktop app');
        }
        hideMeetingModeSuggestionPrompt();
        return;
    }
    try {
        await window.electronAPI.dismissMeetingModeSuggestion({
            appName: pendingMeetingSuggestionApp,
            dontAskAgain
        });
    } catch (e) {
        console.warn('Failed to dismiss meeting suggestion:', e);
    } finally {
        hideMeetingModeSuggestionPrompt();
    }
}

async function switchMeetingModeFromSuggestion() {
    const dontAskAgain = !!meetingDetectDontAskAgain?.checked;
    const hasBridge = !!(window.electronAPI && window.electronAPI.switchMeetingModeSuggestion);
    try {
        if (hasBridge) {
            await window.electronAPI.switchMeetingModeSuggestion({
                appName: pendingMeetingSuggestionApp,
                dontAskAgain
            });
        } else {
            console.warn('Meeting mode suggestion bridge unavailable, applying local mode switch only');
        }
        applyModeSelection('meeting', { persist: true, syncMainProcess: false });
        if (!hasBridge && dontAskAgain) {
            showToast('Meeting mode enabled (desktop app required to save "Don\'t ask again")');
        } else {
            showToast('Meeting mode enabled');
        }
    } catch (e) {
        console.warn('Failed to switch from meeting suggestion:', e);
        showToast('Unable to switch meeting mode');
    } finally {
        hideMeetingModeSuggestionPrompt();
    }
}

function setupMeetingDetectionPromptListeners() {
    if (meetingDetectNotNowBtn) {
        meetingDetectNotNowBtn.addEventListener('click', () => {
            dismissMeetingModeSuggestionPrompt();
        });
    }
    if (meetingDetectClose) {
        meetingDetectClose.addEventListener('click', () => {
            dismissMeetingModeSuggestionPrompt();
        });
    }
    if (meetingDetectSwitchBtn) {
        meetingDetectSwitchBtn.addEventListener('click', () => {
            switchMeetingModeFromSuggestion();
        });
    }
}

function loadBuyMeCoffeeWidget() {
    if (isElectronEnvironment()) return;
    if (document.querySelector('script[data-name="BMC-Widget"]')) return;

    const script = document.createElement('script');
    script.src = 'https://cdnjs.buymeacoffee.com/1.0.0/widget.prod.min.js';
    script.async = true;
    script.setAttribute('data-name', 'BMC-Widget');
    script.setAttribute('data-cfasync', 'false');
    script.setAttribute('data-id', 'nickguy');
    script.setAttribute('data-description', 'Support me on Buy me a coffee!');
    script.setAttribute('data-message', 'Thanks for your coffee! : D');
    script.setAttribute('data-color', '#C23B22');
    script.setAttribute('data-position', 'Right');
    script.setAttribute('data-x_margin', '18');
    script.setAttribute('data-y_margin', '18');
    document.body.appendChild(script);
}

function createNativeSupportButton() {
    if (!isElectronEnvironment()) return;
    if (document.querySelector('.bmc-native-btn')) return;

    const button = document.createElement('button');
    button.className = 'bmc-native-btn';
    button.setAttribute('title', 'Support me on Buy Me a Coffee');
    button.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M17 8h1a4 4 0 0 1 0 8h-1"></path>
            <path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z"></path>
            <line x1="6" y1="1" x2="6" y2="4"></line>
            <line x1="10" y1="1" x2="10" y2="4"></line>
            <line x1="14" y1="1" x2="14" y2="4"></line>
        </svg>
        <span>Support</span>
    `;

    button.addEventListener('click', () => {
        const bmcUrl = 'https://buymeacoffee.com/nickguy';
        if (window.electronAPI && window.electronAPI.openExternal) {
            window.electronAPI.openExternal(bmcUrl);
        } else {
            window.open(bmcUrl, '_blank');
        }
    });

    document.body.appendChild(button);
}

const api = {
    async getSettings() {
        if (window.electronAPI && window.electronAPI.getSettings) {
            return window.electronAPI.getSettings();
        }
        const response = await fetch('/api/v1/settings');
        if (!response.ok) throw new Error('Failed to load settings');
        return response.json();
    },
    async setSettings(payload) {
        if (window.electronAPI && window.electronAPI.setSettings) {
            return window.electronAPI.setSettings(payload);
        }
        const response = await fetch('/api/v1/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error('Failed to save settings');
        return response.json().catch(() => ({}));
    },
    async rememberSpeakerLabel(speakerKey, label) {
        if (window.electronAPI && window.electronAPI.rememberSpeakerLabel) {
            return window.electronAPI.rememberSpeakerLabel({ speakerKey, label });
        }
        return null;
    },
    async listJobs() {
        if (window.electronAPI && window.electronAPI.listTranscriptionJobs) {
            return window.electronAPI.listTranscriptionJobs();
        }
        const response = await fetch('/api/v1/transcription_jobs');
        if (!response.ok) throw new Error('Failed to load jobs');
        return response.json();
    },
    async getJob(jobId) {
        if (window.electronAPI && window.electronAPI.getTranscriptionJob) {
            return window.electronAPI.getTranscriptionJob(jobId);
        }
        const response = await fetch(`/api/v1/transcription_jobs/${jobId}`);
        if (!response.ok) throw new Error('Failed to load job');
        return response.json();
    },
    async getJobAudio(jobId) {
        if (window.electronAPI && window.electronAPI.getJobAudio) {
            return window.electronAPI.getJobAudio(jobId);
        }
        return null;
    },
    async enqueueJob(file) {
        if (window.electronAPI && window.electronAPI.enqueueTranscriptionJob) {
            const payload = { name: file.name };
            if (file.path) {
                payload.path = file.path;
            } else {
                payload.bytes = await file.arrayBuffer();
            }
            const job = await window.electronAPI.enqueueTranscriptionJob(payload);
            return { job };
        }
        const formData = new FormData();
        formData.append('file', file);
        const response = await fetch('/api/v1/transcription_jobs', { method: 'POST', body: formData });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.detail || 'Upload failed');
        }
        return response.json();
    },
    async saveLiveTranscription(payload) {
        if (window.electronAPI && window.electronAPI.saveLiveTranscription) {
            return window.electronAPI.saveLiveTranscription(payload);
        }
        return null;
    },
    async saveLiveAudio(payload) {
        if (window.electronAPI && window.electronAPI.saveLiveAudio) {
            return window.electronAPI.saveLiveAudio(payload);
        }
        return null;
    },
    async completeLiveAudioJob(payload) {
        if (window.electronAPI && window.electronAPI.completeLiveAudioJob) {
            return window.electronAPI.completeLiveAudioJob(payload);
        }
        return null;
    },
    async generateMeetingNotes(jobId) {
        if (window.electronAPI && window.electronAPI.generateMeetingNotes) {
            return window.electronAPI.generateMeetingNotes(jobId);
        }
        return null;
    },
    async polishJob(jobId) {
        if (window.electronAPI && window.electronAPI.polishTranscriptionJob) {
            return window.electronAPI.polishTranscriptionJob({ jobId });
        }
        const response = await fetch(`/api/v1/transcription_jobs/${jobId}/polish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        if (!response.ok) throw new Error('Polish failed');
        return response.json();
    },
    async retranscribeJob(jobId) {
        if (window.electronAPI && window.electronAPI.retranscribeJob) {
            return window.electronAPI.retranscribeJob(jobId);
        }
        const response = await fetch(`/api/v1/transcription_jobs/${jobId}/retranscribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        if (!response.ok) throw new Error('Failed to queue re-transcription');
        return response.json().catch(() => ({}));
    },
    async deleteJob(jobId) {
        if (window.electronAPI && window.electronAPI.deleteTranscriptionJob) {
            return window.electronAPI.deleteTranscriptionJob(jobId);
        }
        const response = await fetch(`/api/v1/transcription_jobs/${jobId}`, {
            method: 'DELETE'
        });
        if (!response.ok) throw new Error('Delete failed');
        return response.json().catch(() => ({ deleted: true }));
    },
    async exportJob(jobId) {
        if (window.electronAPI && window.electronAPI.exportTranscriptionJob) {
            return window.electronAPI.exportTranscriptionJob(jobId);
        }
        const response = await fetch(`/api/v1/transcription_jobs/${jobId}/export`);
        if (!response.ok) throw new Error('Export failed');
        return response.json();
    },
    async shareMeetingToNotion(jobId) {
        if (window.electronAPI && window.electronAPI.shareMeetingToNotion) {
            return window.electronAPI.shareMeetingToNotion({ jobId });
        }
        return { ok: false, message: 'Notion sharing unavailable in web mode' };
    },
    async updateActionItems(jobId, completedItems) {
        if (window.electronAPI && window.electronAPI.updateActionItems) {
            return window.electronAPI.updateActionItems({ jobId, completedItems });
        }
        return null;
    }
};

// ============================================
// Featured Transcription
// ============================================
async function loadFeaturedTranscription() {
    try {
        const jobsData = await api.listJobs();
        // Find the most recent completed job
        const completedJobs = jobsData.filter(j => j.status === 'completed');
        if (completedJobs.length === 0) {
            if (featuredTranscription) featuredTranscription.style.display = 'none';
            return;
        }

        // Get the first (most recent) completed job
        const latestJob = completedJobs[0];
        const detail = await api.getJob(latestJob.id);
        latestJobResult = detail;
        renderFeaturedTranscription(detail);

    } catch (e) {
        console.warn('Failed to load featured transcription:', e);
    }
}

function renderFeaturedTranscription(detail) {
    if (!featuredTranscription || !detail) return;

    const result = detail.result;
    if (!result) {
        featuredTranscription.style.display = 'none';
        return;
    }

    // Prefer polished text (readability), fall back to raw transcript
    let displayText = '';
    let isPolished = false;
    if (result.readability && result.readability.text) {
        displayText = result.readability.text;
        isPolished = true;
    } else if (result.speech_segments && result.speech_segments.length > 0) {
        displayText = result.speech_segments.map(s => s.content).join('\n');
    } else if (result.summary) {
        displayText = result.summary;
    }

    if (!displayText) {
        featuredTranscription.style.display = 'none';
        return;
    }

    featuredTranscription.style.display = 'block';
    if (featuredTitle) featuredTitle.textContent = escapeHtml(result.title || 'Latest Transcription');
    if (featuredDate) featuredDate.textContent = detail.created_at ? new Date(detail.created_at).toLocaleDateString() : '';
    if (featuredContent) featuredContent.textContent = displayText;

    // Update polish indicator based on content type
    const indicator = document.getElementById('polishIndicator');
    if (isPolished) {
        featuredTranscription.classList.remove('polish-disabled');
        featuredTranscription.classList.add('polish-enabled');
        if (indicator) {
            indicator.innerHTML = '<span class="polish-dot">✦</span><span class="polish-text">Polished</span>';
        }
    } else {
        featuredTranscription.classList.remove('polish-enabled');
        featuredTranscription.classList.add('polish-disabled');
        if (indicator) {
            indicator.innerHTML = '<span class="polish-dot">◇</span><span class="polish-text">Raw transcript</span>';
        }
    }
}

function setupFeaturedCopyBtn() {
    if (!featuredCopyBtn) return;

    featuredCopyBtn.addEventListener('click', async () => {
        const text = featuredContent?.textContent;
        if (!text) return;

        try {
            await navigator.clipboard.writeText(text);
            featuredCopyBtn.classList.add('copied');
            showToast('Copied to clipboard');
            setTimeout(() => {
                featuredCopyBtn.classList.remove('copied');
            }, 1500);
        } catch (err) {
            console.error('Clipboard copy failed:', err);
        }
    });
}

// ============================================
// Mode Selector
// ============================================
function setupModeSelector() {
    modeOptions.forEach(option => {
        option.addEventListener('click', () => {
            const mode = option.dataset.mode;
            if (!mode) return;
            applyModeSelection(mode, { persist: true, syncMainProcess: true });
        });
    });
}

// ============================================
// Polish and Copy Functions
// ============================================
async function retranscribeJob(jobId) {
    const confirmed = confirm('Re-transcribe this audio? The current transcription will be replaced.');
    if (!confirmed) return;

    const defaultBtnHtml = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <polyline points="1 4 1 10 7 10"></polyline>
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
        </svg>
        <span>Re-transcribe</span>
    `;

    try {
        const btn = document.getElementById('detailRetranscribeBtn');
        if (btn) {
            btn.classList.add('loading');
            btn.innerHTML = `
                <svg class="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
                </svg>
                <span>Queued...</span>
            `;
        }

        await api.retranscribeJob(jobId);
        showToast('Re-transcription queued');

        const jobIndex = jobs.findIndex(j => j.id === jobId);
        if (jobIndex >= 0) {
            jobs[jobIndex].status = 'pending';
            jobs[jobIndex].progress = 0;
            jobs[jobIndex].isRetranscribe = true;
        } else {
            jobs.unshift({
                id: jobId,
                name: selectedTranscription?.title || 'Untitled',
                status: 'pending',
                diarization_status: null,
                progress: 0,
                created_at: new Date().toISOString(),
                isRetranscribe: true
            });
        }
        renderJobsList();
        updateProcessingSection();
        renderRecentTranscriptions();
        renderLibrary();

        switchView('library');
        loadJobs();
        pollJobUntilDone(jobId, {
            sendToMain: false,
            completionToast: 'Re-transcription complete'
        });
        loadFeaturedTranscription();
    } catch (e) {
        console.error('Retranscribe error:', e);
        const errorMsg = e && e.message ? e.message : 'Failed to re-transcribe';
        showToast(errorMsg);
    } finally {
        const btn = document.getElementById('detailRetranscribeBtn');
        if (btn) {
            btn.classList.remove('loading');
            btn.innerHTML = defaultBtnHtml;
        }
    }
}

async function polishTranscript(jobId) {
    try {
        const polishBtn = document.getElementById('detailPolishBtn');
        if (polishBtn) {
            polishBtn.classList.add('loading');
            polishBtn.innerHTML = `
                <svg class="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
                </svg>
                <span>Polishing...</span>
            `;
        }

        const result = await api.polishJob(jobId);
        showToast('Transcript polished');

        // Update the polished content display
        const polishedTextEl = document.getElementById('polishedText');
        const polishedSection = document.getElementById('polishedSection');
        if (polishedTextEl && result.readability?.text) {
            polishedTextEl.textContent = result.readability.text;
            if (polishedSection) polishedSection.style.display = 'block';
        }

        // Reload the transcription to get updated data
        if (selectedTranscription) {
            const detail = await api.getJob(jobId);
            if (detail.result) {
                // Update local data
                const newTranscription = resultToTranscription(
                    detail.result,
                    jobId,
                    detail.created_at,
                    detail.duration,
                    detail.audio_path,
                    detail.diarization_status
                );
                const idx = transcriptions.findIndex(t => t.id === jobId);
                if (idx >= 0) transcriptions[idx] = newTranscription;
                selectedTranscription = newTranscription;
            }
        }

        // Also refresh featured transcription
        loadFeaturedTranscription();

    } catch (e) {
        console.error('Polish error:', e);
        const errorMsg = e && e.message ? e.message : 'Failed to polish transcript';
        showToast(errorMsg);
    } finally {
        const polishBtn = document.getElementById('detailPolishBtn');
        if (polishBtn) {
            polishBtn.classList.remove('loading');
            polishBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M12 3l1.912 5.813a2 2 0 0 0 1.275 1.275L21 12l-5.813 1.912a2 2 0 0 0-1.275 1.275L12 21l-1.912-5.813a2 2 0 0 0-1.275-1.275L3 12l5.813-1.912a2 2 0 0 0 1.275-1.275L12 3z"></path>
                </svg>
                <span>Polish</span>
            `;
        }
    }
}

async function copyTranscriptText(jobId) {
    try {
        // First try to get polished text, then fall back to raw transcript
        const polishedTextEl = document.getElementById('polishedText');
        let text = polishedTextEl?.textContent;

        if (!text) {
            // Get raw transcript from segments
            const detail = await api.getJob(jobId);
            if (detail.result) {
                if (detail.result.readability?.text) {
                    text = detail.result.readability.text;
                } else if (detail.result.speech_segments) {
                    text = detail.result.speech_segments.map(s => s.content).join('\n');
                }
            }
        }

        if (!text) {
            showToast('No transcript to copy');
            return;
        }

        await navigator.clipboard.writeText(text);

        const copyBtn = document.getElementById('transcriptCopyBtn');
        if (copyBtn) {
            copyBtn.classList.add('copied');
            setTimeout(() => copyBtn.classList.remove('copied'), 1500);
        }

        showToast('Copied to clipboard');
    } catch (e) {
        console.error('Copy error:', e);
        showToast('Failed to copy');
    }
}

// ============================================
// Download and Delete Functions
// ============================================
async function downloadTranscript(jobId) {
    try {
        const data = await api.exportJob(jobId);
        if (!data || !data.markdown) {
            showToast('Nothing to download');
            return;
        }
        const blob = new Blob([data.markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = data.filename || 'transcript.md';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('Download started');
    } catch (e) {
        console.error('Download error:', e);
        showToast('Failed to download');
    }
}

async function copyMeetingMarkdown(jobId) {
    try {
        const data = await api.exportJob(jobId);
        if (!data?.markdown) {
            showToast('No content to copy');
            return;
        }
        await navigator.clipboard.writeText(data.markdown);
        showToast('Copied to clipboard');
    } catch (e) {
        console.error('Copy markdown error:', e);
        showToast('Failed to copy');
    }
}

async function shareMeetingByEmail(jobId) {
    try {
        const data = await api.exportJob(jobId);
        if (!data?.markdown) {
            showToast('No meeting notes to share');
            return;
        }
        const subject = encodeURIComponent(`Meeting Notes: ${data.title || 'Untitled Meeting'}`);
        const maxBodyLength = 6000;
        const bodyText = data.markdown.length > maxBodyLength
            ? `${data.markdown.slice(0, maxBodyLength)}\n\n[Message truncated. Open the app to view the full transcript.]`
            : data.markdown;
        const body = encodeURIComponent(bodyText);
        const mailtoUrl = `mailto:?subject=${subject}&body=${body}`;
        if (window.electronAPI?.openExternal) {
            const opened = await window.electronAPI.openExternal(mailtoUrl);
            if (!opened) {
                window.location.href = mailtoUrl;
            }
        } else {
            window.location.href = mailtoUrl;
        }
    } catch (e) {
        console.error('Email share error:', e);
        showToast('Failed to share by email');
    }
}

async function shareMeetingToNotion(jobId) {
    try {
        const mcpResult = await api.shareMeetingToNotion(jobId);
        if (mcpResult?.ok) {
            if (mcpResult.pageUrl && window.electronAPI?.openExternal) {
                await window.electronAPI.openExternal(mcpResult.pageUrl);
            }
            showToast('Shared to Notion');
            return;
        }

        const data = await api.exportJob(jobId);
        if (!data?.markdown) {
            showToast('No meeting notes to share');
            return;
        }

        // Fallback path when MCP is unavailable.
        await navigator.clipboard.writeText(data.markdown);
        const notionUrl = 'https://www.notion.so/new';
        if (window.electronAPI?.openExternal) {
            await window.electronAPI.openExternal(notionUrl);
        } else {
            window.open(notionUrl, '_blank');
        }
        if (mcpResult?.message) {
            showToast(`Notion MCP unavailable: ${mcpResult.message}. Markdown copied.`);
        } else {
            showToast('✓ Markdown copied! Paste into the Notion page.');
        }
    } catch (e) {
        console.error('Notion share error:', e);
        showToast('Failed to share to Notion');
    }
}

async function deleteTranscription(jobId) {
    const confirmed = confirm('Are you sure you want to delete this transcription? This cannot be undone.');
    if (!confirmed) return;

    try {
        await api.deleteJob(jobId);
        showToast('Transcription deleted');

        // Remove from local arrays
        const jobIndex = jobs.findIndex(j => j.id === jobId);
        if (jobIndex >= 0) jobs.splice(jobIndex, 1);

        const transcriptionIndex = transcriptions.findIndex(t => t.id === jobId);
        if (transcriptionIndex >= 0) transcriptions.splice(transcriptionIndex, 1);

        // Clear selected transcription
        selectedTranscription = null;

        // Return to previous view
        switchView(activeView === 'library' ? 'library' : 'home');

        // Refresh lists
        renderJobsList();
        renderRecentTranscriptions();
        renderLibrary();
        loadFeaturedTranscription();
    } catch (e) {
        console.error('Delete error:', e);
        showToast(e.message || 'Failed to delete');
    }
}

// ============================================
// View Navigation
// ============================================
function switchView(viewName) {
    activeView = viewName;
    selectedTranscription = null;
    summaryReturnView = null;
    detailReturnView = null;
    cleanupDetailAudio();
    cleanupSummaryAudio();

    // Hide all views
    [homeView, libraryView, jobsView, settingsView, detailView, meetingSummaryView].forEach(view => {
        if (view) view.style.display = 'none';
    });

    // Update nav tabs
    navTabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.view === viewName);
    });

    // Show selected view
    switch (viewName) {
        case 'home':
            if (homeView) homeView.style.display = 'block';
            renderRecentTranscriptions();
            break;
        case 'library':
            if (libraryView) libraryView.style.display = 'block';
            renderLibrary();
            break;
        case 'jobs':
            if (jobsView) jobsView.style.display = 'block';
            loadJobs();
            break;
        case 'settings':
            if (settingsView) settingsView.style.display = 'block';
            break;
    }
}

function showTranscriptionDetail(transcription, fromView) {
    cleanupSummaryAudio();
    selectedTranscription = transcription;
    detailReturnView = fromView || null;

    // Hide other views
    [homeView, libraryView, jobsView, settingsView, meetingSummaryView].forEach(view => {
        if (view) view.style.display = 'none';
    });

    // Render detail view
    renderDetailView(transcription);
    if (detailView) detailView.style.display = 'block';
}

function showMeetingSummary(transcription, fromView) {
    cleanupDetailAudio();
    cleanupSummaryAudio();
    selectedTranscription = transcription;
    summaryReturnView = fromView || null;

    // Hide other views
    [homeView, libraryView, jobsView, settingsView, detailView].forEach(view => {
        if (view) view.style.display = 'none';
    });

    // Clear nav tab active state (summary is not a nav tab destination)
    navTabs.forEach(tab => tab.classList.remove('active'));

    renderMeetingSummary(transcription);
    if (meetingSummaryView) meetingSummaryView.style.display = 'block';
}

function renderMeetingSummary(transcription) {
    if (!meetingSummaryView) return;

    const meetingNotes = transcription.meetingNotes;
    if (!meetingNotes) {
        meetingSummaryView.innerHTML = `
            <div class="animate-float-up">
                <button class="detail-back-btn" id="summaryBackBtn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <polyline points="9 18 15 12 9 6"></polyline>
                    </svg>
                    <span>Back</span>
                </button>
                <div class="summary-empty" id="summaryEmptyContainer">
                    <p>No meeting notes available yet.</p>
                    <button class="detail-action-btn" id="generateNotesBtn" title="Generate meeting notes from transcript">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <path d="M12 20h9"></path>
                            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                        </svg>
                        <span>Generate Notes</span>
                    </button>
                </div>
            </div>
        `;
        const backBtn = document.getElementById('summaryBackBtn');
        if (backBtn) backBtn.addEventListener('click', () => {
            if (summaryReturnView === 'detail') {
                showTranscriptionDetail(transcription);
            } else {
                switchView(activeView === 'library' ? 'library' : 'home');
            }
        });
        const generateBtn = document.getElementById('generateNotesBtn');
        if (generateBtn) generateBtn.addEventListener('click', async () => {
            const container = document.getElementById('summaryEmptyContainer');
            if (container) {
                container.innerHTML = '<p>Generating meeting notes...</p><div class="summary-spinner"></div>';
            }
            try {
                const result = await api.generateMeetingNotes(transcription.id);
                if (result && result.meeting_notes) {
                    transcription.meetingNotes = result.meeting_notes;
                    renderMeetingSummary(transcription);
                } else {
                    if (container) container.innerHTML = '<p>Failed to generate meeting notes. Please try again.</p>';
                }
            } catch (err) {
                if (container) container.innerHTML = `<p>Error: ${escapeHtml(err.message || 'Generation failed')}</p>`;
            }
        });
        return;
    }

    const title = escapeHtml(transcription.title);
    const date = escapeHtml(transcription.date);
    const duration = escapeHtml(transcription.duration);

    // Load persisted action item completion state
    const completedItems = (meetingNotes._completedItems || []);

    const actionItemsHtml = (meetingNotes.action_items || []).map((item, i) => {
        const checked = completedItems.includes(i) ? 'checked' : '';
        const doneClass = completedItems.includes(i) ? ' done' : '';
        return `
            <label class="summary-action-item${doneClass}">
                <input type="checkbox" class="summary-action-checkbox" data-index="${i}" ${checked}>
                <span class="summary-action-text">${escapeHtml(item)}</span>
            </label>
        `;
    }).join('');

    const listHtml = (items) => {
        if (!items || items.length === 0) {
            return '<p class="summary-empty-text">None recorded.</p>';
        }
        return `
            <ul class="summary-list">
                ${items.map((item) => `<li class="summary-list-item">${escapeHtml(item)}</li>`).join('')}
            </ul>
        `;
    };

    const audioHtml = transcription.hasAudio ? `
        <div class="summary-audio" id="summaryAudioContainer">
            <audio id="summaryAudioPlayer" controls preload="metadata"></audio>
        </div>
    ` : '';

    meetingSummaryView.innerHTML = `
        <div class="animate-float-up">
            <button class="detail-back-btn" id="summaryBackBtn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
                <span>Back</span>
            </button>

            <div class="summary-header">
                <div class="summary-header-info">
                    <h1 class="summary-title font-display">${title}</h1>
                    <div class="summary-meta">
                        <span>${date}</span>
                        <span>·</span>
                        <span>${duration}</span>
                        <span class="meeting-badge">Meeting</span>
                    </div>
                </div>
                <div class="summary-actions">
                    <button class="detail-action-btn" id="summaryCopyBtn" title="Copy markdown">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                        <span>Copy</span>
                    </button>
                    <div class="export-btn-wrapper">
                        <button class="detail-action-btn" id="summaryExportBtn" title="Export">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                <polyline points="17 8 12 3 7 8"></polyline>
                                <line x1="12" x2="12" y1="3" y2="15"></line>
                            </svg>
                            <span>Export</span>
                        </button>
                        <div class="export-popup" id="summaryExportPopup">
                            <button class="export-popup-item" id="summaryExportDownloadBtn">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                    <polyline points="7 10 12 15 17 10"></polyline>
                                    <line x1="12" x2="12" y1="15" y2="3"></line>
                                </svg>
                                <span>Download</span>
                            </button>
                            <button class="export-popup-item" id="summaryExportNotionBtn">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                                    <path d="M8 16V8l7 8V8"></path>
                                </svg>
                                <span>Notion</span>
                            </button>
                        </div>
                    </div>
                    <button class="detail-action-btn" id="summaryViewFullBtn" title="View full transcript">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"></path>
                            <polyline points="14 2 14 8 20 8"></polyline>
                            <line x1="16" y1="13" x2="8" y2="13"></line>
                            <line x1="16" y1="17" x2="8" y2="17"></line>
                            <polyline points="10 9 9 9 8 9"></polyline>
                        </svg>
                        <span>Full Transcript</span>
                    </button>
                </div>
            </div>

            ${audioHtml}

            <div class="summary-card summary-executive">
                <h2 class="summary-section-title">EXECUTIVE SUMMARY</h2>
                <p class="summary-text">${meetingNotes.summary ? escapeHtml(meetingNotes.summary) : escapeHtml(transcription.briefing)}</p>
            </div>

            <div class="summary-grid">
                <div class="summary-card">
                    <h2 class="summary-section-title">DISCUSSION POINTS</h2>
                    ${listHtml(meetingNotes.discussion_points)}
                </div>

                <div class="summary-card summary-action-items-card">
                    <h2 class="summary-section-title">ACTION ITEMS</h2>
                    <div class="summary-action-items">
                        ${actionItemsHtml || '<p class="summary-empty-text">None recorded.</p>'}
                    </div>
                </div>

                <div class="summary-card">
                    <h2 class="summary-section-title">DECISIONS</h2>
                    ${listHtml(meetingNotes.decisions)}
                </div>

                <div class="summary-card">
                    <h2 class="summary-section-title">NEXT STEPS</h2>
                    ${listHtml(meetingNotes.next_steps)}
                </div>
            </div>
        </div>
    `;

    // Event listeners
    setupMeetingSummaryListeners(transcription);

    // Load audio if available
    if (transcription.hasAudio) {
        loadSummaryAudio(transcription.id);
    }
}

function setupMeetingSummaryListeners(transcription) {
    const backBtn = document.getElementById('summaryBackBtn');
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            if (summaryReturnView === 'detail') {
                showTranscriptionDetail(transcription);
            } else {
                switchView(activeView === 'library' ? 'library' : 'home');
            }
        });
    }

    const copyBtn = document.getElementById('summaryCopyBtn');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => copyMeetingMarkdown(transcription.id));
    }

    const exportBtn = document.getElementById('summaryExportBtn');
    const exportPopup = document.getElementById('summaryExportPopup');
    if (exportBtn && exportPopup) {
        exportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            exportPopup.classList.toggle('open');
        });
        document.addEventListener('click', () => exportPopup.classList.remove('open'), { once: false });
    }

    const exportDownloadBtn = document.getElementById('summaryExportDownloadBtn');
    if (exportDownloadBtn) {
        exportDownloadBtn.addEventListener('click', () => {
            exportPopup && exportPopup.classList.remove('open');
            downloadTranscript(transcription.id);
        });
    }

    const exportNotionBtn = document.getElementById('summaryExportNotionBtn');
    if (exportNotionBtn) {
        exportNotionBtn.addEventListener('click', () => {
            exportPopup && exportPopup.classList.remove('open');
            shareMeetingToNotion(transcription.id);
        });
    }

    const viewFullBtn = document.getElementById('summaryViewFullBtn');
    if (viewFullBtn) {
        viewFullBtn.addEventListener('click', () => showTranscriptionDetail(transcription, 'summary'));
    }

    // Action item checkboxes
    const checkboxes = meetingSummaryView.querySelectorAll('.summary-action-checkbox');
    checkboxes.forEach(checkbox => {
        checkbox.addEventListener('change', () => {
            const label = checkbox.closest('.summary-action-item');
            if (label) label.classList.toggle('done', checkbox.checked);
            persistActionItemState(transcription.id);
        });
    });
}

function persistActionItemState(jobId) {
    const checkboxes = meetingSummaryView.querySelectorAll('.summary-action-checkbox');
    const completedItems = [];
    checkboxes.forEach(cb => {
        if (cb.checked) completedItems.push(parseInt(cb.dataset.index, 10));
    });

    // Update in-memory transcription
    if (selectedTranscription && selectedTranscription.meetingNotes) {
        selectedTranscription.meetingNotes._completedItems = completedItems;
    }

    // Persist to backend
    api.updateActionItems(jobId, completedItems).catch(err => {
        console.warn('Failed to persist action items:', err);
    });
}

async function loadSummaryAudio(jobId) {
    const audioEl = document.getElementById('summaryAudioPlayer');
    const audioContainer = document.getElementById('summaryAudioContainer');
    if (!audioEl) return;

    const requestId = ++summaryAudioRequestId;
    if (audioContainer) audioContainer.classList.add('loading');

    try {
        const payload = await api.getJobAudio(jobId);
        if (requestId !== summaryAudioRequestId) return;
        if (!payload || !payload.data) {
            if (audioContainer) audioContainer.style.display = 'none';
            return;
        }
        const mimeType = payload.mimeType || 'application/octet-stream';
        const blob = new Blob([payload.data], { type: mimeType });
        const url = URL.createObjectURL(blob);
        summaryAudioUrl = url;
        audioEl.src = url;
    } catch (e) {
        if (requestId !== summaryAudioRequestId) return;
        console.warn('Failed to load summary audio:', e);
        if (audioContainer) audioContainer.style.display = 'none';
    } finally {
        if (audioContainer && requestId === summaryAudioRequestId) {
            audioContainer.classList.remove('loading');
        }
    }
}

// ============================================
// Recording Functions
// ============================================
function startTimer() {
    clearInterval(timerInterval);
    if (timer) timer.textContent = '00:00';
    startTime = Date.now();
    timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (timer) timer.textContent = formatTime(elapsed);
    }, 1000);
}

function stopTimer() {
    clearInterval(timerInterval);
}

function updateRecordingUI(recording) {
    const isMeeting = !!settings.meetingCaptureEnabled;

    if (recordButton) {
        recordButton.classList.toggle('recording', recording);
    }
    if (pulseRing1) pulseRing1.classList.toggle('active', recording);
    if (pulseRing2) pulseRing2.classList.toggle('active', recording);

    if (timer) timer.classList.toggle('active', recording);
    if (recordingLabel) {
        const idleLabel = isMeeting ? 'Start Meeting Capture' : 'Begin Recording';
        recordingLabel.textContent = recording ? (isMeeting ? 'Capturing Meeting' : '') : idleLabel;
        recordingLabel.style.display = recording && !isMeeting ? 'none' : 'block';
    }
    if (recordingHint) {
        if (recording) {
            recordingHint.textContent = isMeeting ? 'System audio + mic recording' : 'Recording in progress';
        } else {
            recordingHint.textContent = isMeeting
                ? 'Hotkey toggles start and stop for continuous meeting capture'
                : 'Tap to capture and transcribe';
        }
    }

    document.body.classList.toggle('is-recording', recording);
    document.body.classList.toggle('meeting-mode', isMeeting);
}

async function startRecording() {
    if (isRecording) return;

    // Clear any lingering meeting summary from previous session
    dismissMeetingCaptureSummary();
    hideMeetingModeSuggestionPrompt();

    try {
        const isMeetingMode = !!settings.meetingCaptureEnabled;

        if (currentProvider === 'gemini' && !isMeetingMode) {
            const geminiValue = (geminiKey?.value || '').trim();
            if (!geminiValue) {
                showToast('Gemini API key is required');
                return;
            }
        } else if (currentProvider === 'openai') {
            const openaiValue = (openaiKey?.value || '').trim();
            if (!openaiValue) {
                showToast('OpenAI API key is required');
                return;
            }
        }

        audioBuffer = new Int16Array(0);
        mediaRecorderChunks = [];

        // Validate cached stream is still alive
        if (streamInitialized && stream) {
            const tracks = stream.getAudioTracks();
            if (!tracks.length || tracks[0].readyState !== 'live') {
                console.warn('Microphone stream ended, re-acquiring');
                streamInitialized = false;
                stream = null;
            }
        }

        if (!streamInitialized) {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('Microphone access is not available.');
            }

            stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            streamInitialized = true;
        }

        if (!stream) throw new Error('Failed to initialize audio stream');

        isRecording = true;
        updateRecordingUI(true);
        liveMeetingModeActive = isMeetingMode;
        liveMeetingSegments = [];
        liveMeetingDisplaySegments = [];
        liveMeetingTranscript = '';
        if (isMeetingMode) {
            liveTranscriptCollapsed = false;
            resetLiveTranscriptPanel({ hide: false });
        } else {
            resetLiveTranscriptPanel({ hide: true });
        }

        if (currentProvider === 'gemini' && !isMeetingMode) {
            console.log('Starting MediaRecorder for Gemini mode');
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) {
                    mediaRecorderChunks.push(e.data);
                }
            };
            mediaRecorder.start(1000);
        } else if (currentProvider === 'openai') {
            console.log('Starting OpenAI live mode');
            // Start a parallel MediaRecorder to capture audio for storage
            liveMediaRecorderChunks = [];
            liveRecordingStartTime = Date.now();
            try {
                liveMediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
                liveMediaRecorder.ondataavailable = (e) => {
                    if (e.data.size > 0) {
                        liveMediaRecorderChunks.push(e.data);
                    }
                };
                liveMediaRecorder.start(1000);
            } catch (err) {
                console.warn('Could not start live MediaRecorder:', err);
                liveMediaRecorder = null;
            }
            await initLiveSession({ meetingMode: isMeetingMode });
        }

        startTimer();

    } catch (error) {
        console.error('Error starting recording:', error);
        // Stop parallel MediaRecorder if it was started before the error
        if (liveMediaRecorder && liveMediaRecorder.state !== 'inactive') {
            liveMediaRecorder.stop();
        }
        liveMediaRecorder = null;
        liveMediaRecorderChunks = [];
        liveRecordingStartTime = null;
        resetLiveTranscriptPanel({ hide: true });
        isRecording = false;
        updateRecordingUI(false);
        stopTimer();
        showToast('Error: ' + error.message);
    }
}

async function stopRecording() {
    if (!isRecording) return;

    isRecording = false;
    updateRecordingUI(false);
    stopTimer();

    if (currentProvider === 'gemini' && mediaRecorder && mediaRecorder.state !== 'inactive') {
        console.log('Stopping MediaRecorder');

        const recordingPromise = new Promise((resolve) => {
            mediaRecorder.onstop = async () => {
                console.log('MediaRecorder stopped, chunks:', mediaRecorderChunks.length);
                if (mediaRecorderChunks.length > 0) {
                    const webmBlob = new Blob(mediaRecorderChunks, { type: 'audio/webm' });
                    const audioFileBlob = new File([webmBlob], 'recording.webm', { type: 'audio/webm' });
                    showToast('Processing recording...');
                    await uploadAudioFile(audioFileBlob);
                }
                mediaRecorderChunks = [];
                resolve();
            };
        });

        mediaRecorder.stop();
        await recordingPromise;
    } else if (currentProvider === 'openai') {
        console.log('Stopping OpenAI live mode');
        showToast('Processing transcription...');

        // Stop the parallel MediaRecorder first to finalize audio capture
        if (liveMediaRecorder && liveMediaRecorder.state !== 'inactive') {
            await new Promise((resolve) => {
                liveMediaRecorder.onstop = () => resolve();
                liveMediaRecorder.stop();
            });
        }
        // Capture end timestamp now, before any async processing delay
        liveRecordingEndTime = Date.now();

        // Persist raw audio immediately so it survives orchestration timeouts
        if (liveMediaRecorderChunks.length > 0) {
            try {
                const blob = new Blob(liveMediaRecorderChunks, { type: 'audio/webm' });
                const audioBytes = await blob.arrayBuffer();
                const payload = { audioBytes };
                if (liveRecordingStartTime) {
                    const endTime = liveRecordingEndTime || Date.now();
                    const elapsed = Math.round((endTime - liveRecordingStartTime) / 1000);
                    payload.duration = formatDuration(elapsed);
                }
                const saved = await api.saveLiveAudio(payload);
                if (saved && saved.id) {
                    liveEarlyJobId = saved.id;
                }
            } catch (error) {
                console.warn('Failed to persist live audio before transcription:', error);
                liveEarlyJobId = null;
            }
        }

        // Disconnect liveSource before flushing to prevent post-flush audio loss
        if (liveSource) {
            liveSource.disconnect();
            liveSource = null;
        }

        // Flush residual audio from the worklet buffer before committing
        if (liveAudioWorklet) {
            const originalHandler = liveAudioWorklet.port.onmessage;
            await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    console.warn('AudioWorklet flush timed out after 2000ms');
                    liveAudioWorklet.port.onmessage = originalHandler;
                    resolve();
                }, 2000);
                liveAudioWorklet.port.onmessage = (event) => {
                    if (event.data && event.data.flushed) {
                        clearTimeout(timeout);
                        liveAudioWorklet.port.onmessage = originalHandler;
                        resolve();
                    } else {
                        // Forward PCM audio chunks normally
                        if (originalHandler) originalHandler(event);
                    }
                };
                liveAudioWorklet.port.postMessage({ command: 'flush' });
            });
            console.log('AudioWorklet buffer flushed');
        }

        // Brief pause to let in-flight IPC audio chunks arrive at the backend
        await new Promise((resolve) => setTimeout(resolve, 350));

        let stopResult = null;
        if (window.electronAPI && window.electronAPI.openAIRealtimeStop) {
            stopResult = await window.electronAPI.openAIRealtimeStop({ meetingMode: liveMeetingModeActive });
        }

        if (liveMeetingModeActive) {
            const transcriptFromStop = stopResult && typeof stopResult === 'object'
                ? (stopResult.transcript || '')
                : '';
            const transcript = transcriptFromStop || liveMeetingTranscript || liveMeetingSegments.join('\n').trim();
            await finalizeMeetingCapture(transcript);
        }
    }
}

function resetRecordingState() {
    if (isRecording) {
        isRecording = false;
        updateRecordingUI(false);
        stopTimer();
    }

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.ondataavailable = null;
        mediaRecorder.onstop = null;
        try {
            mediaRecorder.stop();
        } catch (error) {
            console.warn('Failed to stop MediaRecorder during reset:', error);
        }
        mediaRecorderChunks = [];
    }

    liveMeetingModeActive = false;
    liveMeetingSegments = [];
    liveMeetingDisplaySegments = [];
    liveMeetingTranscript = '';
    resetLiveTranscriptPanel({ hide: true });
    cleanupLiveAudio();
}

// ============================================
// OpenAI Live Mode Functions
// ============================================
function ensureOpenAIListener() {
    if (openAIListenerAttached || !window.electronAPI || !window.electronAPI.onOpenAIRealtimeEvent) {
        return;
    }
    window.electronAPI.onOpenAIRealtimeEvent((payload) => {
        handleLiveMessage(payload);
    });
    openAIListenerAttached = true;
}

async function initLiveSession(options = {}) {
    if (!window.electronAPI || !window.electronAPI.openAIRealtimeStart) {
        throw new Error('Live mode requires the Electron backend');
    }

    liveSessionStarting = true;
    liveSavedForSession = false;
    liveMeetingModeActive = !!options.meetingMode;
    ensureOpenAIListener();

    try {
        const startSessionPromise = window.electronAPI.openAIRealtimeStart({ meetingMode: liveMeetingModeActive });
        const startAudioPromise = startAudioStreaming();
        await Promise.all([startSessionPromise, startAudioPromise]);
        liveSessionActive = true;
    } catch (error) {
        console.error('OpenAI session error:', error);
        const message = error && error.message ? error.message : 'Connection error';
        showToast(message);
    } finally {
        liveSessionStarting = false;
    }
}

async function startAudioStreaming() {
    try {
        // Check stream is available first
        if (!stream) {
            throw new Error('Audio stream not initialized');
        }

        // Create AudioContext with 24kHz sample rate (OpenAI requirement)
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            throw new Error('AudioContext not supported');
        }

        const audioCtx = new AudioContextClass({ sampleRate: 24000 });
        if (!audioCtx || !(audioCtx instanceof AudioContext || audioCtx instanceof webkitAudioContext)) {
            throw new Error('Failed to create AudioContext');
        }
        liveAudioContext = audioCtx;
        // AudioContext may start suspended when created outside a user gesture
        // (e.g., triggered via IPC from a global hotkey)
        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }
        console.log('AudioContext created, state:', audioCtx.state);

        liveSource = audioCtx.createMediaStreamSource(stream);

        // Load audio worklet module
        console.log('Loading audio worklet module...');
        const workletUrl = new URL('static/audio-processor.js', window.location.href);
        await audioCtx.audioWorklet.addModule(workletUrl.toString());
        console.log('Audio worklet module loaded');

        // Guard: check context still valid after await (race condition protection)
        if (audioCtx.state === 'closed' || liveAudioContext !== audioCtx) {
            console.warn('AudioContext closed during initialization, aborting');
            return;
        }

        console.log('Creating AudioWorkletNode with context:', audioCtx, 'state:', audioCtx.state);
        liveAudioWorklet = new AudioWorkletNode(audioCtx, 'audio-processor');

        liveAudioWorklet.port.onmessage = (event) => {
            if (window.electronAPI && window.electronAPI.openAIRealtimeSendAudio) {
                window.electronAPI.openAIRealtimeSendAudio(event.data);
            }
        };

        liveSource.connect(liveAudioWorklet);
        console.log('Audio streaming started successfully');
    } catch (error) {
        console.error('Error starting audio streaming:', error);
        showToast('Audio error: ' + error.message);
    }
}

function handleLiveMessage(data) {
    console.log('Live message received:', data.type, 'isRecording:', isRecording, 'liveSessionStarting:', liveSessionStarting);

    if (data.type === 'segment') {
        if (liveMeetingModeActive) {
            appendMeetingSegment(data.segment);
        }
    } else if (data.type === 'text') {
        if (liveMeetingModeActive) {
            // Meeting mode uses only segment events.
            return;
        }
        if (data.isNewResponse) {
            displayLiveTranscription(data.content);
        } else {
            appendLiveTranscription(data.content);
        }
    } else if (data.type === 'status') {
        console.log('Status update:', data.status);
        // Don't cleanup during session initialization or while recording
        if (liveSessionStarting || isRecording) {
            console.log('Ignoring status during active session');
            return;
        }
        if (liveMeetingModeActive) {
            return;
        }
        if (data.status === 'completed') {
            cleanupLiveAudio();
        }
    } else if (data.type === 'system_audio_permission') {
        if (data.status && data.status !== 'granted') {
            showToast('System audio unavailable, continuing with microphone only');
        }
    } else if (data.type === 'system_audio_error') {
        showToast(data.content || 'System audio capture error');
    } else if (data.type === 'system_audio_recovering') {
        showSystemAudioWarning('System audio interrupted \u2014 recovering (attempt ' + data.attempt + '/' + data.maxAttempts + ')...');
    } else if (data.type === 'system_audio_recovered') {
        showToast('System audio recovered');
        hideSystemAudioWarning();
    } else if (data.type === 'system_audio_recovery_failed') {
        showSystemAudioWarning('System audio lost \u2014 continuing with microphone only');
    } else if (data.type === 'system_audio_status') {
        if (data.status === 'recording') {
            hideSystemAudioWarning();
        }
    } else if (data.type === 'meeting_notes_ready') {
        const jobId = data.jobId;
        if (!jobId) return;
        refreshJobFromBackend(jobId, true);
    } else if (data.type === 'meeting_notes_failed') {
        if (data.content) {
            console.warn('Meeting notes generation failed:', data.content);
        }
    } else if (data.type === 'error') {
        console.error('Server error:', data.content);
        showToast('Error: ' + data.content);
        cleanupLiveAudio();
        if (window.electronAPI) {
            window.electronAPI.sendTranscriptionError(data.content || 'Live transcription failed');
        }
    }
}

async function refreshJobFromBackend(jobId, showNotesToast = false) {
    try {
        const detail = await api.getJob(jobId);
        if (!detail) return;

        // Update jobs list even if there's no result yet (audio-only jobs)
        const jobIndex = jobs.findIndex(j => j.id === jobId);
        if (jobIndex >= 0) {
            jobs[jobIndex] = {
                ...jobs[jobIndex],
                name: detail.title || jobs[jobIndex].name,
                status: detail.status || jobs[jobIndex].status,
                diarization_status: detail.diarization_status || jobs[jobIndex].diarization_status || null,
            };
        } else {
            // Add audio-only job to jobs list so it appears in library for retry
            jobs.unshift({
                id: detail.id || jobId,
                name: detail.title || 'Recording (retry pending)',
                status: detail.status || 'pending',
                diarization_status: detail.diarization_status || null,
                progress: 0,
                created_at: detail.created_at
            });
        }

        // Only update transcriptions if we have a result
        if (detail.result) {
            const updated = resultToTranscription(
                detail.result,
                detail.id || jobId,
                detail.created_at,
                detail.duration,
                detail.audio_path,
                detail.diarization_status
            );

            const idx = transcriptions.findIndex(t => t.id === jobId);
            if (idx >= 0) {
                transcriptions[idx] = updated;
            } else {
                transcriptions.unshift(updated);
            }

            if (selectedTranscription && selectedTranscription.id === jobId) {
                selectedTranscription = updated;
                renderDetailView(updated);
            }
        }

        renderJobsList();
        updateProcessingSection();
        renderRecentTranscriptions();
        renderLibrary();

        if (showNotesToast) {
            showToast('Meeting notes ready');
        }
    } catch (e) {
        console.warn('Failed to refresh job data:', e);
    }
}

function displayLiveTranscription(text, options = {}) {
    const {
        autoComplete = true,
        persist = true,
        meetingMode = false
    } = options;

    // Update featured transcription block with the result
    if (featuredTranscription && featuredContent) {
        featuredTranscription.style.display = 'block';
        if (featuredTitle) featuredTitle.textContent = meetingMode ? 'Meeting Transcript' : 'Live Transcription';
        if (featuredDate) featuredDate.textContent = new Date().toLocaleDateString();
        featuredContent.textContent = text;

        // Update polish indicator
        const indicator = document.getElementById('polishIndicator');
        if (indicator) {
            indicator.innerHTML = '<span class="polish-dot">◇</span><span class="polish-text">Raw transcript</span>';
        }
    }
    showToast(meetingMode ? 'Meeting transcript complete' : 'Transcription complete');

    if (autoComplete && window.electronAPI && text && text.trim()) {
        window.electronAPI.sendTranscriptionComplete(text);
    }
    if (persist && text && text.trim()) {
        persistLiveTranscription(text, { meetingMode });
    }
}

function appendMeetingSegment(segment) {
    const clean = String(segment || '').trim();
    if (!clean) return;

    const now = new Date();
    const stamp = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    liveMeetingSegments.push(clean);
    liveMeetingDisplaySegments.push(`[${stamp}] ${clean}`);
    liveMeetingTranscript = liveMeetingSegments.join('\n');
    appendLiveTranscriptRow(stamp, clean);

    if (featuredTranscription && featuredContent) {
        featuredTranscription.style.display = 'block';
        if (featuredTitle) featuredTitle.textContent = 'Live Meeting Transcript';
        if (featuredDate) featuredDate.textContent = new Date().toLocaleDateString();
        featuredContent.textContent = liveMeetingDisplaySegments.join('\n');
    }
}

function displayMeetingCaptureSummary(text) {
    const preview = text.length > 300 ? text.slice(0, 300) + '...' : text;

    // Remove any previous summary
    const existing = document.getElementById('meetingSummary');
    if (existing) existing.remove();

    const summaryDiv = document.createElement('div');
    summaryDiv.className = 'meeting-summary';
    summaryDiv.id = 'meetingSummary';
    summaryDiv.innerHTML = `
        <h2 class="meeting-summary-title font-display">Meeting Capture Complete</h2>
        <div class="meeting-summary-badges">
            <span class="summary-badge">
                <svg class="spinner-small" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
                Meeting notes
            </span>
            <span class="summary-badge">
                <svg class="spinner-small" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
                Diarization
            </span>
        </div>
        <div class="meeting-summary-preview">${escapeHtml(preview)}</div>
        <button class="meeting-summary-cta" onclick="switchView('library')">
            View full result in Library
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
    `;

    // Insert after the featured-transcription-wrapper, preserving cached DOM refs
    const featuredWrapper = document.querySelector('.featured-transcription-wrapper');
    if (featuredWrapper) {
        // Hide the original featured block while summary is visible
        if (featuredTranscription) featuredTranscription.style.display = 'none';
        featuredWrapper.after(summaryDiv);
    }
}

function dismissMeetingCaptureSummary() {
    const summary = document.getElementById('meetingSummary');
    if (summary) summary.remove();
}

async function finalizeMeetingCapture(transcript) {
    const text = String(transcript || '').trim();

    if (!text) {
        if (liveEarlyJobId) {
            // Audio was saved — show it so user can retry transcription
            showToast('No transcript detected. Recording saved for retry.');
            refreshJobFromBackend(liveEarlyJobId);
            cleanupLiveAudio();
            if (window.electronAPI) {
                window.electronAPI.sendTranscriptionComplete('');
            }
        } else {
            cleanupLiveAudio();
            showToast('No meeting transcript captured');
            if (window.electronAPI) {
                window.electronAPI.sendTranscriptionError('No meeting transcript captured');
            }
        }
        liveMeetingModeActive = false;
        return;
    }

    displayMeetingCaptureSummary(text);
    await persistLiveTranscription(text, { meetingMode: true });
    cleanupLiveAudio();

    if (window.electronAPI) {
        window.electronAPI.sendTranscriptionComplete(text);
    }

    liveMeetingModeActive = false;
    liveMeetingDisplaySegments = [];
}

async function persistLiveTranscription(text, options = {}) {
    if (!text || !text.trim()) return;
    if (liveSavedForSession) return;
    liveSavedForSession = true;
    const isMeetingMode = !!options.meetingMode;

    try {
        let saved = null;
        if (liveEarlyJobId) {
            const payload = { jobId: liveEarlyJobId, text };
            if (isMeetingMode) {
                payload.meetingMode = true;
            }
            saved = await api.completeLiveAudioJob(payload);
            liveEarlyJobId = null;
        } else {
            // Fallback path for sessions that were not pre-saved
            const payload = { text };
            if (liveMediaRecorderChunks.length > 0) {
                const blob = new Blob(liveMediaRecorderChunks, { type: 'audio/webm' });
                const arrayBuf = await blob.arrayBuffer();
                payload.audioBytes = arrayBuf;
            }
            if (liveRecordingStartTime) {
                const endTime = liveRecordingEndTime || Date.now();
                const elapsed = Math.round((endTime - liveRecordingStartTime) / 1000);
                payload.duration = formatDuration(elapsed);
            }
            if (isMeetingMode) {
                payload.meetingMode = true;
            }
            saved = await api.saveLiveTranscription(payload);
        }

        liveMediaRecorderChunks = [];
        liveRecordingStartTime = null;
        liveRecordingEndTime = null;

        if (!saved || !saved.job) return;

        const job = saved.job;
        const result = saved.result;

        jobs.unshift({
            id: job.id,
            name: job.title || 'Live transcription',
            status: job.status,
            diarization_status: job.diarization_status || null,
            progress: job.status === 'completed' ? 100 : 50,
            created_at: job.created_at
        });
        renderJobsList();
        updateProcessingSection();

        if (result) {
            currentJobId = job.id;
            transcriptions.unshift(resultToTranscription(result, job.id, job.created_at, job.duration, job.audio_path, job.diarization_status));
            renderRecentTranscriptions();
            renderLibrary();
        }

        if (job.diarization_status === 'pending' || job.diarization_status === 'processing') {
            pollDiarizationUntilDone(job.id);
        }
    } catch (error) {
        liveSavedForSession = false;
        console.warn('Failed to persist live transcription:', error);
    }
}

function appendLiveTranscription(delta) {
    // Append incremental transcription to featured block
    if (featuredTranscription && featuredContent) {
        featuredTranscription.style.display = 'block';
        if (featuredTitle) featuredTitle.textContent = 'Live Transcription';
        featuredContent.textContent += delta;
    }
}

function cleanupLiveAudio() {
    liveSessionStarting = false;
    liveSessionActive = false;
    liveMeetingModeActive = false;
    liveMeetingSegments = [];
    liveMeetingDisplaySegments = [];
    liveMeetingTranscript = '';
    hideSystemAudioWarning();
    // Stop parallel MediaRecorder if still active
    if (liveMediaRecorder && liveMediaRecorder.state !== 'inactive') {
        liveMediaRecorder.stop();
    }
    liveMediaRecorder = null;
    liveMediaRecorderChunks = [];
    liveEarlyJobId = null;
    liveRecordingStartTime = null;
    liveRecordingEndTime = null;
    if (liveAudioWorklet) {
        liveAudioWorklet.disconnect();
        liveAudioWorklet = null;
    }
    if (liveSource) {
        liveSource.disconnect();
        liveSource = null;
    }
    if (liveAudioContext && liveAudioContext.state !== 'closed') {
        liveAudioContext.close();
        liveAudioContext = null;
    }
    if (window.electronAPI && window.electronAPI.openAIRealtimeDisconnect) {
        window.electronAPI.openAIRealtimeDisconnect();
    }
    resetLiveTranscriptPanel({ hide: true });
}

// ============================================
// File Upload
// ============================================
async function handleAudioFile(file) {
    const validTypes = [
        'audio/wav', 'audio/wave', 'audio/x-wav',
        'audio/mpeg', 'audio/mp3',
        'audio/ogg', 'audio/flac',
        'audio/mp4', 'audio/x-m4a'
    ];
    const lowerName = (file.name || '').toLowerCase();
    const looksLikeM4A = lowerName.endsWith('.m4a');

    if (!validTypes.includes(file.type) && !looksLikeM4A) {
        showToast('Please select a valid audio file');
        return;
    }
    if (file.size > 500 * 1024 * 1024) {
        showToast('File size must be less than 500MB');
        return;
    }
    await uploadAudioFile(file);
}

async function uploadAudioFile(file) {
    showToast('Uploading...');

    try {
        const { job } = await api.enqueueJob(file);
        showToast('Processing started');

        // Add to jobs list immediately
        jobs.unshift({
            id: job.id,
            name: job.title || file.name,
            status: 'processing',
            diarization_status: null,
            progress: 0,
            created_at: job.created_at
        });
        renderJobsList();

        // Poll for completion
        pollJobUntilDone(job.id);

    } catch (error) {
        console.error('Upload error:', error);
        showToast('Error: ' + error.message);
    }
}

async function pollJobUntilDone(jobId, options = {}) {
    const sendToMain = options.sendToMain !== false;
    const completionToast = options.completionToast || 'Transcription complete';
    let status = 'pending';
    let latestDetail = null;

    while (status === 'pending' || status === 'processing') {
        try {
            const data = await api.getJob(jobId);
            latestDetail = data;
            status = data.status;

            // Update job in list
            const jobIndex = jobs.findIndex(j => j.id === jobId);
            if (jobIndex >= 0) {
                jobs[jobIndex].status = status;
                jobs[jobIndex].diarization_status = data.diarization_status || jobs[jobIndex].diarization_status || null;
                jobs[jobIndex].progress = status === 'completed' ? 100 : (jobs[jobIndex].progress + 10) % 100;
            }
            renderJobsList();
            updateProcessingSection();
            renderRecentTranscriptions();
            renderLibrary();

            if (status === 'completed' || status === 'failed') break;
        } catch (e) {
            console.warn('Polling error:', e);
        }
        await new Promise(r => setTimeout(r, 1500));
    }

    if (status === 'completed' && latestDetail?.result) {
        currentJobId = jobId;
        // Upsert in transcriptions
        const newTranscription = resultToTranscription(
            latestDetail.result,
            jobId,
            latestDetail.created_at,
            latestDetail.duration,
            latestDetail.audio_path,
            latestDetail.diarization_status
        );
        const idx = transcriptions.findIndex(t => t.id === jobId);
        if (idx >= 0) {
            transcriptions[idx] = newTranscription;
        } else {
            transcriptions.unshift(newTranscription);
        }
        renderRecentTranscriptions();
        renderLibrary();
        showToast(completionToast);
        // Refresh featured transcription
        loadFeaturedTranscription();

        // Send to Electron main process for text insertion
        if (sendToMain && window.electronAPI) {
            const text = latestDetail.result.speech_segments
                ?.map(s => s.content)
                .join(' ') || latestDetail.result.summary || '';
            window.electronAPI.sendTranscriptionComplete(text);
        }

        if (latestDetail.diarization_status === 'pending' || latestDetail.diarization_status === 'processing') {
            pollDiarizationUntilDone(jobId);
        }
    }

    if (status === 'failed') {
        const errorMessage = latestDetail?.error || 'Transcription failed';
        // Notify Electron main process of failure
        if (window.electronAPI) {
            window.electronAPI.sendTranscriptionError(errorMessage);
        }
        showToast(errorMessage);
    }
}

async function pollDiarizationUntilDone(jobId) {
    // Prevent concurrent polling for the same job (avoids doubled API requests and duplicate toasts)
    if (activeDiarizationPollers.has(jobId)) {
        return;
    }
    activeDiarizationPollers.add(jobId);

    let state = 'pending';
    let attempts = 0;
    try {
        while ((state === 'pending' || state === 'processing') && attempts < 120) {
            attempts += 1;
            try {
                const detail = await api.getJob(jobId);
                state = detail.diarization_status || 'completed';
                const jobIndex = jobs.findIndex(j => j.id === jobId);
                if (jobIndex >= 0) {
                    jobs[jobIndex].diarization_status = state;
                    renderJobsList();
                    updateProcessingSection();
                }

                if (state === 'completed' && detail.result) {
                    const updated = resultToTranscription(
                        detail.result,
                        jobId,
                        detail.created_at,
                        detail.duration,
                        detail.audio_path,
                        detail.diarization_status
                    );
                    const idx = transcriptions.findIndex(t => t.id === jobId);
                    if (idx >= 0) {
                        transcriptions[idx] = updated;
                    } else {
                        transcriptions.unshift(updated);
                    }
                    if (selectedTranscription && selectedTranscription.id === jobId) {
                        selectedTranscription = updated;
                        renderDetailView(updated);
                    }
                    renderRecentTranscriptions();
                    renderLibrary();
                    showToast('Speaker diarization complete');
                    return;
                }

                if (state === 'failed') {
                    showToast('Diarization failed');
                    return;
                }
            } catch (e) {
                console.warn('Diarization polling error:', e);
            }
            await new Promise(r => setTimeout(r, 2000));
        }
    } finally {
        activeDiarizationPollers.delete(jobId);
    }
}

function formatDuration(totalSeconds) {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function computeDurationFromSegments(segments) {
    if (!segments || segments.length === 0) return '0:00';
    // Find the last segment with an end_time
    for (let i = segments.length - 1; i >= 0; i--) {
        const endTime = segments[i].end_time;
        if (!endTime) continue;
        const str = String(endTime).trim();
        if (!str) continue;
        // Format: "120.5s" (seconds with s suffix)
        if (str.endsWith('s')) {
            const totalSec = Math.round(parseFloat(str));
            if (isNaN(totalSec)) continue;
            return formatDuration(totalSec);
        }
        // Format: "HH:MM:SS" or "MM:SS"
        const parts = str.split(':');
        if (parts.length >= 2) {
            let totalSec = 0;
            if (parts.length === 3) {
                totalSec = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
            } else {
                totalSec = parseInt(parts[0]) * 60 + parseInt(parts[1]);
            }
            if (isNaN(totalSec)) continue;
            return formatDuration(totalSec);
        }
        // Format: plain seconds "120.5" (Gemini may omit the 's' suffix)
        const plainSec = parseFloat(str);
        if (!isNaN(plainSec)) {
            return formatDuration(Math.round(plainSec));
        }
    }
    return '0:00';
}

function parseDurationToSeconds(val) {
    if (val == null) return null;
    // Number input
    if (typeof val === 'number') return Number.isFinite(val) && val >= 0 ? val : null;
    if (typeof val !== 'string') return null;
    const str = val.trim();
    if (!str) return null;
    // ISO-8601: PT3M45S, PT1H2M3.5S
    const iso = str.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
    if (iso && (iso[1] || iso[2] || iso[3])) {
        return (parseFloat(iso[1] || '0') * 3600) + (parseFloat(iso[2] || '0') * 60) + parseFloat(iso[3] || '0');
    }
    // Colon format: hh:mm:ss or mm:ss (with optional fractional seconds)
    const colonMatch = str.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
    const colonMatch3 = str.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
    if (colonMatch3) {
        const s = parseFloat(colonMatch3[1]) * 3600 + parseFloat(colonMatch3[2]) * 60 + parseFloat(colonMatch3[3]);
        return Number.isFinite(s) ? s : null;
    }
    if (colonMatch) {
        const s = parseFloat(colonMatch[1]) * 60 + parseFloat(colonMatch[2]);
        return Number.isFinite(s) ? s : null;
    }
    // Numeric string: "225", "225.5"
    const num = parseFloat(str);
    if (Number.isFinite(num) && num >= 0 && /^\d+(\.\d+)?$/.test(str)) return num;
    return null;
}

function countWords(segments) {
    let words = 0;
    if (segments) {
        for (const seg of segments) {
            if (seg.text) words += seg.text.trim().split(/\s+/).filter(Boolean).length;
        }
    }
    return words;
}

function resolveDuration(t) {
    // Try saved duration first
    let dur = parseDurationToSeconds(t.duration);
    if (dur != null) return { seconds: dur, derived: false };
    // Fallback: derive from segment timestamps
    if (t.segments && t.segments.length > 0) {
        const fallback = computeDurationFromSegments(t.segments);
        dur = parseDurationToSeconds(fallback);
        if (dur != null && dur > 0) return { seconds: dur, derived: true };
    }
    return { seconds: null, derived: false };
}

function computeUsageStats() {
    let totalSeconds = 0;
    let totalWords = 0;
    let wordsWithDuration = 0;
    let durationForWpm = 0;
    let missingDurationWithWordsCount = 0;
    let zeroDurationWithWordsCount = 0;
    let derivedDurationCount = 0;
    for (const t of transcriptions) {
        const words = countWords(t.segments);
        totalWords += words;
        const { seconds, derived } = resolveDuration(t);
        if (derived) derivedDurationCount++;
        if (seconds != null) {
            totalSeconds += seconds;
            if (seconds > 0) {
                wordsWithDuration += words;
                durationForWpm += seconds;
            } else if (words > 0) {
                zeroDurationWithWordsCount++;
            }
        } else if (words > 0) {
            missingDurationWithWordsCount++;
        }
    }
    const wpm = durationForWpm > 0 ? Math.round(wordsWithDuration / (durationForWpm / 60)) : 0;
    return {
        totalSeconds, totalWords, wpm,
        missingDurationWithWordsCount,
        zeroDurationWithWordsCount,
        derivedDurationCount
    };
}

function renderUsageStats() {
    const el = document.getElementById('usageStats');
    if (!el) return;
    if (!transcriptions || transcriptions.length === 0) {
        el.style.display = 'none';
        return;
    }
    const { totalSeconds, totalWords, wpm } = computeUsageStats();
    const hours = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const timeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    const wordsStr = totalWords.toLocaleString();
    el.innerHTML = `
        <div class="usage-stat">
            <span class="usage-stat-value font-display">${timeStr}</span>
            <span class="usage-stat-label">transcribed</span>
        </div>
        <div class="usage-stat-divider"></div>
        <div class="usage-stat">
            <span class="usage-stat-value font-display">${wordsStr}</span>
            <span class="usage-stat-label">words</span>
        </div>
        <div class="usage-stat-divider"></div>
        <div class="usage-stat">
            <span class="usage-stat-value font-display">${wpm}</span>
            <span class="usage-stat-label">wpm</span>
        </div>`;
    el.style.display = 'flex';
}

function resultToTranscription(result, jobId, createdAt, duration, audioPath, diarizationStatus) {
    const segments = result.speech_segments || [];
    const speakerColors = ['#4A4A4A', '#8B8B8B', '#A8A19A', '#6B7B5E', '#D4763A'];

    // Extract unique speaker names
    const uniqueSpeakers = segments
        .map((s, index) => String(s.speaker || `Speaker ${index + 1}`).trim())
        .filter(Boolean)
        .filter((name, index, arr) => arr.indexOf(name) === index)
        .slice(0, 5);

    // Build speaker objects with IDs and colors
    const speakers = uniqueSpeakers.map((rawName, i) => {
        const fallback = `Speaker ${i + 1}`;
        const resolvedRawName = rawName || fallback;
        return {
            id: `s${i + 1}`,
            rawName: resolvedRawName,
            speakerKey: normalizeSpeakerKey(resolvedRawName),
            name: resolveSpeakerLabel(resolvedRawName, fallback),
            color: speakerColors[i % speakerColors.length]
        };
    });

    // Map segments with speaker references
    const mappedSegments = segments.map((s, index) => {
        const rawSpeaker = String(s.speaker || `Speaker ${index + 1}`).trim();
        const speakerIndex = uniqueSpeakers.indexOf(rawSpeaker);
        const safeIndex = speakerIndex >= 0 ? speakerIndex : 0;
        return {
            speaker: `s${safeIndex + 1}`,
            rawSpeaker,
            text: s.content || '',
            time: s.start_time || ''
        };
    });

    // Use provided duration, or compute from segments, or fallback to 0:00
    const computedDuration = duration || computeDurationFromSegments(segments);
    const displayDate = createdAt
        ? new Date(createdAt).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

    return {
        id: jobId,
        title: result.title || 'Untitled Recording',
        date: displayDate,
        duration: computedDuration,
        status: 'complete',
        speakers,
        briefing: result.summary || '',
        segments: mappedSegments,
        isMeeting: !!result.is_meeting,
        readability: result.readability || null,
        hasAudio: !!audioPath,
        meetingNotes: result.meeting_notes || null,
        diarizationStatus: diarizationStatus || result.diarization_status || null
    };
}

function cleanupDetailAudio() {
    detailAudioRequestId += 1;
    if (detailAudioUrl) {
        URL.revokeObjectURL(detailAudioUrl);
        detailAudioUrl = null;
    }
    const audioEl = document.getElementById('detailAudioPlayer');
    if (audioEl) {
        if (typeof audioEl.pause === 'function') {
            audioEl.pause();
        }
        audioEl.removeAttribute('src');
        audioEl.load();
    }
}

function cleanupSummaryAudio() {
    summaryAudioRequestId += 1;
    if (summaryAudioUrl) {
        URL.revokeObjectURL(summaryAudioUrl);
        summaryAudioUrl = null;
    }
    const audioEl = document.getElementById('summaryAudioPlayer');
    if (audioEl) {
        if (typeof audioEl.pause === 'function') {
            audioEl.pause();
        }
        audioEl.removeAttribute('src');
        audioEl.load();
    }
}

async function loadDetailAudio(jobId) {
    const audioEl = document.getElementById('detailAudioPlayer');
    const audioContainer = document.getElementById('detailAudioContainer');
    if (!audioEl) return;

    const requestId = ++detailAudioRequestId;
    if (audioContainer) audioContainer.classList.add('loading');

    try {
        const payload = await api.getJobAudio(jobId);
        if (requestId !== detailAudioRequestId) return;
        if (!payload || !payload.data) {
            if (audioContainer) audioContainer.style.display = 'none';
            return;
        }
        const mimeType = payload.mimeType || 'application/octet-stream';
        const blob = new Blob([payload.data], { type: mimeType });
        const url = URL.createObjectURL(blob);
        detailAudioUrl = url;
        audioEl.src = url;
    } catch (e) {
        if (requestId !== detailAudioRequestId) return;
        console.warn('Failed to load audio:', e);
        if (audioContainer) audioContainer.style.display = 'none';
    } finally {
        if (audioContainer && requestId === detailAudioRequestId) {
            audioContainer.classList.remove('loading');
        }
    }
}

// ============================================
// Rendering Functions
// ============================================
function isTranscriptionReprocessing(jobId) {
    const job = jobs.find(j => j.id === jobId);
    return !!job && (job.status === 'pending' || job.status === 'processing');
}

function renderTranscriptionCard(transcription, horizontal = false, delay = 0) {
    const title = escapeHtml(transcription.title);
    const briefing = escapeHtml(transcription.briefing);
    const isReprocessing = isTranscriptionReprocessing(transcription.id);
    const processingClass = isReprocessing ? ' is-processing' : '';
    const isMeeting = !!transcription.isMeeting || !!transcription.meetingNotes;
    const meetingClass = isMeeting ? ' meeting-card' : '';
    const processingBadge = isReprocessing ? '<span class="transcription-card-badge">Re-transcribing...</span>' : '';
    const meetingBadge = isMeeting ? '<span class="meeting-badge">Meeting</span>' : '';
    const summaryBtn = isMeeting
        ? `<button class="card-summary-btn" data-summary-id="${transcription.id}" title="View meeting summary">Summary</button>`
        : '';
    const speakersHtml = transcription.speakers.slice(0, 3).map((s, i) => {
        const colorClass = i === 0 ? 'gray' : i === 1 ? 'light' : 'stone';
        const initial = escapeHtml(s.name.charAt(0));
        return `<div class="speaker-avatar ${colorClass}">${initial}</div>`;
    }).join('');
    const moreCount = transcription.speakers.length > 3 ? transcription.speakers.length - 3 : 0;
    const delayStyle = delay > 0 ? `animation-delay: ${delay}s;` : '';

    if (horizontal) {
        return `
            <div class="transcription-card horizontal animate-float-up${processingClass}${meetingClass}" data-id="${transcription.id}" data-type="${isMeeting ? 'meeting' : 'dictation'}" style="${delayStyle}">
                <div class="transcription-card-content">
                    <div class="transcription-card-header">
                        <h3 class="transcription-card-title">${title}</h3>${meetingBadge}${processingBadge}
                    </div>
                    <p class="transcription-card-briefing">${briefing}</p>
                    <div class="transcription-card-meta">
                        <span class="transcription-card-date">${escapeHtml(transcription.date)}</span>
                        ${summaryBtn}
                        <div class="speaker-avatars">
                            ${speakersHtml}
                            ${moreCount > 0 ? `<span class="speaker-more">+${moreCount}</span>` : ''}
                        </div>
                    </div>
                </div>
                <div class="transcription-card-arrow">
                    <span class="transcription-card-duration">${escapeHtml(transcription.duration)}</span>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <polyline points="9 18 15 12 9 6"></polyline>
                    </svg>
                </div>
            </div>
        `;
    }

    return `
        <div class="transcription-card animate-float-up${processingClass}${meetingClass}" data-id="${transcription.id}" data-type="${isMeeting ? 'meeting' : 'dictation'}" style="${delayStyle}">
            <div class="transcription-card-header">
                <h3 class="transcription-card-title">${title}</h3>${meetingBadge}${processingBadge}
                <span class="transcription-card-duration">${escapeHtml(transcription.duration)}</span>
            </div>
            <p class="transcription-card-briefing">${briefing}</p>
            <div class="transcription-card-meta">
                <span class="transcription-card-date">${escapeHtml(transcription.date)}</span>
                ${summaryBtn}
                <div class="speaker-avatars">
                    ${speakersHtml}
                    ${moreCount > 0 ? `<span class="speaker-more">+${moreCount}</span>` : ''}
                </div>
            </div>
        </div>
    `;
}

function attachSummaryButtonHandlers(container) {
    container.querySelectorAll('.card-summary-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.summaryId;
            const transcription = transcriptions.find(t => t.id == id);
            if (transcription) showMeetingSummary(transcription);
        });
    });
}

function renderRecentTranscriptions() {
    if (!recentTranscriptions) return;
    const recent = transcriptions.slice(0, 2);
    recentTranscriptions.innerHTML = recent.map((t, i) => renderTranscriptionCard(t, false, i * 0.1)).join('');

    // Add click handlers
    recentTranscriptions.querySelectorAll('.transcription-card').forEach(card => {
        card.addEventListener('click', () => {
            const id = card.dataset.id;
            if (isTranscriptionReprocessing(id)) {
                showToast('Re-transcription in progress');
                return;
            }
            const transcription = transcriptions.find(t => t.id == id);
            if (transcription) showTranscriptionDetail(transcription);
        });
    });
    attachSummaryButtonHandlers(recentTranscriptions);

    renderUsageStats();
}

let currentLibraryFilter = 'all';

function renderLibrary() {
    if (!libraryList) return;

    const filtered = currentLibraryFilter === 'all' ? transcriptions
        : currentLibraryFilter === 'meetings'
            ? transcriptions.filter(t => !!t.isMeeting || !!t.meetingNotes)
            : transcriptions.filter(t => !t.isMeeting && !t.meetingNotes);

    libraryList.innerHTML = filtered.map((t, i) => renderTranscriptionCard(t, true, i * 0.05)).join('');

    // Add click handlers
    libraryList.querySelectorAll('.transcription-card').forEach(card => {
        card.addEventListener('click', () => {
            const id = card.dataset.id;
            if (isTranscriptionReprocessing(id)) {
                showToast('Re-transcription in progress');
                return;
            }
            const transcription = transcriptions.find(t => t.id == id);
            if (transcription) showTranscriptionDetail(transcription);
        });
    });
    attachSummaryButtonHandlers(libraryList);
}

function setupLibraryFilters() {
    const filterPills = document.querySelectorAll('.filter-pill');
    filterPills.forEach(pill => {
        pill.addEventListener('click', () => {
            filterPills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            currentLibraryFilter = pill.dataset.filter;
            renderLibrary();
        });
    });
}

function renderJobItem(job, compact = false, delay = 0) {
    const isComplete = job.status === 'completed' || job.status === 'complete';
    const isFailed = job.status === 'failed';
    const isDiarizing = isComplete && (job.diarization_status === 'pending' || job.diarization_status === 'processing');
    const isRetranscribing = !!job.isRetranscribe && !isComplete && !isFailed;
    const isProcessing = !isComplete && !isFailed && !isRetranscribing;

    let iconClass = '';
    let icon = '';
    let badge = '';
    let statusText = '';

    if (isComplete && !isDiarizing) {
        iconClass = 'complete';
        icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
        badge = '<span class="job-badge">Complete</span>';
        statusText = 'Done';
    } else if (isDiarizing) {
        icon = `<svg class="spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`;
        badge = '<span class="job-badge">Diarizing</span>';
        statusText = 'Speakers...';
    } else if (isFailed) {
        iconClass = 'failed';
        icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
        badge = job.audio_path
            ? '<span class="job-badge failed">Retry</span>'
            : '<span class="job-badge failed">Failed</span>';
        statusText = job.audio_path ? 'Click to retry' : 'Failed';
    } else if (isRetranscribing) {
        iconClass = 'retranscribing';
        icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`;
        badge = '<span class="job-badge">Re-transcribing</span>';
        statusText = 'Re-transcribing';
    } else {
        icon = `<svg class="spinner" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>`;
        statusText = `${job.progress || 0}%`;
    }

    const jobName = escapeHtml(job.name || job.title || 'Untitled');
    const delayStyle = delay > 0 ? `animation-delay: ${delay}s;` : '';
    const dimClass = isRetranscribing ? ' is-processing' : '';

    return `
        <div class="job-item animate-float-up ${compact ? 'compact' : ''}${dimClass}" data-id="${job.id}" style="${delayStyle}">
            <div class="job-icon ${iconClass}">${icon}</div>
            <div class="job-content">
                <div class="job-header">
                    <span class="job-name">${jobName}</span>
                    ${badge}
                </div>
                ${isProcessing ? `
                    <div class="job-progress">
                        <div class="job-progress-fill" style="width: ${job.progress || 0}%"></div>
                    </div>
                ` : ''}
            </div>
            ${!compact ? `<span class="job-status">${statusText}</span>` : ''}
        </div>
    `;
}

function renderJobsList() {
    if (!jobsList) return;
    jobsList.innerHTML = jobs.map((job, i) => renderJobItem(job, false, i * 0.05)).join('');

    // Add retry click handlers for failed jobs with audio
    jobsList.querySelectorAll('.job-item').forEach(item => {
        const id = item.dataset.id;
        const job = jobs.find(j => j.id === id);
        if (job && job.status === 'failed' && job.audio_path) {
            item.style.cursor = 'pointer';
            item.addEventListener('click', () => retranscribeJob(id));
        }
    });
}

function updateProcessingSection() {
    const activeJobs = jobs.filter(
        j => j.status === 'processing'
            || j.status === 'pending'
            || (j.status === 'completed' && (j.diarization_status === 'pending' || j.diarization_status === 'processing'))
    );
    if (processingSection) {
        processingSection.style.display = activeJobs.length > 0 ? 'block' : 'none';
    }
    if (activeJobsList) {
        activeJobsList.innerHTML = activeJobs.slice(0, 2).map(job => renderJobItem(job, true)).join('');
    }
}

function renderDetailView(transcription) {
    if (!detailView) return;

    cleanupDetailAudio();
    const isMeetingTranscription = !!transcription.isMeeting || !!transcription.meetingNotes;

    const speakersHtml = transcription.speakers.map((speaker, i) => {
        const segmentCount = transcription.segments.filter(s => s.speaker === speaker.id).length;
        const speakerName = escapeHtml(speaker.name);
        const speakerInitial = escapeHtml(speaker.name.charAt(0));
        const speakerKey = escapeHtml(speaker.speakerKey || normalizeSpeakerKey(speaker.rawName || speaker.name));
        const rawSpeaker = escapeHtml(speaker.rawName || speaker.name);
        return `
            <div class="speaker-item" data-speaker-id="${speaker.id}" data-speaker-key="${speakerKey}" data-speaker-raw="${rawSpeaker}">
                <div class="speaker-info">
                    <div class="speaker-avatar-large" style="background: ${speaker.color}10; color: ${speaker.color}">
                        ${speakerInitial}
                    </div>
                    <div class="speaker-details">
                        <p class="speaker-name">${speakerName}</p>
                        <p class="speaker-segments">${segmentCount} segments</p>
                    </div>
                </div>
                <button class="speaker-edit-btn" data-speaker-action="edit">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"></path>
                        <path d="m15 5 4 4"></path>
                    </svg>
                    <span>Edit</span>
                </button>
            </div>
        `;
    }).join('');

    const segmentsHtml = transcription.segments.map((segment, i) => {
        const speaker = transcription.speakers.find(s => s.id === segment.speaker) || { name: 'Speaker', color: '#4A4A4A' };
        const speakerName = escapeHtml(speaker.name);
        const speakerInitial = escapeHtml(speaker.name.charAt(0));
        const segmentText = escapeHtml(segment.text);
        const segmentTime = escapeHtml(segment.time);
        return `
            <div class="transcript-segment">
                <div class="segment-avatar">
                    <div class="segment-avatar-circle" style="background: ${speaker.color}10; color: ${speaker.color}">
                        ${speakerInitial}
                    </div>
                </div>
                <div class="segment-content">
                    <div class="segment-header">
                        <span class="segment-speaker" style="color: ${speaker.color}">${speakerName}</span>
                        <span class="segment-time">${segmentTime}</span>
                    </div>
                    <p class="segment-text">${segmentText}</p>
                </div>
            </div>
        `;
    }).join('');

    const title = escapeHtml(transcription.title);
    const briefing = escapeHtml(transcription.briefing);
    const meetingNotes = transcription.meetingNotes;
    const diarizationStatus = transcription.diarizationStatus;
    const listHtml = (items) => {
        if (!items || items.length === 0) {
            return '<p class="briefing-text">No items available.</p>';
        }
        return `
            <div class="key-points">
                ${items.map((item) => `
                    <div class="key-point">
                        <div class="key-point-bullet"></div>
                        <p class="key-point-text">${escapeHtml(item)}</p>
                    </div>
                `).join('')}
            </div>
        `;
    };
    const diarizationBadge = diarizationStatus === 'pending' || diarizationStatus === 'processing'
        ? '<span class="job-badge">Diarizing speakers...</span>'
        : '';

    const meetingNotesHtml = meetingNotes ? `
        <div class="briefing-section">
            <h3 class="section-title">EXECUTIVE SUMMARY</h3>
            <p class="briefing-text">${meetingNotes.summary ? escapeHtml(meetingNotes.summary) : briefing}</p>
        </div>
        <div class="briefing-divider"></div>
        <div class="briefing-section">
            <h3 class="section-title">DISCUSSION POINTS</h3>
            ${listHtml(meetingNotes.discussion_points || [])}
        </div>
        <div class="briefing-divider"></div>
        <div class="briefing-section">
            <h3 class="section-title">ACTION ITEMS</h3>
            ${listHtml(meetingNotes.action_items || [])}
        </div>
        <div class="briefing-divider"></div>
        <div class="briefing-section">
            <h3 class="section-title">DECISIONS</h3>
            ${listHtml(meetingNotes.decisions || [])}
        </div>
        <div class="briefing-divider"></div>
        <div class="briefing-section">
            <h3 class="section-title">NEXT STEPS</h3>
            ${listHtml(meetingNotes.next_steps || [])}
        </div>
    ` : `
        <div class="briefing-section">
            <h3 class="section-title">MEETING SUMMARY</h3>
            <p class="briefing-text">${briefing}</p>
        </div>
        <div class="briefing-divider"></div>
        <div class="briefing-section">
            <h3 class="section-title">KEY POINTS</h3>
            <div class="key-points">
                <div class="key-point">
                    <div class="key-point-bullet"></div>
                    <p class="key-point-text">Meeting notes will appear here after generation.</p>
                </div>
            </div>
        </div>
    `;

    const audioHtml = transcription.hasAudio ? `
            <div class="detail-audio" id="detailAudioContainer">
                <audio id="detailAudioPlayer" controls preload="metadata"></audio>
            </div>
    ` : '';
    const retranscribeButtonHtml = transcription.hasAudio ? `
                    <button class="detail-action-btn retranscribe-btn" id="detailRetranscribeBtn" title="Re-transcribe audio">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <polyline points="1 4 1 10 7 10"></polyline>
                            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                        </svg>
                        <span>Re-transcribe</span>
                    </button>
    ` : '';

    detailView.innerHTML = `
        <div class="animate-float-up">
            <button class="detail-back-btn" id="detailBackBtn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
                <span>Back</span>
            </button>

            <div class="detail-header">
                <div class="detail-info">
                    <h1 class="detail-title">${title}</h1>
                    <div class="detail-meta">
                        <span>${escapeHtml(transcription.date)}</span>
                        <span>•</span>
                        <span>${escapeHtml(transcription.duration)}</span>
                        ${diarizationBadge}
                    </div>
                </div>
                <div class="detail-actions">
                    ${retranscribeButtonHtml}
                    <button class="detail-action-btn" id="detailCopyBtn" title="Copy markdown">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                        <span>Copy</span>
                    </button>
                    <div class="export-btn-wrapper">
                        <button class="detail-action-btn" id="detailExportBtn" title="Export">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                <polyline points="17 8 12 3 7 8"></polyline>
                                <line x1="12" x2="12" y1="3" y2="15"></line>
                            </svg>
                            <span>Export</span>
                        </button>
                        <div class="export-popup" id="detailExportPopup">
                            <button class="export-popup-item" id="detailExportDownloadBtn">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                    <polyline points="7 10 12 15 17 10"></polyline>
                                    <line x1="12" x2="12" y1="15" y2="3"></line>
                                </svg>
                                <span>Download</span>
                            </button>
                            <button class="export-popup-item" id="detailExportNotionBtn">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                                    <path d="M8 16V8l7 8V8"></path>
                                </svg>
                                <span>Notion</span>
                            </button>
                        </div>
                    </div>
                    <button class="detail-action-btn danger" id="detailDeleteBtn" title="Delete">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <path d="M3 6h18"></path>
                            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            </div>

            ${audioHtml}

            <div class="detail-tabs">
                <button class="detail-tab active" data-tab="transcript">transcript</button>
                <button class="detail-tab" data-tab="briefing">briefing</button>
                <button class="detail-tab" data-tab="speakers">speakers</button>
            </div>

            <div id="transcriptTab" class="detail-tab-content">
                ${transcription.readability && transcription.readability.text ? `
                <div class="polished-content-section">
                    <div class="polished-header">
                        <h3 class="section-title">POLISHED</h3>
                    </div>
                    <div class="polished-text" id="polishedText">${escapeHtml(transcription.readability.text)}</div>
                </div>
                <div class="transcript-divider"></div>
                <h3 class="section-title" style="margin-top: 24px;">RAW TRANSCRIPT</h3>
                ` : ''}
                <div class="transcript-segments">
                    ${segmentsHtml}
                </div>
            </div>

            <div id="briefingTab" class="detail-tab-content" style="display: none;">
                <div class="briefing-card">
                    ${meetingNotesHtml}
                </div>
            </div>

            <div id="speakersTab" class="detail-tab-content" style="display: none;">
                <div class="speakers-list">
                    ${speakersHtml}
                </div>
            </div>
        </div>
    `;

    // Add event listeners for detail view
    setupDetailViewListeners();
    if (transcription.hasAudio) {
        loadDetailAudio(transcription.id);
    }
}

function setupDetailViewListeners() {
    const backBtn = document.getElementById('detailBackBtn');
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            if (detailReturnView === 'summary' && selectedTranscription) {
                showMeetingSummary(selectedTranscription);
            } else {
                switchView(activeView === 'library' ? 'library' : 'home');
            }
        });
    }

    const retranscribeBtn = document.getElementById('detailRetranscribeBtn');
    if (retranscribeBtn && selectedTranscription) {
        retranscribeBtn.addEventListener('click', () => {
            retranscribeJob(selectedTranscription.id);
        });
    }

    const copyBtn = document.getElementById('detailCopyBtn');
    if (copyBtn && selectedTranscription) {
        copyBtn.addEventListener('click', () => {
            copyMeetingMarkdown(selectedTranscription.id);
        });
    }

    const exportBtn = document.getElementById('detailExportBtn');
    const exportPopup = document.getElementById('detailExportPopup');
    if (exportBtn && exportPopup) {
        exportBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            exportPopup.classList.toggle('open');
        });
        document.addEventListener('click', () => exportPopup.classList.remove('open'), { once: false });
    }

    const exportDownloadBtn = document.getElementById('detailExportDownloadBtn');
    if (exportDownloadBtn && selectedTranscription) {
        exportDownloadBtn.addEventListener('click', () => {
            exportPopup && exportPopup.classList.remove('open');
            downloadTranscript(selectedTranscription.id);
        });
    }

    const exportNotionBtn = document.getElementById('detailExportNotionBtn');
    if (exportNotionBtn && selectedTranscription) {
        exportNotionBtn.addEventListener('click', () => {
            exportPopup && exportPopup.classList.remove('open');
            shareMeetingToNotion(selectedTranscription.id);
        });
    }

    const deleteBtn = document.getElementById('detailDeleteBtn');
    if (deleteBtn && selectedTranscription) {
        deleteBtn.addEventListener('click', () => {
            deleteTranscription(selectedTranscription.id);
        });
    }

    const detailTabs = detailView.querySelectorAll('.detail-tab');
    detailTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            detailTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            const tabName = tab.dataset.tab;
            document.getElementById('transcriptTab').style.display = tabName === 'transcript' ? 'block' : 'none';
            document.getElementById('briefingTab').style.display = tabName === 'briefing' ? 'block' : 'none';
            document.getElementById('speakersTab').style.display = tabName === 'speakers' ? 'block' : 'none';
        });
    });

    detailView.querySelectorAll('.speaker-edit-btn').forEach((button) => {
        button.addEventListener('click', () => {
            if (!selectedTranscription) return;
            const speakerItem = button.closest('.speaker-item');
            if (!speakerItem) return;

            const speakerNameEl = speakerItem.querySelector('.speaker-name');
            if (!speakerNameEl || speakerItem.querySelector('.speaker-name-input')) return;

            const currentLabel = speakerNameEl.textContent || 'Speaker';

            // Create inline input
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'speaker-name-input';
            input.value = currentLabel;
            input.placeholder = 'Enter name';

            // Hide name, show input
            speakerNameEl.style.display = 'none';
            speakerNameEl.parentNode.insertBefore(input, speakerNameEl.nextSibling);
            input.focus();
            input.select();

            // Hide edit button, show save/cancel
            button.style.display = 'none';

            const saveSpeakerLabel = async () => {
                const trimmed = input.value.trim();
                if (!trimmed || trimmed === currentLabel) {
                    // Cancel - restore original state
                    input.remove();
                    speakerNameEl.style.display = '';
                    button.style.display = '';
                    return;
                }

                const speakerId = speakerItem.dataset.speakerId;
                const speakerKey = normalizeSpeakerKey(speakerItem.dataset.speakerKey || speakerItem.dataset.speakerRaw || '');
                if (!speakerId || !speakerKey) return;

                const speaker = selectedTranscription.speakers.find((entry) => entry.id === speakerId);
                if (!speaker) return;

                speaker.name = trimmed;
                settings.speakerLabels = settings.speakerLabels || {};
                settings.speakerLabels[speakerKey] = trimmed;

                try {
                    if (window.electronAPI?.rememberSpeakerLabel) {
                        await api.rememberSpeakerLabel(speakerKey, trimmed);
                    } else {
                        await api.setSettings({ speakerLabels: settings.speakerLabels });
                    }
                } catch (e) {
                    console.warn('Failed to persist speaker label:', e);
                    showToast('Unable to save speaker label');
                }

                const transIdx = transcriptions.findIndex(t => t.id === selectedTranscription.id);
                if (transIdx >= 0) {
                    transcriptions[transIdx] = selectedTranscription;
                }
                renderRecentTranscriptions();
                renderLibrary();
                renderDetailView(selectedTranscription);
                const speakersTab = document.querySelector('.detail-tab[data-tab="speakers"]');
                if (speakersTab) {
                    speakersTab.dispatchEvent(new Event('click'));
                }
                showToast('Speaker label saved');
            };

            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    saveSpeakerLabel();
                } else if (e.key === 'Escape') {
                    input.remove();
                    speakerNameEl.style.display = '';
                    button.style.display = '';
                }
            });

            input.addEventListener('blur', () => {
                // Small delay to allow Enter key handler to fire first
                setTimeout(() => {
                    if (document.body.contains(input)) {
                        saveSpeakerLabel();
                    }
                }, 100);
            });
        });
    });
}

// ============================================
// Jobs Loading
// ============================================
async function loadJobs() {
    if (!jobsList) return;
    try {
        const data = await api.listJobs();
        const prevJobs = jobs;
        jobs = data.map(job => {
            const prev = prevJobs.find(j => j.id === job.id);
            const isRetranscription = !!job.is_retranscription || prev?.isRetranscribe;
            return {
                id: job.id,
                name: job.title || 'Untitled',
                status: job.status,
                diarization_status: job.diarization_status || null,
                progress: job.status === 'completed' ? 100 : 50,
                created_at: job.created_at,
                audio_path: job.audio_path || null,
                is_meeting: job.is_meeting || undefined,
                isRetranscribe: isRetranscription && job.status !== 'completed' && job.status !== 'failed'
                    ? true : undefined
            };
        });
        renderJobsList();
        updateProcessingSection();

        // Also load transcriptions from completed jobs
        for (const job of data.filter(j => j.status === 'completed')) {
            try {
                const detail = await api.getJob(job.id);
                if (detail.result) {
                    const mapped = resultToTranscription(
                        detail.result,
                        job.id,
                        job.created_at,
                        job.duration,
                        job.audio_path || detail.audio_path,
                        job.diarization_status || detail.diarization_status
                    );
                    const idx = transcriptions.findIndex(t => t.id === job.id);
                    if (idx >= 0) {
                        transcriptions[idx] = mapped;
                    } else {
                        transcriptions.push(mapped);
                    }
                }
                if (detail.diarization_status === 'pending' || detail.diarization_status === 'processing') {
                    pollDiarizationUntilDone(job.id);
                }
            } catch (e) {
                console.warn('Failed to load job detail:', e);
            }
        }

        // Ensure retranscribing jobs remain visible in the library
        for (const job of data.filter(j => (j.status === 'pending' || j.status === 'processing') && !!j.is_retranscription)) {
            const exists = transcriptions.some(t => t.id === job.id);
            if (!exists) {
                transcriptions.push({
                    id: job.id,
                    title: job.title || 'Re-transcribing...',
                    date: job.created_at ? new Date(job.created_at).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
                    duration: job.duration || '0:00',
                    status: 'complete',
                    speakers: [],
                    segments: [],
                    briefing: '',
                    hasAudio: true,
                    isMeeting: job.is_meeting || false,
                    meetingNotes: null,
                    diarizationStatus: null
                });
            }
        }

        renderRecentTranscriptions();
        renderLibrary();
    } catch (e) {
        console.warn('Failed to load jobs:', e);
    }
}

// ============================================
// Assistant Panel
// ============================================
function openAssistant() {
    if (assistantOverlay) assistantOverlay.classList.add('open');
}

function closeAssistant() {
    if (assistantOverlay) assistantOverlay.classList.remove('open');
}

function sendAssistantMessage() {
    const text = assistantInput?.value?.trim();
    if (!text) return;

    // Add user message (with XSS protection)
    const userMsg = document.createElement('div');
    userMsg.className = 'chat-message user animate-float-up';
    userMsg.innerHTML = `<div class="message-bubble"><p>${escapeHtml(text)}</p></div>`;
    assistantMessages?.appendChild(userMsg);

    assistantInput.value = '';
    updateAssistantSendButton();

    // Scroll to bottom
    if (assistantMessages) {
        assistantMessages.scrollTop = assistantMessages.scrollHeight;
    }

    // Show coming soon message
    setTimeout(() => {
        const assistantMsg = document.createElement('div');
        assistantMsg.className = 'chat-message assistant animate-float-up';
        assistantMsg.innerHTML = `<div class="message-bubble"><p>The AI assistant feature is coming soon. This will allow you to ask questions about your transcriptions, find specific moments, and get summaries.</p></div>`;
        assistantMessages?.appendChild(assistantMsg);
        if (assistantMessages) {
            assistantMessages.scrollTop = assistantMessages.scrollHeight;
        }
    }, 500);
}

function updateAssistantSendButton() {
    const hasText = assistantInput?.value?.trim();
    if (assistantSend) {
        assistantSend.classList.toggle('active', !!hasText);
    }
}

// ============================================
// Settings
// ============================================
function setupSettingsListeners() {
    // Toggle switches
    settingToggles.forEach(toggle => {
        const settingKey = toggle.dataset.setting;
        const switchEl = toggle.querySelector('.toggle-switch');

        // Initialize state
        if (settings[settingKey] && switchEl) {
            switchEl.classList.add('active');
        }

        toggle.addEventListener('click', () => {
            settings[settingKey] = !settings[settingKey];
            if (switchEl) {
                switchEl.classList.toggle('active', settings[settingKey]);
            }
            if (settingKey === 'autoPolish') {
                savePolishSettings();
            } else if (settingKey === 'meetingCaptureEnabled') {
                const mode = settings.meetingCaptureEnabled
                    ? 'meeting'
                    : ((settings.defaultMode === 'openai' || currentProvider === 'openai') ? 'openai' : 'gemini');
                applyModeSelection(mode, { persist: true, syncMainProcess: true });
            }
        });
    });

    // Summary options
    summaryOptions.forEach(option => {
        option.addEventListener('click', () => {
            summaryOptions.forEach(o => o.classList.remove('active'));
            option.classList.add('active');
            settings.summaryLength = option.dataset.length;
        });
    });

    // Language select
    if (languageSelect) {
        languageSelect.value = settings.language;
        languageSelect.addEventListener('change', () => {
            settings.language = languageSelect.value;
        });
    }

    // Save button
    if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', saveSettings);
    }

    if (polishStyleSelect) {
        polishStyleSelect.addEventListener('change', () => {
            settings.polishStyle = polishStyleSelect.value;
            savePolishSettings();
        });
    }

    if (customPolishPrompt) {
        let debounceTimer;
        customPolishPrompt.addEventListener('input', () => {
            settings.customPolishPrompt = customPolishPrompt.value;
            // Debounce save to avoid too many API calls
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                savePolishSettings();
            }, 1000);
        });
    }

    // Gemini model select
    if (geminiModelSelect) {
        geminiModelSelect.addEventListener('change', () => {
            settings.geminiModel = geminiModelSelect.value;
            api.setSettings({ geminiModel: settings.geminiModel });
        });
    }

    if (meetingNotesModelSelect) {
        meetingNotesModelSelect.addEventListener('change', () => {
            settings.meetingNotesModel = meetingNotesModelSelect.value;
            api.setSettings({ meetingNotesModel: settings.meetingNotesModel });
        });
    }

    // Custom transcription prompt
    if (customTranscriptionPrompt) {
        let debounceTimer;
        customTranscriptionPrompt.addEventListener('input', () => {
            settings.customTranscriptionPrompt = customTranscriptionPrompt.value;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                api.setSettings({ customTranscriptionPrompt: settings.customTranscriptionPrompt });
            }, 1000);
        });
    }

    // Fn key tip card dismiss
    const fnKeyTip = document.getElementById('fnKeyTip');
    const fnKeyTipDismiss = document.getElementById('fnKeyTipDismiss');
    if (fnKeyTip) {
        if (localStorage.getItem('fnKeyTipDismissed') === 'true') {
            fnKeyTip.style.display = 'none';
        }
        if (fnKeyTipDismiss) {
            fnKeyTipDismiss.addEventListener('click', () => {
                fnKeyTip.style.display = 'none';
                localStorage.setItem('fnKeyTipDismissed', 'true');
            });
        }
    }

    // Hotkey recording
    setupHotkeyRecording();
}

function setupHotkeyRecording() {
    if (!hotkeyRecordBtn || !hotkeyInput) return;

    hotkeyRecordBtn.addEventListener('click', () => {
        if (isRecordingHotkey) {
            stopHotkeyRecording();
        } else {
            startHotkeyRecording();
        }
    });

    if (hotkeyResetBtn) {
        hotkeyResetBtn.addEventListener('click', () => {
            resetHotkeyToDefault();
        });
    }
}

function startHotkeyRecording() {
    isRecordingHotkey = true;
    hotkeyInput.value = 'Press a key...';
    hotkeyInput.classList.add('recording');
    hotkeyRecordBtn.classList.add('active');

    const keyHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Ignore modifier-only presses
        if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) {
            return;
        }

        const newHotkey = {
            code: e.code,
            key: e.key,
            ctrlKey: e.ctrlKey,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
        };

        settings.hotkey = newHotkey;
        updateHotkeyDisplay();
        stopHotkeyRecording();
        document.removeEventListener('keydown', keyHandler, true);

        // Save hotkey to backend
        saveHotkeySetting(newHotkey);
    };

    document.addEventListener('keydown', keyHandler, true);

    // Store handler for cleanup
    hotkeyInput._keyHandler = keyHandler;
}

function stopHotkeyRecording() {
    isRecordingHotkey = false;
    hotkeyInput.classList.remove('recording');
    hotkeyRecordBtn.classList.remove('active');
    updateHotkeyDisplay();

    if (hotkeyInput._keyHandler) {
        document.removeEventListener('keydown', hotkeyInput._keyHandler, true);
        delete hotkeyInput._keyHandler;
    }
}

function updateHotkeyDisplay() {
    if (!hotkeyInput || !settings.hotkey) return;

    // Special case: Fn key
    if (settings.hotkey.key === 'Fn' || settings.hotkey.code === 'Fn') {
        hotkeyInput.value = 'Fn';
        return;
    }

    const parts = [];
    if (settings.hotkey.ctrlKey) parts.push('Ctrl');
    if (settings.hotkey.altKey) parts.push('Alt');
    if (settings.hotkey.shiftKey) parts.push('Shift');
    if (settings.hotkey.metaKey) parts.push('Cmd');

    // Get a readable key name
    let keyName = settings.hotkey.key || settings.hotkey.code || 'Space';
    if (keyName === ' ') keyName = 'Space';
    if (keyName.length === 1) keyName = keyName.toUpperCase();

    parts.push(keyName);
    hotkeyInput.value = parts.join(' + ');
}

async function saveHotkeySetting(hotkey) {
    try {
        await api.setSettings({ hotkey });
        // Notify Electron of hotkey change
        if (window.electronAPI && window.electronAPI.updateHotkey) {
            const accelerator = hotkeyToAccelerator(hotkey);
            await window.electronAPI.updateHotkey(accelerator);
        }
    } catch (error) {
        console.error('Failed to save hotkey:', error);
    }
}

async function resetHotkeyToDefault() {
    try {
        // Fn is the default hotkey — it can't be captured via keydown,
        // so we set it directly as a special accelerator string.
        const fnHotkey = { code: 'Fn', key: 'Fn', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false };
        settings.hotkey = fnHotkey;
        hotkeyInput.value = 'Fn';

        await api.setSettings({ hotkey: fnHotkey });
        if (window.electronAPI && window.electronAPI.updateHotkey) {
            await window.electronAPI.updateHotkey('Fn');
        }
        console.log('Hotkey reset to Fn');
    } catch (error) {
        console.error('Failed to reset hotkey:', error);
    }
}

// Map KeyboardEvent.code to Electron accelerator key names
const CODE_TO_ACCELERATOR = {
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    Escape: 'Escape',
    Enter: 'Return',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Tab: 'Tab',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    NumpadEnter: 'Return',
    NumpadAdd: 'numadd',
    NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv',
    NumpadDecimal: 'numdec',
};

function hotkeyToAccelerator(hotkey) {
    const parts = [];
    if (hotkey.ctrlKey) parts.push('Control');
    if (hotkey.altKey) parts.push('Alt');
    if (hotkey.shiftKey) parts.push('Shift');
    if (hotkey.metaKey) parts.push('Command');

    let key = hotkey.code || 'Space';

    // Check for special key mappings first
    if (CODE_TO_ACCELERATOR[key]) {
        key = CODE_TO_ACCELERATOR[key];
    } else if (key.startsWith('Key')) {
        key = key.slice(3);
    } else if (key.startsWith('Digit')) {
        key = key.slice(5);
    } else if (key.startsWith('Numpad') && /^Numpad\d$/.test(key)) {
        key = 'num' + key.slice(6);
    } else if (key.startsWith('F') && /^F\d+$/.test(key)) {
        // F1-F24 are already correct
    }
    // Space is already 'Space' which is correct

    parts.push(key);
    return parts.join('+');
}

async function savePolishSettings() {
    try {
        await api.setSettings({
            autoPolish: settings.autoPolish,
            polishStyle: settings.polishStyle,
            customPolishPrompt: settings.customPolishPrompt
        });
    } catch (error) {
        console.error('Failed to save polish settings:', error);
    }
}

async function saveSettings() {
    const settingsData = {
        openaiApiKey: openaiKey?.value || '',
        geminiApiKey: geminiKey?.value || '',
        geminiModel: geminiModelSelect?.value || 'gemini-3-flash-preview',
        autoPolish: settings.autoPolish,
        polishStyle: settings.polishStyle,
        customPolishPrompt: settings.customPolishPrompt,
        defaultProvider: settings.defaultMode,
        geminiModel: settings.geminiModel,
        customTranscriptionPrompt: settings.customTranscriptionPrompt,
        meetingCaptureEnabled: settings.meetingCaptureEnabled,
        meetingNotesModel: settings.meetingNotesModel,
        hotkey: settings.hotkey,
        ...settings
    };

    try {
        await api.setSettings(settingsData);
        showToast('Settings saved');

        // Update hotkey in Electron if available
        if (window.electronAPI && window.electronAPI.updateHotkey && settings.hotkey) {
            const accelerator = hotkeyToAccelerator(settings.hotkey);
            await window.electronAPI.updateHotkey(accelerator);
        }
        await syncMeetingModeToMainProcess();
        updateRecordingUI(isRecording);
    } catch (error) {
        console.error('Settings save error:', error);
        showToast('Error saving settings');
    }
}

// Map Electron accelerator key names back to KeyboardEvent.code
const ACCELERATOR_TO_CODE = {
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
    Return: 'Enter',
    Escape: 'Escape',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Tab: 'Tab',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    Space: 'Space',
};

function acceleratorToHotkey(accelerator) {
    if (!accelerator) return null;

    const parts = accelerator.split('+');
    const hotkey = {
        code: '',
        key: '',
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
    };

    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

    for (const part of parts) {
        const lower = part.toLowerCase();
        if (part === 'Control' || lower === 'ctrl') {
            hotkey.ctrlKey = true;
        } else if (part === 'Alt' || part === 'Option') {
            hotkey.altKey = true;
        } else if (part === 'Shift') {
            hotkey.shiftKey = true;
        } else if (part === 'Command' || part === 'Cmd' || part === 'Meta') {
            hotkey.metaKey = true;
        } else if (part === 'CommandOrControl' || part === 'CmdOrCtrl') {
            // Cross-platform modifier: Cmd on Mac, Ctrl elsewhere
            if (isMac) {
                hotkey.metaKey = true;
            } else {
                hotkey.ctrlKey = true;
            }
        } else {
            // This is the key
            if (ACCELERATOR_TO_CODE[part]) {
                hotkey.code = ACCELERATOR_TO_CODE[part];
            } else if (part.length === 1 && /[A-Z]/.test(part)) {
                hotkey.code = 'Key' + part;
                hotkey.key = part.toLowerCase();
            } else if (part.length === 1 && /[0-9]/.test(part)) {
                hotkey.code = 'Digit' + part;
                hotkey.key = part;
            } else if (/^F\d+$/.test(part)) {
                hotkey.code = part;
                hotkey.key = part;
            } else if (/^num\d$/.test(part)) {
                hotkey.code = 'Numpad' + part.slice(3);
                hotkey.key = part.slice(3);
            } else {
                // Fallback: use as-is
                hotkey.code = part;
                hotkey.key = part;
            }
        }
    }

    // Set key from code if not already set
    if (!hotkey.key && hotkey.code) {
        if (hotkey.code === 'Space') hotkey.key = ' ';
        else if (hotkey.code.startsWith('Key')) hotkey.key = hotkey.code.slice(3).toLowerCase();
        else if (hotkey.code.startsWith('Digit')) hotkey.key = hotkey.code.slice(5);
        else if (hotkey.code.startsWith('Arrow')) hotkey.key = hotkey.code;
        else hotkey.key = hotkey.code;
    }

    return hotkey;
}

async function loadSettings() {
    try {
        const data = await api.getSettings();
        if (openaiKey) openaiKey.value = data.openaiApiKey || '';
        if (geminiKey) geminiKey.value = data.geminiApiKey || '';
        if (geminiModelSelect) geminiModelSelect.value = data.geminiModel || 'gemini-3-flash-preview';

        // Track API key status for UI hints
        hasGeminiApiKey = !!(data.geminiApiKey && data.geminiApiKey.trim());

        // Load UI settings
        settings.autoDetectSpeakers = data.autoDetectSpeakers !== undefined
            ? data.autoDetectSpeakers
            : true;
        settings.language = data.language || 'auto';
        settings.punctuation = data.punctuation !== undefined ? data.punctuation : true;
        settings.timestamps = data.timestamps !== undefined ? data.timestamps : true;
        settings.summaryLength = data.summaryLength || 'medium';

        // Load polish settings
        settings.autoPolish = data.autoPolish || false;
        settings.polishStyle = data.polishStyle || 'natural';
        settings.customPolishPrompt = data.customPolishPrompt || '';
        settings.defaultMode = data.defaultMode || data.defaultProvider || 'gemini';

        // Load consensus settings
        settings.consensusEnabled = data.consensusEnabled || false;
        settings.consensusMemoryEnabled = data.consensusMemoryEnabled !== false;
        settings.meetingCaptureEnabled = data.meetingCaptureEnabled || false;
        settings.meetingNotesModel = data.meetingNotesModel || 'gpt-5.2-2025-12-11';
        settings.speakerLabels = data.speakerLabels || {};

        // Sync main-page meeting toggle
        const mainMeetingToggle = document.getElementById('meetingToggleSwitch');
        if (mainMeetingToggle) {
            mainMeetingToggle.classList.toggle('active', !!settings.meetingCaptureEnabled);
        }

        // Apply toggle settings to UI
        settingToggles.forEach(toggle => {
            const settingKey = toggle.dataset.setting;
            const switchEl = toggle.querySelector('.toggle-switch');
            if (switchEl) {
                switchEl.classList.toggle('active', !!settings[settingKey]);
            }
        });

        // Apply summary settings to UI
        summaryOptions.forEach(option => {
            option.classList.toggle('active', option.dataset.length === settings.summaryLength);
        });

        // Apply language selection to UI
        if (languageSelect) {
            languageSelect.value = settings.language;
        }

        // Apply polish settings to UI
        if (polishStyleSelect) {
            polishStyleSelect.value = settings.polishStyle;
        }
        if (customPolishPrompt) {
            customPolishPrompt.value = settings.customPolishPrompt;
        }

        // Apply mode selection without persisting again
        const initialMode = settings.defaultMode || (settings.meetingCaptureEnabled ? 'meeting' : 'gemini');
        applyModeSelection(initialMode, { persist: false, syncMainProcess: false });

        // Apply Gemini model setting
        settings.geminiModel = data.geminiModel || 'gemini-3-flash-preview';
        if (geminiModelSelect) {
            geminiModelSelect.value = settings.geminiModel;
        }
        if (meetingNotesModelSelect) {
            meetingNotesModelSelect.value = settings.meetingNotesModel;
        }

        // Apply custom transcription prompt
        settings.customTranscriptionPrompt = data.customTranscriptionPrompt || '';
        if (customTranscriptionPrompt) {
            customTranscriptionPrompt.value = settings.customTranscriptionPrompt;
        }

        // Load hotkey from Electron (source of truth) or fall back to settings.json
        if (window.electronAPI && window.electronAPI.getHotkey) {
            try {
                const hotkeyConfig = await window.electronAPI.getHotkey();
                if (hotkeyConfig && hotkeyConfig.accelerator) {
                    const parsed = acceleratorToHotkey(hotkeyConfig.accelerator);
                    if (parsed && parsed.code) {
                        settings.hotkey = parsed;
                    }
                }
            } catch (e) {
                console.warn('Failed to load hotkey from Electron:', e);
                // Fall back to settings.json hotkey
                if (data.hotkey) {
                    settings.hotkey = data.hotkey;
                }
            }
        } else if (data.hotkey) {
            settings.hotkey = data.hotkey;
        }
        updateHotkeyDisplay();
        updateRecordingUI(isRecording);
        syncMeetingModeToMainProcess();
    } catch (error) {
        console.error('Settings load error:', error);
    }
}

// ============================================
// Dropzone
// ============================================
function setupDropzone() {
    // Library view dropzone
    const libraryDropzone = document.getElementById('libraryDropzone');
    const libraryDropzoneFile = document.getElementById('libraryDropzoneFile');

    if (libraryDropzone) {
        libraryDropzone.addEventListener('click', (e) => {
            if (e.target.tagName === 'INPUT') return;
            libraryDropzoneFile?.click();
        });

        libraryDropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            libraryDropzone.classList.add('dragover');
        });

        libraryDropzone.addEventListener('dragleave', () => {
            libraryDropzone.classList.remove('dragover');
        });

        libraryDropzone.addEventListener('drop', async (e) => {
            e.preventDefault();
            libraryDropzone.classList.remove('dragover');
            const file = e.dataTransfer.files[0];
            if (file) handleAudioFile(file);
        });
    }

    if (libraryDropzoneFile) {
        libraryDropzoneFile.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) handleAudioFile(file);
        });
    }

    // Home view upload button (if still present)
    if (audioFile) {
        audioFile.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) handleAudioFile(file);
        });
    }
}

// ============================================
// Initialize
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    // Navigation
    navTabs.forEach(tab => {
        tab.addEventListener('click', () => switchView(tab.dataset.view));
    });

    if (viewAllBtn) {
        viewAllBtn.addEventListener('click', () => switchView('library'));
    }

    // Recording
    if (recordButton) {
        recordButton.addEventListener('click', () => {
            if (isRecording) {
                stopRecording();
            } else {
                startRecording();
            }
        });
    }

    // Assistant
    if (assistantToggle) {
        assistantToggle.addEventListener('click', openAssistant);
    }
    if (assistantClose) {
        assistantClose.addEventListener('click', closeAssistant);
    }
    if (assistantOverlay) {
        assistantOverlay.addEventListener('click', (e) => {
            if (e.target === assistantOverlay) closeAssistant();
        });
    }
    if (assistantInput) {
        assistantInput.addEventListener('input', updateAssistantSendButton);
        assistantInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') sendAssistantMessage();
        });
    }
    if (assistantSend) {
        assistantSend.addEventListener('click', sendAssistantMessage);
    }
    quickActions.forEach(action => {
        action.addEventListener('click', () => {
            if (assistantInput) {
                assistantInput.value = action.textContent;
                updateAssistantSendButton();
            }
        });
    });

    // Settings
    setupSettingsListeners();
    setupMeetingDetectionPromptListeners();
    setupLiveTranscriptPanelListeners();
    loadSettings();

    // Dropzone
    setupDropzone();

    // Load data
    loadJobs();

    // Featured transcription block
    loadFeaturedTranscription();
    setupFeaturedCopyBtn();

    // Mode selector
    setupModeSelector();

    // Library filter pills
    setupLibraryFilters();

    // Initial render
    renderRecentTranscriptions();
    updateProcessingSection();

    // Support widget: web version uses external BMC script, Electron uses native button
    loadBuyMeCoffeeWidget();
    createNativeSupportButton();
});

// ============================================
// Electron IPC (if available)
// ============================================
(function initElectronBridge() {
    if (typeof window.electronAPI === 'undefined') {
        return;
    }

    console.log('Electron API detected, setting up IPC bridge');

    // Pre-warm mic so first recording starts instantly
    initMicrophoneStream();

    window.electronAPI.onStartRecording(() => {
        console.log('Electron: Start recording command received');
        if (!isRecording) startRecording();
    });

    window.electronAPI.onStopRecording(() => {
        console.log('Electron: Stop recording command received');
        if (isRecording) stopRecording();
    });

    window.electronAPI.onResetRecordingState(() => {
        console.log('Electron: Reset recording state received');
        resetRecordingState();
    });

    if (window.electronAPI.onMeetingModeSuggestion) {
        window.electronAPI.onMeetingModeSuggestion((payload) => {
            if (isRecording || settings.meetingCaptureEnabled) {
                return;
            }
            showMeetingModeSuggestionPrompt(payload || {});
        });
    }

    if (window.electronAPI.onMeetingModeUpdated) {
        window.electronAPI.onMeetingModeUpdated((payload) => {
            if (payload && payload.enabled === true) {
                applyModeSelection('meeting', { persist: true, syncMainProcess: false });
            }
        });
    }

    console.log('Electron IPC bridge initialized');
})();
