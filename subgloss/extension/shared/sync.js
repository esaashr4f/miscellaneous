// Lines up a downloaded subtitle file with subtitles the site itself provides (in any
// language). Lines are spoken at the same moments whatever the language, so the shift that
// makes the most line starts coincide is the right one. Also tries the common 25 / 23.976 fps
// mismatch, which makes a file drift further out of sync as the episode goes on.
(function (root) {
  'use strict';
  const SG = (root.SG = root.SG || {});

  const MAX_SHIFT = 120; // seconds
  const STEP = 0.1;
  const SCALES = [1, 25 / 23.976, 23.976 / 25];

  function lowerBound(arr, x) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // How many lines start within `tol` seconds of a reference line when shifted by `offset`.
  function countMatches(refStarts, starts, offset, tol) {
    let n = 0;
    for (const s of starts) {
      const t = s + offset;
      const i = lowerBound(refStarts, t - tol);
      if (i < refStarts.length && refStarts[i] <= t + tol) n++;
    }
    return n;
  }

  function tryScale(refStarts, cues, scale) {
    const starts = cues.map((c) => c.start * scale);
    const bins = new Map();
    for (const s of starts) {
      const from = lowerBound(refStarts, s - MAX_SHIFT);
      for (let i = from; i < refStarts.length && refStarts[i] <= s + MAX_SHIFT; i++) {
        const b = Math.round((refStarts[i] - s) / STEP);
        bins.set(b, (bins.get(b) || 0) + 1);
      }
    }
    // Smooth over +-0.3 s, since the two files' line starts never agree exactly. Weight the
    // centre most, so a window that merely contains the peak never beats the peak itself.
    const W = [4, 3, 2, 1];
    let bestBin = 0;
    let bestScore = -1;
    for (const b of bins.keys()) {
      let score = 0;
      for (let d = -3; d <= 3; d++) score += (bins.get(b + d) || 0) * W[Math.abs(d)];
      if (score > bestScore || (score === bestScore && Math.abs(b) < Math.abs(bestBin))) {
        bestScore = score;
        bestBin = b;
      }
    }
    // Refine: the median gap between each line and its nearest reference line near that shift.
    const rough = bestBin * STEP;
    const gaps = [];
    for (const st of starts) {
      const t = st + rough;
      const i = lowerBound(refStarts, t - 0.5);
      let best = null;
      for (let j = i; j < refStarts.length && refStarts[j] <= t + 0.5; j++) {
        const g = refStarts[j] - st;
        if (best == null || Math.abs(g - rough) < Math.abs(best - rough)) best = g;
      }
      if (best != null) gaps.push(best);
    }
    gaps.sort((a, b) => a - b);
    const offset = gaps.length ? gaps[gaps.length >> 1] : rough;
    const matched = countMatches(refStarts, starts, offset, 0.5);
    return { offset: Math.round(offset * 100) / 100, scale, matched };
  }

  // Returns { offset, scale, matched, confidence, ok }. Apply as: new time = old time * scale + offset.
  function align(refCues, cues) {
    const refStarts = refCues.map((c) => c.start).sort((a, b) => a - b);
    if (refStarts.length < 8 || cues.length < 8) return { offset: 0, scale: 1, matched: 0, confidence: 0, ok: false };
    let best = null;
    for (const scale of SCALES) {
      const r = tryScale(refStarts, cues, scale);
      // Prefer no rescaling unless it clearly helps.
      const bonus = scale === 1 ? 1.05 : 1;
      if (!best || r.matched * bonus > best.matched * (best.scale === 1 ? 1.05 : 1)) best = r;
    }
    const confidence = best.matched / Math.min(refStarts.length, cues.length);
    best.confidence = Math.round(confidence * 100) / 100;
    best.ok = best.matched >= 8 && confidence >= 0.25;
    return best;
  }

  SG.sync = { align };
})(typeof globalThis !== 'undefined' ? globalThis : this);
