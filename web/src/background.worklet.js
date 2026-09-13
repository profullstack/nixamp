/* Audio transport only: neural inference runs in a dedicated worker. Never
 * bypass to the original input on an error: that would restore foreign speech. */
class BackgroundTransport extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channel = null; this.alive = true; this.ready = false;
    this.inputs = [new Float32Array(512), new Float32Array(512)];
    this.written = 0; this.id = 0; this.inflight = 0;
    this.queue = []; this.output = null; this.read = 0;
    this.port.onmessage = event => {
      if (event.data.stop) { this.alive = false; this.channel?.close(); return; }
      this.channel = event.data.port;
      this.channel.onmessage = result => {
        if (!this.alive) return;
        this.inflight--;
        if (this.queue.length >= 4) { this.fail(); return; }
        this.queue.push(result.data.channels);
        if (this.queue.length >= 2) this.ready = true;
      };
      this.channel.start();
    };
  }
  fail() { this.alive = false; this.queue = []; this.output = null; this.port.postMessage({ error: true }); }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!this.alive) return false;
    const input = inputs[0];
    if (!input?.[0] || !this.channel) return true;
    const count = input[0].length;
    for (let channel = 0; channel < 2; channel++) this.inputs[channel].set(input[channel] ?? input[0], this.written);
    this.written += count;
    if (this.written === 512) {
      if (this.inflight >= 4) { this.fail(); return false; }
      const channels = this.inputs; this.inflight++;
      this.channel.postMessage({ id: this.id++, channels }, channels.map(one => one.buffer));
      this.inputs = [new Float32Array(512), new Float32Array(512)]; this.written = 0;
    }
    if (!this.ready) return true;
    if (!this.output || this.read === 512) { this.output = this.queue.shift() ?? null; this.read = 0; }
    if (!this.output) { this.ready = false; return true; }
    for (let channel = 0; channel < out.length; channel++) out[channel].set(this.output[channel].subarray(this.read, this.read + count));
    this.read += count;
    return true;
  }
}
registerProcessor("nixamp-background", BackgroundTransport);
