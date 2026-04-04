/**
 * Synthesized sound effects via Web Audio API — no asset files required.
 * All sounds are generated procedurally in < 1ms.
 * Respects the global settings.audioEnabled flag (set via window.__CTU_AUDIO).
 */

let _ctx = null;

function ac() {
  if (!_ctx) {
    try { _ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { return null; }
  }
  if (_ctx.state === "suspended") _ctx.resume().catch(() => {});
  return _ctx;
}

function gain(ctx, vol, t) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.connect(ctx.destination);
  return g;
}

const SYNTHS = {
  UnitSelected(ctx, t) {
    const o = ctx.createOscillator();
    const g = gain(ctx, 0.18, t);
    o.type = "sine";
    o.frequency.setValueAtTime(520, t);
    o.frequency.linearRampToValueAtTime(740, t + 0.07);
    g.gain.linearRampToValueAtTime(0, t + 0.1);
    o.connect(g); o.start(t); o.stop(t + 0.1);
  },
  MoveStart(ctx, t) {
    const o = ctx.createOscillator();
    const g = gain(ctx, 0.14, t);
    o.type = "triangle";
    o.frequency.setValueAtTime(180, t);
    o.frequency.linearRampToValueAtTime(120, t + 0.08);
    g.gain.linearRampToValueAtTime(0, t + 0.1);
    o.connect(g); o.start(t); o.stop(t + 0.1);
  },
  AttackImpact(ctx, t) {
    /* Sharp crack: noise burst + low boom */
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.18, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.04));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = gain(ctx, 0.6, t);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass"; lp.frequency.value = 1200;
    src.connect(lp); lp.connect(g);
    src.start(t); src.stop(t + 0.18);
    /* boom */
    const boom = ctx.createOscillator();
    const bg = gain(ctx, 0.35, t);
    boom.type = "sine"; boom.frequency.setValueAtTime(80, t);
    boom.frequency.linearRampToValueAtTime(30, t + 0.15);
    bg.gain.linearRampToValueAtTime(0, t + 0.18);
    boom.connect(bg); boom.start(t); boom.stop(t + 0.18);
  },
  AttackIndirect(ctx, t) {
    const boom = ctx.createOscillator();
    const bg = gain(ctx, 0.45, t);
    boom.type = "sawtooth"; boom.frequency.setValueAtTime(60, t);
    boom.frequency.linearRampToValueAtTime(20, t + 0.3);
    bg.gain.linearRampToValueAtTime(0, t + 0.35);
    boom.connect(bg); boom.start(t); boom.stop(t + 0.35);
  },
  Counter(ctx, t) {
    const o = ctx.createOscillator();
    const g = gain(ctx, 0.2, t);
    o.type = "square"; o.frequency.setValueAtTime(900, t);
    o.frequency.linearRampToValueAtTime(500, t + 0.06);
    g.gain.linearRampToValueAtTime(0, t + 0.07);
    o.connect(g); o.start(t); o.stop(t + 0.07);
  },
  TurnEnd(ctx, t) {
    const o = ctx.createOscillator();
    const g = gain(ctx, 0.15, t);
    o.type = "sine"; o.frequency.setValueAtTime(440, t);
    g.gain.linearRampToValueAtTime(0, t + 0.08);
    o.connect(g); o.start(t); o.stop(t + 0.08);
  },
  Victory(ctx, t) {
    const notes = [523, 659, 784, 1047];
    notes.forEach((hz, i) => {
      const o = ctx.createOscillator();
      const g = gain(ctx, 0.22, t + i * 0.12);
      o.type = "triangle"; o.frequency.value = hz;
      g.gain.linearRampToValueAtTime(0, t + i * 0.12 + 0.25);
      o.connect(g); o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.28);
    });
  },
  Defeat(ctx, t) {
    const notes = [440, 330, 220];
    notes.forEach((hz, i) => {
      const o = ctx.createOscillator();
      const g = gain(ctx, 0.22, t + i * 0.18);
      o.type = "sine"; o.frequency.value = hz;
      g.gain.linearRampToValueAtTime(0, t + i * 0.18 + 0.3);
      o.connect(g); o.start(t + i * 0.18); o.stop(t + i * 0.18 + 0.32);
    });
  },
  ButtonClick(ctx, t) {
    const o = ctx.createOscillator();
    const g = gain(ctx, 0.08, t);
    o.type = "sine"; o.frequency.value = 900;
    g.gain.linearRampToValueAtTime(0, t + 0.04);
    o.connect(g); o.start(t); o.stop(t + 0.04);
  },
};

export const AudioManager = {
  play(name) {
    if (window.__CTU_AUDIO_DISABLED) return;
    const ctx = ac();
    if (!ctx) return;
    const fn = SYNTHS[name];
    if (!fn) return;
    try { fn(ctx, ctx.currentTime + 0.01); } catch {}
  },
};
