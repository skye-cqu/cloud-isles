// WebAudio 合成音效：环境风、脚步、放置、拾取、烹饪、任务、UI、损伤。零外部资产与依赖。
// 浏览器手势策略：首次用户交互后 resume；M 静音状态持久化 localStorage。
export class AudioSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private windGain: GainNode | null = null;
  muted = localStorage.getItem("cloud-isles-muted") === "1";
  private stepAcc = 0;

  private ensure(): AudioContext | null {
    if (this.ctx) { if (this.ctx.state === "suspended") void this.ctx.resume(); return this.ctx; }
    try {
      const ctx = new AudioContext();
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(ctx.destination);
      this.ctx = ctx;
      this.startWind();
      return ctx;
    } catch { return null; }
  }

  /** 首次用户手势时调用（解锁 AudioContext） */
  resume() { this.ensure(); }

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem("cloud-isles-muted", this.muted ? "1" : "0");
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.5, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  // ---------- 合成原语 ----------

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number, delay = 0) {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  private noiseBurst(dur: number, vol: number, filterHz: number, delay = 0) {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const t0 = ctx.currentTime + delay;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = filterHz;
    const gain = ctx.createGain();
    gain.gain.value = vol;
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t0);
  }

  // ---------- 环境风（常驻循环，音量随航行/滑翔强度） ----------

  private startWind() {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;
    const gain = ctx.createGain();
    gain.gain.value = 0.05;
    src.connect(filter).connect(gain).connect(this.master!);
    src.start();
    this.windGain = gain;
  }

  /** windLevel 0..1：停泊 0.12，航行随速度，滑翔 0.5+ */
  update(dt: number, windLevel: number) {
    if (!this.windGain || !this.ctx || this.muted) return;
    const target = 0.04 + Math.min(1, Math.max(0, windLevel)) * 0.3;
    this.windGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.4);
  }

  // ---------- 具体音效 ----------

  footstep(dt: number, moving: boolean) {
    if (!moving) { this.stepAcc = 0.2; return; }
    this.stepAcc += dt;
    if (this.stepAcc >= 0.42) {
      this.stepAcc = 0;
      this.noiseBurst(0.09, 0.1, 900);
    }
  }

  pickup() { this.tone(880, 0.1, "sine", 0.18, 1320); }
  place() { this.noiseBurst(0.12, 0.3, 500); this.tone(180, 0.14, "triangle", 0.22, 120); }
  uiClick() { this.tone(660, 0.05, "square", 0.06); }
  cook() { this.noiseBurst(0.4, 0.14, 1600); this.tone(520, 0.3, "sine", 0.12, 780, 0.25); }
  quest() { this.tone(660, 0.12, "sine", 0.16); this.tone(880, 0.14, "sine", 0.16, undefined, 0.1); this.tone(1100, 0.2, "sine", 0.14, undefined, 0.2); }
  levelUp() { this.tone(520, 0.16, "triangle", 0.2); this.tone(780, 0.18, "triangle", 0.2, undefined, 0.12); this.tone(1040, 0.3, "triangle", 0.18, undefined, 0.26); }
  docked() { this.tone(320, 0.3, "sine", 0.2, 260); this.noiseBurst(0.3, 0.12, 300, 0.05); }
  undocked() { this.noiseBurst(0.5, 0.16, 240); this.tone(220, 0.4, "sine", 0.14, 330); }
  damage() { this.tone(160, 0.16, "sawtooth", 0.2, 90); }
  open() { this.tone(440, 0.08, "sine", 0.1, 560); }
}
