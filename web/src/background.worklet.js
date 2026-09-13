/* Audio transport only: neural inference runs in a dedicated worker. A brief
 * stall drops stale frames and recovers; it must not permanently mute ambience.
 * Never bypass to raw input, which would restore the original dialogue. */
const HOP = 512;
const MAX_PENDING = 32; // Bound work to about 340 ms at 48 kHz.
const MAX_AGE = 12; // Keep audible ambience within about 130 ms of the source.
const PREBUFFER = 4;
class BackgroundTransport extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channel = null; this.alive = true; this.ready = false;
    this.inputs = [];
    this.written = 0; this.id = 0; this.inflight = 0;
    this.queue = []; this.output = null; this.read = 0;
    this.port.onmessage = event => {
      if (event.data.stop) { this.alive = false; this.channel?.close(); return; }
      this.channel = event.data.port;
      this.channel.onmessage = result => {
        if (!this.alive) return;
        this.inflight--;
        const frame = result.data;
        if (!Number.isSafeInteger(frame.id) || !Array.isArray(frame.channels) || frame.channels.length !== 2
            || frame.channels.some(channel => !(channel instanceof Float32Array) || channel.length !== HOP)) { this.fail(); return; }
        // Late background is as distracting as missing background. Discard it
        // while keeping the worker alive to handle the next current frame.
        if (frame.id < this.id - MAX_AGE) return;
        if (this.queue.length >= MAX_PENDING) this.queue.shift();
        this.queue.push(frame);
        if (this.queue.length >= PREBUFFER) this.ready = true;
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
    if (![1, 2, 4, 6, 8].includes(input.length)) { this.fail(); return false; }
    if (this.inputs.length !== input.length) {
      if (this.inputs.length) this.id++; // Discard a partial frame on a layout change.
      this.inputs = input.map(() => new Float32Array(HOP)); this.written = 0;
    }
    const count = input[0].length;
    for (let channel = 0; channel < input.length; channel++) this.inputs[channel].set(input[channel], this.written);
    this.written += count;
    if (this.written === HOP) {
      if (this.inflight < MAX_PENDING) {
        const channels = this.inputs; this.inflight++;
        this.channel.postMessage({ id: this.id, channels }, channels.map(one => one.buffer));
        this.inputs = input.map(() => new Float32Array(HOP));
      }
      // Skip excess work instead of building a backlog or killing the branch.
      this.id++; this.written = 0;
    }
    if (!this.ready) return true;
    if (!this.output || this.read === HOP) {
      while (this.queue.length && this.queue[0].id < this.id - MAX_AGE) this.queue.shift();
      this.output = this.queue.shift()?.channels ?? null; this.read = 0;
    }
    if (!this.output) { this.ready = false; return true; }
    for (let channel = 0; channel < out.length; channel++) out[channel].set(this.output[channel].subarray(this.read, this.read + count));
    this.read += count;
    return true;
  }
}
registerProcessor("nixamp-background", BackgroundTransport);
