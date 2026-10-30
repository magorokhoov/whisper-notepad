/**
 * Whisper-блокнот — локальный сервер.
 *
 * Браузер присылает моно-PCM 16 кГц по WebSocket. Сервер режет поток по тишине
 * (VAD), отправляет каждую фразу в отдельный поток с sherpa-onnx Whisper и
 * возвращает распознанный текст обратно в блокнот.
 */
import http from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { extname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { WebSocketServer, WebSocket } from 'ws'

const SAMPLE_RATE = 16000
const FRAME_SAMPLES = 320 // 20 мс
const FRAME_MS = 20
const MAX_BODY = 16 * 1024

const PUBLIC_DIR = join(import.meta.dirname, 'public')

function argValue(name, fallback) {
  const argv = process.argv.slice(2)
  const withEquals = argv.find((item) => item.startsWith(`${name}=`))
  if (withEquals) return withEquals.slice(name.length + 1)
  const index = argv.indexOf(name)
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1]
  return fallback
}

const PORT = Number(argValue('--port', process.env.PORT || 8765))
const OPEN_BROWSER = process.argv.includes('--open')
const DEFAULT_THREADS = Number(argValue('--threads', 8))
const DEFAULT_LANGUAGE = argValue('--language', 'ru')

const MODEL_ARG = argValue('--model', '')
const MODEL_CANDIDATES = [
  process.env.WHISPER_MODEL,
  join(import.meta.dirname, 'models', 'medium'),
].filter(Boolean)
const DEFAULT_MODEL = MODEL_ARG
  ? expandHome(MODEL_ARG)
  : MODEL_CANDIDATES.find((candidate) => existsSync(candidate)) ||
    join(import.meta.dirname, 'models', 'medium')

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function expandHome(input) {
  const value = String(input || '').trim()
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  if (value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return resolve(value)
}

async function resolveModelPath(input) {
  const raw = String(input || '').trim()
  if (!raw) throw new Error('Укажите путь к папке с моделью Whisper.')

  const dir = expandHome(raw)
  const info = await stat(dir).catch(() => null)
  if (!info || !info.isDirectory()) {
    throw new Error(
      `Папка с моделью не найдена: ${dir}. ` +
        'Укажите папку с моделью в панели «Модель».',
    )
  }

  const entries = await readdir(dir).catch(() => null)
  if (!entries) throw new Error(`Не удалось прочитать папку модели: ${dir}`)

  const files = new Set(entries)
  const variants = []

  // Обычные имена: encoder.int8.onnx + decoder.int8.onnx + tokens.txt.
  for (const quantization of ['int8', 'fp32']) {
    const suffix = quantization === 'int8' ? '.int8.onnx' : '.onnx'
    variants.push({
      quantization,
      encoder: `encoder${suffix}`,
      decoder: `decoder${suffix}`,
      tokens: 'tokens.txt',
    })
  }

  // Имена из Hugging Face: small-encoder.int8.onnx, medium-decoder.int8.onnx,
  // large-v3-tokens.txt. Поддерживаем любой префикс, чтобы папку не переименовывать.
  const prefixed = new Map()
  for (const name of entries) {
    const match = name.match(/^(.+)-encoder(\.int8)?\.onnx$/)
    if (!match) continue
    const prefix = match[1]
    const quantization = match[2] ? 'int8' : 'fp32'
    prefixed.set(`${prefix}\u0000${quantization}`, prefix)
  }
  for (const key of [...prefixed.keys()].sort()) {
    const [prefix, quantization] = key.split('\u0000')
    const suffix = quantization === 'int8' ? '.int8.onnx' : '.onnx'
    variants.push({
      quantization,
      encoder: `${prefix}-encoder${suffix}`,
      decoder: `${prefix}-decoder${suffix}`,
      tokens: `${prefix}-tokens.txt`,
    })
    variants.push({
      quantization,
      encoder: `${prefix}-encoder${suffix}`,
      decoder: `${prefix}-decoder${suffix}`,
      tokens: 'tokens.txt',
    })
  }

  const variant = variants.find(
    (candidate) =>
      files.has(candidate.encoder) && files.has(candidate.decoder) && files.has(candidate.tokens),
  )

  if (!variant) {
    throw new Error(
      `В папке ${dir} не найдена модель Whisper. Нужны encoder.int8.onnx, ` +
        'decoder.int8.onnx и tokens.txt — либо файлы с префиксом, например ' +
        'small-encoder.int8.onnx, small-decoder.int8.onnx и small-tokens.txt.',
    )
  }

  return {
    dir,
    name: dir.split(/[\\/]/).filter(Boolean).pop() || dir,
    quantization: variant.quantization,
    encoder: join(dir, variant.encoder),
    decoder: join(dir, variant.decoder),
    tokens: join(dir, variant.tokens),
  }
}

/* ------------------------------------------------------------------ */
/* ASR-движок                                                          */
/* ------------------------------------------------------------------ */

const asr = {
  worker: null,
  generation: 0,
  model: null,
  threads: clamp(Math.round(DEFAULT_THREADS) || 8, 1, 16),
  language: ['ru', 'en', 'auto'].includes(DEFAULT_LANGUAGE) ? DEFAULT_LANGUAGE : 'ru',
  state: 'starting',
  error: null,
  loadMs: null,
  pending: new Map(),
  seq: 0,
}

function statusSnapshot() {
  return {
    type: 'status',
    state: asr.state,
    modelPath: asr.model?.dir || expandHome(DEFAULT_MODEL),
    modelName: asr.model?.name || null,
    modelQuantization: asr.model?.quantization || null,
    threads: asr.threads,
    language: asr.language,
    loadMs: asr.loadMs,
    error: asr.error,
    pending: asr.pending.size,
    sampleRate: SAMPLE_RATE,
  }
}

function queueSnapshot() {
  let audioSec = 0
  for (const item of asr.pending.values()) audioSec += item.audioSec
  return {
    type: 'queue',
    pending: asr.pending.size,
    audioSec: Math.round(audioSec * 10) / 10,
  }
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
}

function broadcast(payload) {
  for (const client of wss.clients) sendJson(client, payload)
}

function broadcastStatus() {
  broadcast(statusSnapshot())
}

function broadcastQueue() {
  broadcast(queueSnapshot())
}

async function startAsr(pathInput, threadsInput, languageInput) {
  const model = await resolveModelPath(pathInput)
  const threads = clamp(Math.round(Number(threadsInput) || 8), 1, 16)
  const language = ['ru', 'en', 'auto'].includes(languageInput) ? languageInput : 'ru'

  const gen = ++asr.generation
  if (asr.worker) {
    const old = asr.worker
    asr.worker = null
    old.removeAllListeners()
    old.terminate().catch(() => {})
  }

  for (const meta of asr.pending.values()) {
    sendJson(meta.ws, { type: 'error', message: 'Модель перезагружается — текущая фраза отменена.' })
  }
  asr.pending.clear()

  asr.model = model
  asr.threads = threads
  asr.language = language
  asr.state = 'loading'
  asr.error = null
  asr.loadMs = null

  const worker = new Worker(new URL('./asr-worker.mjs', import.meta.url), {
    workerData: { model, threads, language },
  })
  asr.worker = worker

  worker.on('message', (message) => {
    if (gen !== asr.generation) return

    if (message.type === 'ready') {
      asr.state = 'ready'
      asr.loadMs = message.loadMs
      asr.error = null
      console.log(
        `[asr] модель готова за ${(message.loadMs / 1000).toFixed(1)} с ` +
          `(${asr.model.dir}, ${asr.model.quantization}, ${threads} потоков, язык ${language})`,
      )
      broadcastStatus()
      return
    }

    if (message.type === 'error') {
      asr.state = 'error'
      asr.error = message.message
      console.error(`[asr] ошибка загрузки: ${message.message}`)
      broadcastStatus()
      return
    }

    if (message.type === 'result' || message.type === 'decode-error') {
      const meta = asr.pending.get(message.id)
      if (!meta) return
      asr.pending.delete(message.id)

      if (message.type === 'decode-error') {
        console.error(`[asr] ошибка распознавания: ${message.message}`)
        sendJson(meta.ws, { type: 'error', message: `Не удалось распознать фразу: ${message.message}` })
      } else if (message.skip) {
        sendJson(meta.ws, {
          type: 'skipped',
          id: message.id,
          epoch: meta.epoch,
          audioSec: meta.audioSec,
          waitMs: Date.now() - meta.enqueuedAt,
        })
      } else {
        sendJson(meta.ws, {
          type: 'result',
          id: message.id,
          text: message.text,
          epoch: meta.epoch,
          audioSec: meta.audioSec,
          waitMs: Date.now() - meta.enqueuedAt,
          decodeMs: message.ms,
        })
      }
      broadcastQueue()
    }
  })

  worker.on('error', (error) => {
    if (gen !== asr.generation) return
    asr.state = 'error'
    asr.error = error?.message || String(error)
    console.error(`[asr] поток упал: ${asr.error}`)
    broadcastStatus()
  })

  worker.on('exit', (code) => {
    if (gen !== asr.generation) return
    if (code !== 0 && asr.state !== 'error') {
      asr.state = 'error'
      asr.error = `Поток распознавания завершился с кодом ${code}.`
      console.error(`[asr] ${asr.error}`)
      broadcastStatus()
    }
  })

  broadcastStatus()
  return statusSnapshot()
}

function enqueueSegment(ws, pcm, audioSec, epoch) {
  if (asr.state !== 'ready' || !asr.worker) {
    sendJson(ws, {
      type: 'error',
      message:
        asr.state === 'loading'
          ? 'Модель ещё загружается — фраза не распознана.'
          : `Распознавание недоступно: ${asr.error || asr.state}`,
    })
    return
  }

  const id = String(++asr.seq)
  const meta = { ws, epoch, audioSec, enqueuedAt: Date.now() }
  asr.pending.set(id, meta)
  asr.worker.postMessage({ type: 'decode', id, pcm }, [pcm.buffer])
  broadcastQueue()
}

/* ------------------------------------------------------------------ */
/* VAD: нарезка потока по паузам                                       */
/* ------------------------------------------------------------------ */

class Segmenter {
  constructor(options, handlers) {
    this.options = {
      silenceMs: 900,
      minSpeechMs: 300,
      maxUtteranceMs: 28_000,
      sensitivity: 0.55,
    }
    this.handlers = handlers
    this.configure(options)
    this.reset()
  }

  configure(options = {}) {
    if (Number.isFinite(options.silenceMs)) {
      this.options.silenceMs = clamp(options.silenceMs, 300, 3000)
    }
    if (Number.isFinite(options.sensitivity)) {
      this.options.sensitivity = clamp(options.sensitivity, 0, 1)
    }
    this.thresholdScale = 1.35 - this.options.sensitivity * 0.7
  }

  reset() {
    this.speaking = false
    this.frames = []
    this.preRoll = []
    this.silenceFrames = 0
    this.speechFrames = 0
    this.tail = new Int16Array(0)
    this.noiseFloor = 0.0025
  }

  feed(pcm) {
    if (!pcm || pcm.length === 0) return

    const merged = new Int16Array(this.tail.length + pcm.length)
    merged.set(this.tail)
    merged.set(pcm, this.tail.length)

    let offset = 0
    while (offset + FRAME_SAMPLES <= merged.length) {
      const frame = new Float32Array(FRAME_SAMPLES)
      for (let i = 0; i < FRAME_SAMPLES; i += 1) {
        frame[i] = merged[offset + i] / 32768
      }
      this.step(frame)
      offset += FRAME_SAMPLES
    }
    this.tail = merged.slice(offset)
  }

  step(frame) {
    let energy = 0
    for (let i = 0; i < frame.length; i += 1) energy += frame[i] * frame[i]
    const rms = Math.sqrt(energy / frame.length)

    const threshold = Math.max(0.004, this.noiseFloor * 2.8) * this.thresholdScale

    if (!this.speaking) {
      if (rms > threshold) {
        this.speaking = true
        this.speechFrames = 1
        this.silenceFrames = 0
        this.frames = [...this.preRoll, frame]
        this.preRoll = []
        this.handlers.onSpeech(true)
        return
      }

      this.preRoll.push(frame)
      if (this.preRoll.length > 12) this.preRoll.shift() // 240 мс предыстории

      if (rms < threshold * 1.8) {
        this.noiseFloor = clamp(
          0.97 * this.noiseFloor + 0.03 * Math.min(rms, threshold),
          0.0006,
          0.03,
        )
      }
      return
    }

    this.frames.push(frame)

    if (rms > threshold) {
      this.speechFrames += 1
      this.silenceFrames = 0
    } else {
      this.silenceFrames += 1
    }

    const durationMs = this.frames.length * FRAME_MS
    if (this.silenceFrames * FRAME_MS >= this.options.silenceMs) {
      this.finish(false)
    } else if (durationMs >= this.options.maxUtteranceMs) {
      this.finish(true)
    }
  }

  flush() {
    if (this.speaking) {
      this.finish(true)
    } else {
      this.frames = []
      this.preRoll = []
      this.silenceFrames = 0
      this.speechFrames = 0
      this.tail = new Int16Array(0)
    }
  }

  finish(forced) {
    if (!this.speaking) return

    const speechMs = this.speechFrames * FRAME_MS
    const keepTrailing = forced ? this.silenceFrames : Math.min(this.silenceFrames, 5)
    const dropTrailing = Math.max(0, this.silenceFrames - keepTrailing)
    const frames = dropTrailing > 0 ? this.frames.slice(0, -dropTrailing) : this.frames

    const pcm = new Int16Array(frames.length * FRAME_SAMPLES)
    let cursor = 0
    for (const frame of frames) {
      for (let i = 0; i < FRAME_SAMPLES; i += 1) {
        const value = Math.round(frame[i] * 32768)
        pcm[cursor] = clamp(value, -32768, 32767)
        cursor += 1
      }
    }

    this.speaking = false
    this.frames = []
    this.silenceFrames = 0
    this.speechFrames = 0
    this.preRoll = []
    this.handlers.onSpeech(false)

    if (speechMs >= this.options.minSpeechMs && pcm.length > 0) {
      this.handlers.onSegment(pcm, speechMs / 1000)
    }
  }
}

/* ------------------------------------------------------------------ */
/* HTTP + WebSocket                                                    */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

async function readJson(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('Слишком большое тело запроса.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new Error('Некорректный JSON.'))
      }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

    if (url.pathname === '/api/state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(statusSnapshot()))
      return
    }

    if (url.pathname === '/api/model' && req.method === 'POST') {
      const body = await readJson(req)
      try {
        const snapshot = await startAsr(body.path, body.threads, body.language)
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: true, status: snapshot }))
      } catch (error) {
        res.writeHead(400, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: error.message }))
      }
      return
    }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end('Method not allowed')
      return
    }

    const pathname = url.pathname === '/' ? '/index.html' : url.pathname
    const filePath = resolve(PUBLIC_DIR, `.${decodeURIComponent(pathname)}`)
    if (!filePath.startsWith(PUBLIC_DIR + sep)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    const info = await stat(filePath).catch(() => null)
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Не найдено')
      return
    }

    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(filePath).pipe(res)
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`Ошибка сервера: ${error.message}`)
  }
})

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 * 1024 })

wss.on('connection', (ws) => {
  let listening = false
  let epoch = 0

  const vad = new Segmenter(
    {},
    {
      onSpeech(active) {
        sendJson(ws, { type: 'speech', active })
      },
      onSegment(pcm, audioSec) {
        enqueueSegment(ws, pcm, audioSec, epoch)
      },
    },
  )

  sendJson(ws, statusSnapshot())
  sendJson(ws, queueSnapshot())

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!listening) return
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
      if (buffer.length < 2) return
      const pcm = new Int16Array(buffer.length >> 1)
      for (let i = 0; i < pcm.length; i += 1) pcm[i] = buffer.readInt16LE(i * 2)
      vad.feed(pcm)
      return
    }

    let message
    try {
      message = JSON.parse(data.toString())
    } catch {
      return
    }

    if (message.type === 'start') {
      epoch = Number.isFinite(message.epoch) ? message.epoch : epoch + 1
      vad.configure({
        silenceMs: message.silenceMs,
        sensitivity: message.sensitivity,
      })
      vad.reset()
      listening = true
      sendJson(ws, { type: 'listening', value: true, epoch })
      return
    }

    if (message.type === 'stop') {
      if (!listening) return
      listening = false
      vad.flush()
      sendJson(ws, { type: 'listening', value: false })
      return
    }

    if (message.type === 'reset') {
      epoch = Number.isFinite(message.epoch) ? message.epoch : epoch + 1
      vad.reset()
      sendJson(ws, { type: 'listening', value: listening, epoch })
      return
    }

    if (message.type === 'hello') {
      sendJson(ws, statusSnapshot())
      sendJson(ws, queueSnapshot())
    }
  })

  ws.on('close', () => {
    listening = false
    vad.reset()
  })

  ws.on('error', () => {})
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Порт ${PORT} занят. Запустите с другим портом: node server.mjs --port 8766`)
  } else {
    console.error(error)
  }
  process.exit(1)
})

function openBrowser(url) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]

  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => {})
  child.unref()
}

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`
  console.log('')
  console.log('  Whisper-блокнот')
  console.log(`  ${url}`)
  console.log(`  модель: ${expandHome(DEFAULT_MODEL)}`)
  if (!existsSync(expandHome(DEFAULT_MODEL))) {
    console.log('  модель не найдена — укажите путь в панели «Модель»')
  }
  console.log('  остановить: Ctrl+C')
  console.log('')

  const canOpen =
    process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  if (OPEN_BROWSER && canOpen) openBrowser(url)
})

async function shutdown() {
  if (asr.worker) {
    asr.worker.removeAllListeners()
    await asr.worker.terminate().catch(() => {})
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

startAsr(DEFAULT_MODEL, DEFAULT_THREADS, DEFAULT_LANGUAGE).catch((error) => {
  asr.state = 'error'
  asr.error = error.message
  console.error(`[asr] ${error.message}`)
  broadcastStatus()
})
