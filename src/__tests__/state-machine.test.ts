import { describe, expect, it } from 'vitest';
import { RecordingStateMachine } from '../state-machine';

describe('RecordingStateMachine meeting mode', () => {
  it('uses meeting states when meeting mode is enabled', () => {
    const machine = new RecordingStateMachine();
    machine.setMeetingMode(true);

    expect(machine.transition('hotkey_press')).toBe(true);
    expect(machine.currentState).toBe('meeting_recording');

    expect(machine.transition('hotkey_press')).toBe(true);
    expect(machine.currentState).toBe('meeting_processing');

    expect(machine.transition('notes_complete')).toBe(true);
    expect(machine.currentState).toBe('idle');
  });

  it('uses regular dictation states when meeting mode is disabled', () => {
    const machine = new RecordingStateMachine();
    machine.setMeetingMode(false);

    expect(machine.transition('hotkey_press')).toBe(true);
    expect(machine.currentState).toBe('recording');
  });
});
