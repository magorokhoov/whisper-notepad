/**
 * Забирает моно-сигнал с микрофона и отдаёт его в основной поток
 * кусками по 128 сэмплов (квант AudioWorklet).
 */
class PcmCollector extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    const channel = input && input[0]
    if (channel && channel.length > 0) {
      const copy = new Float32Array(channel.length)
      copy.set(channel)
      this.port.postMessage(copy.buffer, [copy.buffer])
    }
    return true
  }
}

registerProcessor('pcm-collector', PcmCollector)
