// Spaced repetition for the word bank: an SM-2 style scheduler with short learning steps.
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});

  const MIN = 60 * 1000;
  const DAY = 24 * 60 * MIN;
  const LEARN_STEPS = [1 * MIN, 10 * MIN];
  const MATURE_DAYS = 21;

  function fresh() {
    return { state: 'new', step: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0, due: 0 };
  }

  // grade: 1 again, 2 hard, 3 good, 4 easy. Returns a new card; the input is not changed.
  function schedule(card, grade, now) {
    const c = Object.assign(fresh(), card || {});
    c.reps += 1;
    c.last = now;
    if (c.state === 'new' || c.state === 'learning' || c.state === 'relearning') {
      const relearning = c.state === 'relearning';
      if (grade === 1) {
        c.state = relearning ? 'relearning' : 'learning';
        c.step = 0;
        c.due = now + LEARN_STEPS[0];
      } else if (grade === 2) {
        c.state = relearning ? 'relearning' : 'learning';
        c.due = now + LEARN_STEPS[Math.min(c.step, LEARN_STEPS.length - 1)] * 1.5;
      } else if (grade === 3 && !relearning && c.step + 1 < LEARN_STEPS.length) {
        c.state = relearning ? 'relearning' : 'learning';
        c.step += 1;
        c.due = now + LEARN_STEPS[c.step];
      } else {
        // Graduate: "good" on the last step, or "easy" at any step.
        c.state = 'review';
        c.step = 0;
        c.interval = relearning ? Math.max(1, c.interval) : grade === 4 ? 4 : 1;
        c.due = now + c.interval * DAY;
      }
      return c;
    }
    // Review cards
    if (grade === 1) {
      c.lapses += 1;
      c.ease = Math.max(1.3, c.ease - 0.2);
      c.interval = Math.max(1, Math.round(c.interval * 0.3));
      c.state = 'relearning';
      c.step = 0;
      c.due = now + LEARN_STEPS[1];
      return c;
    }
    if (grade === 2) {
      c.ease = Math.max(1.3, c.ease - 0.15);
      c.interval = Math.max(c.interval + 1, Math.round(c.interval * 1.2));
    } else if (grade === 3) {
      c.interval = Math.max(c.interval + 1, Math.round(c.interval * c.ease));
    } else {
      c.ease += 0.15;
      c.interval = Math.max(c.interval + 2, Math.round(c.interval * c.ease * 1.3));
    }
    c.interval = Math.min(c.interval, 3650);
    c.due = now + c.interval * DAY;
    return c;
  }

  function label(ms) {
    if (ms < 60 * MIN) return Math.max(1, Math.round(ms / MIN)) + ' min';
    if (ms < DAY) return Math.round(ms / (60 * MIN)) + ' h';
    const d = ms / DAY;
    if (d < 31) return Math.round(d) + ' d';
    if (d < 365) return Math.round(d / 30) + ' mo';
    return (d / 365).toFixed(1).replace(/\.0$/, '') + ' y';
  }

  // What each answer would schedule, for the button labels.
  function preview(card, now) {
    return [1, 2, 3, 4].map((g) => label(schedule(card, g, now).due - now));
  }

  function isMature(card) {
    return Boolean(card && card.state === 'review' && card.interval >= MATURE_DAYS);
  }

  function dayKey(now) {
    const d = new Date(now);
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  // Cards to study now: due reviews and learning cards first (oldest due first), then new cards up to the daily limit.
  function queue(items, now, newLeft) {
    const due = items.filter((x) => x.srs && x.srs.state !== 'new' && x.srs.due <= now).sort((a, b) => a.srs.due - b.srs.due);
    const fresh = items.filter((x) => !x.srs || x.srs.state === 'new').sort((a, b) => a.savedAt - b.savedAt).slice(0, Math.max(0, newLeft));
    return due.concat(fresh);
  }

  function counts(items, now, newLeft) {
    const due = items.filter((x) => x.srs && x.srs.state !== 'new' && x.srs.due <= now).length;
    const fresh = Math.min(Math.max(0, newLeft), items.filter((x) => !x.srs || x.srs.state === 'new').length);
    return { due, fresh, total: due + fresh };
  }

  SG.srs = { schedule, preview, isMature, queue, counts, dayKey, fresh, MATURE_DAYS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
