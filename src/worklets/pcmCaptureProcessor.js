class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = 1024;
    this.buffer = new Float32Array(this.chunkSize);
    this.bufferOffset = 0;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (output) {
      for (let channelIndex = 0; channelIndex < output.length; channelIndex += 1) {
        output[channelIndex].fill(0);
      }
    }

    const input = inputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
      return true;
    }

    const frameCount = input[0].length;
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      let mixedSample = 0;
      for (let channelIndex = 0; channelIndex < input.length; channelIndex += 1) {
        mixedSample += input[channelIndex][frameIndex] || 0;
      }

      const monoSample = mixedSample / input.length;
      this.buffer[this.bufferOffset] = monoSample;
      this.bufferOffset += 1;

      if (this.bufferOffset === this.chunkSize) {
        this.flushBuffer();
      }
    }

    return true;
  }

  flushBuffer() {
    const pcmBuffer = new ArrayBuffer(this.chunkSize * 2);
    const pcmView = new DataView(pcmBuffer);

    for (let index = 0; index < this.chunkSize; index += 1) {
      const sample = Math.max(-1, Math.min(1, this.buffer[index] * 1.2));
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      pcmView.setInt16(index * 2, int16, true);
    }

    this.port.postMessage(pcmBuffer, [pcmBuffer]);
    this.bufferOffset = 0;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
