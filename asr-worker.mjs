/**
 * Whisper ASR в отдельном потоке.
 *
 * Модель загружается один раз, затем воркер последовательно распознаёт
 * пришедшие фразы. Отдельный поток нужен, чтобы декодирование (8–10 секунд
 * на фразу) не блокировало HTTP-сервер и приём аудио.
 */
import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'

const require = createRequire(import.meta.url)
const sherpa = require('sherpa-onnx-node')

const SAMPLE_RATE = 16000
const { model, threads, language } = workerData

const BLANK_MARKERS = /^\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE|SOUND)\]$/i

function errorText(error) {
  const text = error?.message || String(error)
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text
}

let recognizer = null

try {
  const started = performance.now()
  recognizer = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder: model.encoder,
        decoder: model.decoder,
        language: language === 'auto' ? '' : language,
        task: 'transcribe',
      },
      tokens: model.tokens,
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
    },
  })
  parentPort.postMessage({
    type: 'ready',
    loadMs: Math.round(performance.now() - started),
    language,
    threads,
  })
} catch (error) {
  parentPort.postMessage({ type: 'error', message: errorText(error) })
}

if (recognizer) {
  parentPort.on('message', (message) => {
    if (message?.type !== 'decode') return

    const started = performance.now()
    try {
      const pcm = message.pcm
      const samples = new Float32Array(pcm.length)
      for (let i = 0; i < pcm.length; i += 1) samples[i] = pcm[i] / 32768

      const stream = recognizer.createStream()
      stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
      recognizer.decode(stream)
      const text = (recognizer.getResult(stream)?.text || '')
        .replace(/\s+/g, ' ')
        .replace(/\s+([,.;:!?])/g, '$1')
        .trim()

      parentPort.postMessage({
        type: 'result',
        id: message.id,
        text,
        ms: Math.round(performance.now() - started),
        skip: text.length === 0 || BLANK_MARKERS.test(text),
      })
    } catch (error) {
      parentPort.postMessage({
        type: 'decode-error',
        id: message.id,
        message: errorText(error),
      })
    }
  })
}
