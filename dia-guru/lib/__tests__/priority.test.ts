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
});
