const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('./assign');

const analyst = (id, trustScore, openTasks, extra = {}) => ({ id, name: `A${id}`, trustScore, openTasks, maxOpenTasks: 5, ...extra });

test('tiers follow trust score', () => {
  assert.equal(A.tierOf(85).name, 'Senior');
  assert.equal(A.tierOf(70).name, 'Senior');
  assert.equal(A.tierOf(69.9).name, 'Mid');
  assert.equal(A.tierOf(10).name, 'Junior');
  assert.ok(A.canHandle(40, 'Medium'));
  assert.ok(!A.canHandle(39, 'Medium'));
});

test('equal scores: the analyst with fewer open tasks wins', () => {
  const ranked = A.rankAnalysts({ priority: 'High' }, [analyst(1, 80, 3), analyst(2, 80, 1)]);
  assert.equal(ranked[0].id, 2);
});

test('scores in the same band of 10 tie, then category success decides', () => {
  const task = { priority: 'High', category: 'approval' };
  const ranked = A.rankAnalysts(task, [
    analyst(1, 78, 2, { categoryStats: { approval: { done: 10, onTime: 4 } } }),
    analyst(2, 72, 2, { categoryStats: { approval: { done: 10, onTime: 10 } } }),
  ]);
  assert.equal(ranked[0].id, 2);
});

test('then longest since last assignment', () => {
  const ranked = A.rankAnalysts({ priority: 'Low' }, [
    analyst(1, 50, 1, { lastAssignedAt: '2026-10-20' }),
    analyst(2, 50, 1, { lastAssignedAt: '2026-10-01' }),
  ]);
  assert.equal(ranked[0].id, 2);
});

test('eligible and available analysts come first', () => {
  const ranked = A.rankAnalysts({ priority: 'High' }, [analyst(1, 50, 0), analyst(2, 90, 5), analyst(3, 75, 4)]);
  assert.deepEqual(ranked.map((a) => a.id), [3, 2, 1]);
});

test('auto-assign picks a free Senior, queues without one, falls back to Mid after the wait', () => {
  const task = { priority: 'High' };
  assert.equal(A.pickAutoAssignee(task, [analyst(1, 90, 2), analyst(2, 60, 0)]).analyst.id, 1);
  const busy = [analyst(1, 90, 5), analyst(2, 60, 0), analyst(3, 20, 0)];
  assert.equal(A.pickAutoAssignee(task, busy), null);
  const fb = A.pickAutoAssignee(task, busy, { fallback: true });
  assert.equal(fb.analyst.id, 2);
  assert.ok(fb.fellBack);
  assert.equal(A.pickAutoAssignee(task, [analyst(3, 20, 0)], { fallback: true }), null);
});

test('exclude skips an analyst who declined', () => {
  const r = A.pickAutoAssignee({ priority: 'High' }, [analyst(1, 90, 0), analyst(2, 80, 1)], { exclude: [1] });
  assert.equal(r.analyst.id, 2);
});

test('score changes shrink near the ends and stay in 0-100', () => {
  assert.equal(A.applyScore(50, 3), 53);
  assert.ok(A.applyScore(95, 3) < 98);
  assert.ok(A.applyScore(4, -4) > 0);
  assert.equal(A.applyScore(100, 3), 100);
  assert.equal(A.applyScore(0, -4), 0);
});

test('score deltas', () => {
  assert.equal(A.completionDelta({ onTime: true }), 3);
  assert.equal(A.completionDelta({ onTime: false }), 1);
  assert.equal(A.completionDelta({ onTime: true, rating: 5 }), 7);
  assert.equal(A.reopenDelta({ overridden: false }), -4);
  assert.equal(A.reopenDelta({ overridden: true }), -2);
  assert.equal(A.declineDelta({ valid: true, category: 'other', recentValidDeclines: 0 }), 0);
  assert.equal(A.declineDelta({ valid: false, category: 'other', recentValidDeclines: 0 }), -2);
  assert.equal(A.declineDelta({ valid: true, category: 'other', recentValidDeclines: 3 }), -1);
  assert.equal(A.declineDelta({ valid: false, category: 'conflict_of_interest', recentValidDeclines: 9 }), 0);
});

test('AI due dates are clamped to the bounds for their priority', () => {
  const now = new Date('2026-10-27T09:00:00Z');
  const h = (d) => (d - now) / 36e5;
  assert.equal(h(A.clampDueAt('High', '2026-12-25T00:00:00Z', now)), 72);
  assert.equal(h(A.clampDueAt('High', '2026-10-27T10:00:00Z', now)), 4);
  assert.equal(h(A.clampDueAt('High', '2026-10-28T03:00:00Z', now)), 18);
  assert.equal(h(A.clampDueAt('Medium', 'nonsense', now)), 72);
});

test('override warning only below the needed tier', () => {
  assert.equal(A.overrideWarning({ priority: 'High' }, analyst(1, 80, 0)), null);
  assert.match(A.overrideWarning({ priority: 'High' }, analyst(1, 34, 0)), /Junior tier \(score 34\).*Senior analysts/);
  assert.equal(A.overrideWarning({ priority: 'Low' }, analyst(1, 5, 0)), null);
});
