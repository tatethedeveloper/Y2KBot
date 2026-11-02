// Y2Kbot sound effects — original, synthesized with Web Audio (no sampled audio).
const Sounds = (() => {
  let ctx;
  let muted = false;
  const ac = () => (ctx ??= new (window.AudioContext || window.webkitAudioContext)());

  /** One bell-ish note: a sine with a soft attack and a long-ish tail, plus a faint octave shimmer. */
  function bell(freq, start, dur, vol = 0.06, glide = 0) {
    const a = ac();
    const t = a.currentTime + start;
    for (const [mult, v] of [[1, vol], [2, vol * 0.25]]) {
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(freq * mult, t);
      if (glide) o.frequency.exponentialRampToValueAtTime(freq * mult * glide, t + dur);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(v, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(a.destination);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  /** A quick pitch-bent blip (bubbles, pops). */
  function blip(from, to, start, dur, vol = 0.07, type = "sine") {
    const a = ac();
    const t = a.currentTime + start;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  const play = (fn) => { if (!muted) try { fn(); } catch {} };

  return {
    toggle() { muted = !muted; return !muted; },
    get muted() { return muted; },
    // an agent signs on: three rising sparkly notes
    signOn: () => play(() => { bell(784, 0, 0.35); bell(1175, 0.08, 0.35); bell(1568, 0.16, 0.5, 0.05); }),
    // an agent signs off: the same idea, falling and softer
    signOff: () => play(() => { bell(1175, 0, 0.3, 0.045); bell(880, 0.09, 0.3, 0.045); bell(587, 0.18, 0.45, 0.04); }),
    // incoming IM: a bubbly double "bloop"
    imIn: () => play(() => { blip(420, 980, 0, 0.11, 0.08); blip(560, 1320, 0.12, 0.13, 0.07); }),
    // outgoing IM: a tiny upward swoosh
    imOut: () => play(() => { blip(500, 1400, 0, 0.09, 0.05, "triangle"); }),
    // an XP machine boots: a warm major-seventh chord, rolled
    boot: () => play(() => [523, 659, 784, 988].forEach((f, i) => bell(f, i * 0.12, 1.1, 0.045))),
    // warning: two low descending pops
    warn: () => play(() => { blip(300, 180, 0, 0.18, 0.08, "triangle"); blip(240, 140, 0.2, 0.22, 0.08, "triangle"); }),
  };
})();
