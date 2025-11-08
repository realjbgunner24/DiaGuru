import { computePriorityScore } from '../priority';

describe('computePriorityScore', () => {
  const reference = new Date('2025-10-25T12:00:00Z');

  it('boosts high-importance short tasks', () => {
    const score = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 3,
        created_at: '2025-10-25T10:00:00Z',
      },
      reference,
    );
    expect(score).toBeGreaterThan(5);
  });

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

  it('applies recency boost for older tasks', () => {
    const newer = computePriorityScore(
      {
        estimated_minutes: 60,
        importance: 2,
        created_at: '2025-10-24T18:00:00Z',
      },
      reference,
    );
    const older = computePriorityScore(
      {
        estimated_minutes: 60,
        importance: 2,
        created_at: '2025-10-20T12:00:00Z',
      },
      reference,
    );
    expect(older).toBeGreaterThan(newer);
  });

  it('adds strong boost for overdue deadline_time', () => {
    const overdue = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        constraint_type: 'deadline_time',
        constraint_time: '2025-10-25T10:00:00Z',
      },
      reference,
    );
    const flexible = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
      },
      reference,
    );
    expect(overdue).toBeGreaterThan(flexible + 20);
  });

  it('adds near-window boost for deadline_date within 48h', () => {
    const near = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        constraint_type: 'deadline_date',
        constraint_date: '2025-10-26',
      },
      reference,
    );
    const far = computePriorityScore(
      {
        estimated_minutes: 30,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        constraint_type: 'deadline_date',
        constraint_date: '2025-10-30',
      },
      reference,
    );
    expect(near).toBeGreaterThan(far);
  });

  it('boosts start_time within 12h but not 24h away', () => {
    const within = computePriorityScore(
      {
        estimated_minutes: 45,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        constraint_type: 'start_time',
        constraint_time: '2025-10-25T18:00:00Z',
      },
      reference,
    );
    const outside = computePriorityScore(
      {
        estimated_minutes: 45,
        importance: 2,
        created_at: '2025-10-24T12:00:00Z',
        constraint_type: 'start_time',
        constraint_time: '2025-10-26T18:00:00Z',
      },
      reference,
    );
    expect(within).toBeGreaterThan(outside);
  });
});
