import { describe, expect, it } from 'vitest';

// Mirror the production functions from main.js for testing.
// These must stay in sync with electron/assets/static/main.js.

function formatDuration(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function computeDurationFromSegments(
  segments: Array<{ end_time?: string }>,
): string {
  if (!segments || segments.length === 0) return '0:00';
  for (let i = segments.length - 1; i >= 0; i--) {
    const endTime = segments[i].end_time;
    if (!endTime) continue;
    const str = String(endTime).trim();
    if (!str) continue;
    if (str.endsWith('s')) {
      const totalSec = Math.round(parseFloat(str));
      if (isNaN(totalSec)) continue;
      return formatDuration(totalSec);
    }
    const parts = str.split(':');
    if (parts.length >= 2) {
      let totalSec = 0;
      if (parts.length === 3) {
        totalSec =
          parseInt(parts[0]) * 3600 +
          parseInt(parts[1]) * 60 +
          parseInt(parts[2]);
      } else {
        totalSec = parseInt(parts[0]) * 60 + parseInt(parts[1]);
      }
      if (isNaN(totalSec)) continue;
      return formatDuration(totalSec);
    }
    const plainSec = parseFloat(str);
    if (!isNaN(plainSec)) {
      return formatDuration(Math.round(plainSec));
    }
  }
  return '0:00';
}

function parseDurationToSeconds(val: unknown): number | null {
  if (val == null) return null;
  if (typeof val === 'number')
    return Number.isFinite(val) && val >= 0 ? val : null;
  if (typeof val !== 'string') return null;
  const str = (val as string).trim();
  if (!str) return null;
  // ISO-8601
  const iso = str.match(
    /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i,
  );
  if (iso && (iso[1] || iso[2] || iso[3])) {
    return (
      parseFloat(iso[1] || '0') * 3600 +
      parseFloat(iso[2] || '0') * 60 +
      parseFloat(iso[3] || '0')
    );
  }
  // Colon format
  const colonMatch3 = str.match(/^(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (colonMatch3) {
    const s =
      parseFloat(colonMatch3[1]) * 3600 +
      parseFloat(colonMatch3[2]) * 60 +
      parseFloat(colonMatch3[3]);
    return Number.isFinite(s) ? s : null;
  }
  const colonMatch = str.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
  if (colonMatch) {
    const s = parseFloat(colonMatch[1]) * 60 + parseFloat(colonMatch[2]);
    return Number.isFinite(s) ? s : null;
  }
  // Numeric string
  const num = parseFloat(str);
  if (Number.isFinite(num) && num >= 0 && /^\d+(\.\d+)?$/.test(str))
    return num;
  return null;
}

interface Segment {
  text?: string;
  end_time?: string;
}
interface Transcription {
  duration?: string;
  segments?: Segment[];
}

function countWords(segments?: Segment[]): number {
  let words = 0;
  if (segments) {
    for (const seg of segments) {
      if (seg.text)
        words += seg.text
          .trim()
          .split(/\s+/)
          .filter(Boolean).length;
    }
  }
  return words;
}

function resolveDuration(t: Transcription): {
  seconds: number | null;
  derived: boolean;
} {
  let dur = parseDurationToSeconds(t.duration);
  if (dur != null) return { seconds: dur, derived: false };
  if (t.segments && t.segments.length > 0) {
    const fallback = computeDurationFromSegments(t.segments);
    dur = parseDurationToSeconds(fallback);
    if (dur != null && dur > 0) return { seconds: dur, derived: true };
  }
  return { seconds: null, derived: false };
}

function computeUsageStats(transcriptions: Transcription[]) {
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
  const wpm =
    durationForWpm > 0
      ? Math.round(wordsWithDuration / (durationForWpm / 60))
      : 0;
  return {
    totalSeconds,
    totalWords,
    wpm,
    missingDurationWithWordsCount,
    zeroDurationWithWordsCount,
    derivedDurationCount,
  };
}

// ─── parseDurationToSeconds ─────────────────────────────────────────────

describe('parseDurationToSeconds', () => {
  it('parses mm:ss colon format', () => {
    expect(parseDurationToSeconds('3:45')).toBe(225);
  });

  it('parses hh:mm:ss colon format', () => {
    expect(parseDurationToSeconds('1:02:03')).toBe(3723);
  });

  it('parses numeric string (integer)', () => {
    expect(parseDurationToSeconds('225')).toBe(225);
  });

  it('parses numeric string (decimal)', () => {
    expect(parseDurationToSeconds('225.5')).toBe(225.5);
  });

  it('parses ISO-8601 PT3M45S', () => {
    expect(parseDurationToSeconds('PT3M45S')).toBe(225);
  });

  it('parses ISO-8601 PT1H2M3.5S', () => {
    expect(parseDurationToSeconds('PT1H2M3.5S')).toBe(3723.5);
  });

  it('parses explicit zero 0:00', () => {
    expect(parseDurationToSeconds('0:00')).toBe(0);
  });

  it('returns null for empty string', () => {
    expect(parseDurationToSeconds('')).toBeNull();
  });

  it('returns null for null', () => {
    expect(parseDurationToSeconds(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(parseDurationToSeconds(undefined)).toBeNull();
  });

  it('returns null for non-parseable string', () => {
    expect(parseDurationToSeconds('abc')).toBeNull();
  });

  it('accepts number input', () => {
    expect(parseDurationToSeconds(60)).toBe(60);
  });

  it('returns null for negative number', () => {
    expect(parseDurationToSeconds(-5)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(parseDurationToSeconds(NaN)).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(parseDurationToSeconds(Infinity)).toBeNull();
  });

  it('parses ISO-8601 hours only', () => {
    expect(parseDurationToSeconds('PT2H')).toBe(7200);
  });

  it('parses ISO-8601 minutes only', () => {
    expect(parseDurationToSeconds('PT30M')).toBe(1800);
  });

  it('parses ISO-8601 seconds only', () => {
    expect(parseDurationToSeconds('PT45S')).toBe(45);
  });

  it('handles whitespace around value', () => {
    expect(parseDurationToSeconds('  3:45  ')).toBe(225);
  });
});

// ─── computeUsageStats ──────────────────────────────────────────────────

describe('computeUsageStats', () => {
  it('excludes words without duration from WPM', () => {
    // A: 120 words, "1:00" (60s) — B: 180 words, no duration
    const transcriptions: Transcription[] = [
      {
        duration: '1:00',
        segments: [{ text: Array(120).fill('word').join(' ') }],
      },
      {
        segments: [{ text: Array(180).fill('word').join(' ') }],
      },
    ];
    const stats = computeUsageStats(transcriptions);
    // WPM should be 120 words / 1 minute = 120, NOT (120+180)/1 = 300
    expect(stats.wpm).toBe(120);
    expect(stats.totalWords).toBe(300);
    expect(stats.totalSeconds).toBe(60);
    expect(stats.missingDurationWithWordsCount).toBe(1);
  });

  it('puts explicit zero duration with words into anomaly bucket', () => {
    const transcriptions: Transcription[] = [
      {
        duration: '1:00',
        segments: [{ text: 'hello world' }],
      },
      {
        duration: '0:00',
        segments: [{ text: 'some words here' }],
      },
    ];
    const stats = computeUsageStats(transcriptions);
    expect(stats.zeroDurationWithWordsCount).toBe(1);
    // WPM only from record A: 2 words / 1 min = 2
    expect(stats.wpm).toBe(2);
  });

  it('derives duration from segment timestamps when duration is missing', () => {
    const transcriptions: Transcription[] = [
      {
        segments: [
          { text: 'hello world', end_time: '120s' },
          { text: 'more words', end_time: '180s' },
        ],
      },
    ];
    const stats = computeUsageStats(transcriptions);
    // Duration derived from last segment end_time: 180s = 3:00
    expect(stats.totalSeconds).toBe(180);
    expect(stats.derivedDurationCount).toBe(1);
    expect(stats.wpm).toBe(Math.round(4 / 3)); // 4 words / 3 min
  });

  it('returns wpm=0 when no valid durations exist', () => {
    const transcriptions: Transcription[] = [
      { segments: [{ text: 'some words' }] },
      { segments: [{ text: 'more words' }] },
    ];
    const stats = computeUsageStats(transcriptions);
    expect(stats.wpm).toBe(0);
    expect(Number.isFinite(stats.wpm)).toBe(true);
    expect(stats.totalWords).toBe(4);
  });

  it('regression: all records valid - totals are stable', () => {
    const transcriptions: Transcription[] = [
      {
        duration: '2:00',
        segments: [{ text: Array(100).fill('w').join(' ') }],
      },
      {
        duration: '3:00',
        segments: [{ text: Array(200).fill('w').join(' ') }],
      },
    ];
    const stats = computeUsageStats(transcriptions);
    expect(stats.totalSeconds).toBe(300);
    expect(stats.totalWords).toBe(300);
    // 300 words / 5 min = 60
    expect(stats.wpm).toBe(60);
    expect(stats.missingDurationWithWordsCount).toBe(0);
    expect(stats.zeroDurationWithWordsCount).toBe(0);
  });

  it('handles empty transcriptions array', () => {
    const stats = computeUsageStats([]);
    expect(stats.totalSeconds).toBe(0);
    expect(stats.totalWords).toBe(0);
    expect(stats.wpm).toBe(0);
  });

  it('handles numeric string duration', () => {
    const transcriptions: Transcription[] = [
      {
        duration: '120',
        segments: [{ text: Array(60).fill('w').join(' ') }],
      },
    ];
    const stats = computeUsageStats(transcriptions);
    expect(stats.totalSeconds).toBe(120);
    // 60 words / 2 min = 30
    expect(stats.wpm).toBe(30);
  });
});
