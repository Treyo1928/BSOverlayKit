// The casters' voices. The overlay server passes on the Opus packets the caster bot hears in the Discord voice
// channel, one message each: [length of the id][the speaker's Discord id][the packet]. Each speaker gets a decoder
// and a volume of their own; all of them go through one more volume (the panel's Sound card sets both).
//   const voices = makeVoices();  voices.feed(arrayBuffer);  voices.levels(state.show.mix);
const LEAD = 0.09;        // seconds of sound kept in hand, so packets that arrive unevenly still play evenly
const MOST = 0.6;         // further ahead than this and the newest sound is dropped instead of falling behind

export function makeVoices() {
  const ok = typeof AudioDecoder === "function" && typeof AudioContext === "function";
  const stats = { supported: ok, packets: 0, played: 0, dropped: 0, errors: 0, speakers: 0 };
  if (!ok) return { feed() {}, levels() {}, stats, level: () => 0 };
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  const all = ctx.createGain(), meter = ctx.createAnalyser();
  all.connect(meter); meter.connect(ctx.destination);
  const people = new Map();
  let mix = { voicesOn: true, voices: 1, people: {} }, woke = 0;
  const text = new TextDecoder();

  function speaker(id) {
    let p = people.get(id);
    if (p && p.decoder.state === "configured") return p;
    if (!p) {
      p = { gain: ctx.createGain(), at: 0, stamp: 0 };
      p.gain.gain.value = mix.people?.[id] ?? 1;
      p.gain.connect(all);
      people.set(id, p);
      stats.speakers = people.size;
    }
    p.decoder = new AudioDecoder({
      output: (data) => {
        try {
          const buffer = ctx.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
          for (let c = 0; c < data.numberOfChannels; c++) data.copyTo(buffer.getChannelData(c), { planeIndex: c, format: "f32-planar" });
          const now = ctx.currentTime;
          if (p.at < now + 0.01) p.at = now + LEAD;                // the start of a sentence, or we fell behind
          if (p.at > now + MOST) { stats.dropped++; return; }
          const src = ctx.createBufferSource();
          src.buffer = buffer; src.connect(p.gain); src.start(p.at);
          p.at += buffer.duration;
          stats.played++;
        } catch { stats.errors++; } finally { data.close(); }
      },
      error: () => { stats.errors++; },         // the next packet makes a fresh decoder
    });
    p.decoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });
    return p;
  }

  return {
    stats,
    feed(message) {
      const b = new Uint8Array(message);
      if (b.length < 3 || b.length <= 1 + b[0]) return;
      stats.packets++;
      // a browser holds sound back until the page has been clicked in; OBS does not. Keep asking: it costs nothing
      if (ctx.state !== "running" && performance.now() - woke > 1000) { woke = performance.now(); ctx.resume().catch(() => {}); }
      if (ctx.state !== "running") return;
      const p = speaker(text.decode(b.subarray(1, 1 + b[0])));
      if (p.decoder.decodeQueueSize > 25) { stats.dropped++; return; }
      try { p.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: (p.stamp += 20_000), data: b.subarray(1 + b[0]) })); } catch { stats.errors++; }
    },
    /** The panel's levels: all the voices (and whether they are on at all), and each person's own. */
    levels(m) {
      if (!m) return;
      mix = m;
      const t = ctx.currentTime;
      all.gain.setTargetAtTime(m.voicesOn === false ? 0 : Math.max(0, Math.min(2, Number(m.voices ?? 1))), t, 0.03);
      for (const [id, p] of people) p.gain.gain.setTargetAtTime(Math.max(0, Math.min(2, Number(m.people?.[id] ?? 1))), t, 0.03);
    },
    /** How loud the mix is right now (0 to about 1), for checks. */
    level() {
      const a = new Float32Array(meter.fftSize);
      meter.getFloatTimeDomainData(a);
      return Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
    },
  };
}
