import { computePriorityScore } from '../priority';

describe('computePriorityScore', () => {
  const reference = new Date('2025-10-25T12:00:00Z');

  it('penalises long duration tasks', () => {
    const shortScore = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
      },
      reference,
    );
    const longScore = computePriorityScore(
      {
        estimated_minutes: 240,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
      },
      reference,
    );
    expect(longScore).toBeLessThan(shortScore);
  });

  it('applies recency boost for older captures', () => {
    const newer = computePriorityScore(
      {
        estimated_minutes: 45,
        importance: 2,
        created_at: '2025-10-24T18:00:00Z',
      },
      reference,
    );
    const older = computePriorityScore(
      {
        estimated_minutes: 45,
        importance: 2,
        created_at: '2025-10-20T12:00:00Z',
      },
      reference,
    );
    expect(older).toBeGreaterThan(newer);
  });

  it('adds strong boost for imminent deadlines', () => {
    const imminent = computePriorityScore(
      {
        estimated_minutes: 60,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        deadline_at: '2025-10-25T13:00:00Z',
      },
      reference,
    );
    const flexible = computePriorityScore(
      {
        estimated_minutes: 60,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
      },
      reference,
    );
    expect(imminent).toBeGreaterThan(flexible + 5);
  });

  it('treats manual start targets as deadlines, but soft starts are gentler', () => {
    const hardStart = computePriorityScore(
      {
        estimated_minutes: 45,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        start_target_at: '2025-10-25T13:00:00Z',
        is_soft_start: false,
      },
      reference,
    );
    const softStart = computePriorityScore(
      {
        estimated_minutes: 45,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        start_target_at: '2025-10-25T13:00:00Z',
        is_soft_start: true,
      },
      reference,
    );
    expect(hardStart).toBeGreaterThan(softStart);
  });

  it('uses externality score as a nudge', () => {
    const solo = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        externality_score: 0,
      },
      reference,
    );
    const collaborative = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        externality_score: 3,
      },
      reference,
    );
    expect(collaborative).toBeGreaterThan(solo);
  });
});
