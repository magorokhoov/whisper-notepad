const $ = (id) => document.getElementById(id)

const els = {
  connectionPill: $('connectionPill'),
  connectionText: $('connectionText'),
  modelPill: $('modelPill'),
  modelPillText: $('modelPillText'),

  recordBtn: $('recordBtn'),
  recordLabel: $('recordLabel'),
  stateDot: $('stateDot'),
  stateText: $('stateText'),
  levelBar: $('levelBar'),
  timer: $('timer'),

  notepad: $('notepad'),
  stats: $('stats'),
  latency: $('latency'),
  draftNote: $('draftNote'),

  copyBtn: $('copyBtn'),
  clearBtn: $('clearBtn'),
  saveTxtBtn: $('saveTxtBtn'),
  saveMdBtn: $('saveMdBtn'),

  modelPath: $('modelPath'),
  loadModelBtn: $('loadModelBtn'),
  modelInfo: $('modelInfo'),
  language: $('language'),
  silence: $('silence'),
  silenceValue: $('silenceValue'),
  sensitivity: $('sensitivity'),
  sensitivityValue: $('sensitivityValue'),
  threads: $('threads'),

  queueCount: $('queueCount'),
  queueTime: $('queueTime'),
  toast: $('toast'),
}

const STORAGE = {
  draft: 'whisper-notepad.draft.v1',
  settings: 'whisper-notepad.settings.v1',
}

const DEFAULT_SETTINGS = {
  modelPath: '',
  language: 'ru',
  silenceMs: 900,
  sensitivity: 0.55,
  threads: 8,
}

const LANGUAGE_LABEL = {
  ru: 'русский + English',
  en: 'English',
  auto: 'автоопределение',
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function readJson(key) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* приватный режим или переполнение — не критично */
  }
}

function removeStored(key) {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

function plural(count, one, few, many) {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

function formatSeconds(seconds) {
  return seconds.toFixed(1).replace('.', ',')
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = String(Math.floor(total / 60)).padStart(2, '0')
  const rest = String(total % 60).padStart(2, '0')
  return `${minutes}:${rest}`
}

function formatDateTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

const settings = { ...DEFAULT_SETTINGS, ...(readJson(STORAGE.settings) || {}) }

const state = {
  ws: null,
  connected: false,
  reconnectDelay: 800,
  reconnectTimer: null,

  modelState: 'starting',
  modelPath: '',
  modelName: '',
  modelQuantization: '',
  modelError: null,
  loadMs: null,
  threads: settings.threads,
  language: settings.language,

  recording: false,
  starting: false,
  speech: false,
  pending: 0,
  queueAudio: 0,

  epoch: 0,
  startedAt: 0,
  timerId: null,
  startToken: 0,

  audio: null,
  resampler: null,
  acc: new Float32Array(0),
  lastLevelAt: 0,

  levelFrame: null,
  draftTimer: null,
  toastTimer: null,
  settingsSynced: false,
  modelPathDirty: false,
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

function connect() {
  clearTimeout(state.reconnectTimer)

  const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
  const socket = new WebSocket(`${protocol}://${location.host}/ws`)
  state.ws = socket

  setConnection('connecting')

  socket.addEventListener('open', () => {
    state.connected = true
    state.reconnectDelay = 800
    setConnection('ok')
    socket.send(JSON.stringify({ type: 'hello' }))
    renderControls()
    renderState()
  })

  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    handleMessage(message)
  })

  socket.addEventListener('close', () => {
    if (state.ws !== socket) return
    state.connected = false
    state.settingsSynced = false
    setConnection('error')
    if (state.recording) {
      stopRecording(true)
    }
    renderControls()
    renderState()
    state.reconnectTimer = setTimeout(connect, state.reconnectDelay)
    state.reconnectDelay = Math.min(5000, Math.round(state.reconnectDelay * 1.5))
  })

  socket.addEventListener('error', () => {
    try {
      socket.close()
    } catch {
      /* ignore */
    }
  })
}

function setConnection(kind) {
  const labels = {
    connecting: 'Подключение…',
    ok: 'Сервер на связи',
    error: 'Нет связи',
  }
  els.connectionText.textContent = labels[kind] || labels.error
  els.connectionPill.className = `pill ${kind === 'ok' ? 'pill-ok' : kind === 'connecting' ? 'pill-warn' : 'pill-error'}`
}

function send(payload) {
  const socket = state.ws
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

function handleMessage(message) {
  switch (message.type) {
    case 'status':
      applyStatus(message)
      break
    case 'queue':
      state.pending = Number(message.pending) || 0
      state.queueAudio = Number(message.audioSec) || 0
      renderQueue()
      renderState()
      break
    case 'listening':
      if (Number.isFinite(message.epoch)) state.epoch = message.epoch
      renderState()
      break
    case 'speech':
      state.speech = Boolean(message.active)
      renderState()
      break
    case 'result':
      if (message.epoch !== state.epoch) break
      appendText(message.text)
      showLatency(message)
      break
    case 'skipped':
      if (message.epoch !== state.epoch) break
      els.latency.textContent = 'Фраза пропущена: тишина или неразборчиво'
      break
    case 'error':
      toast(message.message || 'Ошибка распознавания', 'error')
      break
    default:
      break
  }
}

function applyStatus(message) {
  state.modelState = message.state || 'starting'
  state.modelError = message.error || null
  state.loadMs = Number.isFinite(message.loadMs) ? message.loadMs : null
  state.threads = Number(message.threads) || state.threads
  state.language = message.language || state.language

  if (message.modelPath) {
    state.modelPath = message.modelPath
    if (!state.modelPathDirty) els.modelPath.value = message.modelPath
  }
  if (message.modelName) state.modelName = message.modelName
  if (message.modelQuantization) state.modelQuantization = message.modelQuantization

  if (!state.settingsSynced) {
    state.settingsSynced = true
    syncSavedSettings(message)
  }

  renderModel()
  renderControls()
  renderState()
}

function syncSavedSettings(status) {
  const saved = settings
  const path = String(saved.modelPath || '').trim()

  const pathDiffers = path && path !== status.modelPath
  const threadsDiffer = Number(saved.threads) !== Number(status.threads)
  const languageDiffers = saved.language !== status.language

  if (pathDiffers || threadsDiffer || languageDiffers) {
    if (path) els.modelPath.value = path
    if (Number.isFinite(Number(saved.threads))) els.threads.value = String(saved.threads)
    if (LANGUAGE_LABEL[saved.language]) els.language.value = saved.language
    loadModel(true)
  }
}

/* ------------------------------------------------------------------ */
/* Модель и элементы управления                                        */
/* ------------------------------------------------------------------ */

function renderModel() {
  const labels = {
    starting: ['Загрузка модели…', 'pill-warn'],
    loading: ['Загрузка модели…', 'pill-warn'],
    ready: ['Модель готова', 'pill-ok'],
    error: ['Ошибка модели', 'pill-error'],
  }
  const [label, cls] = labels[state.modelState] || labels.starting
  els.modelPill.className = `pill ${cls}`
  els.modelPillText.textContent = label

  if (state.modelState === 'ready') {
    const load = state.loadMs ? `за ${(state.loadMs / 1000).toFixed(1)} с · ` : ''
    const model = state.modelName
      ? `${state.modelName}${state.modelQuantization ? ` · ${state.modelQuantization}` : ''} · `
      : ''
    els.modelInfo.className = 'hint ok'
    els.modelInfo.textContent = `${model}${load}${state.threads} ${plural(state.threads, 'поток', 'потока', 'потоков')} · ${LANGUAGE_LABEL[state.language] || state.language}`
  } else if (state.modelState === 'error') {
    els.modelInfo.className = 'hint error'
    els.modelInfo.textContent = state.modelError || 'Не удалось загрузить модель.'
  } else {
    els.modelInfo.className = 'hint'
    els.modelInfo.textContent = 'Загружаю модель в память…'
  }
}

function renderControls() {
  const busy = state.recording || state.starting
  const ready = state.modelState === 'ready'

  els.recordBtn.disabled = !(state.connected && ready) || state.starting
  els.recordBtn.classList.toggle('recording', state.recording)
  els.recordLabel.textContent = state.recording ? 'Стоп' : 'Слушать'

  els.loadModelBtn.disabled = busy || state.modelState === 'loading'
  els.modelPath.disabled = busy
  els.language.disabled = busy
  els.threads.disabled = busy
  els.silence.disabled = busy
  els.sensitivity.disabled = busy
}

function renderState() {
  let text = 'Готова к записи'
  let dot = ''

  if (!state.connected) {
    text = 'Нет связи с сервером'
    dot = 'error'
  } else if (state.modelState === 'error') {
    text = 'Модель не загружена'
    dot = 'error'
  } else if (state.modelState === 'loading' || state.modelState === 'starting') {
    text = 'Загружаю модель…'
    dot = 'busy'
  } else if (state.starting) {
    text = 'Включаю микрофон…'
    dot = 'busy'
  } else if (state.recording) {
    if (state.speech) {
      text = 'Слушаю…'
      dot = 'speech'
    } else if (state.pending > 0) {
      text = 'Жду паузы · распознаю предыдущее'
      dot = 'busy'
    } else {
      text = 'Жду паузы…'
      dot = 'listening'
    }
  } else if (state.pending > 0) {
    text = 'Распознаю…'
    dot = 'busy'
  }

  els.stateText.textContent = text
  els.stateDot.className = `state-dot ${dot}`
}

function renderQueue() {
  if (state.pending <= 0) {
    els.queueCount.textContent = 'Нет фраз'
    els.queueTime.textContent = ''
    return
  }
  els.queueCount.textContent = `${state.pending} ${plural(state.pending, 'фраза', 'фразы', 'фраз')}`
  els.queueTime.textContent = `≈ ${formatSeconds(state.queueAudio)} с речи`
}

/* ------------------------------------------------------------------ */
/* Запись с микрофона                                                  */
/* ------------------------------------------------------------------ */

class LinearResampler {
  constructor(from, to) {
    this.ratio = from / to
    this.buffer = new Float32Array(0)
  }

  process(input) {
    const merged = new Float32Array(this.buffer.length + input.length)
    merged.set(this.buffer)
    merged.set(input, this.buffer.length)

    const length = Math.max(0, Math.floor((merged.length - 1) / this.ratio))
    const output = new Float32Array(length)
    for (let i = 0; i < length; i += 1) {
      const position = i * this.ratio
      const left = Math.floor(position)
      const fraction = position - left
      const a = merged[left]
      const b = left + 1 < merged.length ? merged[left + 1] : a
      output[i] = a + (b - a) * fraction
    }

    const consumed = Math.floor(length * this.ratio)
    this.buffer = merged.slice(consumed)
    return output
  }
}

async function startRecording() {
  if (state.recording || state.starting) return
  if (!state.connected || state.modelState !== 'ready') return

  state.starting = true
  renderControls()
  renderState()

  const token = ++state.startToken
  let stream = null
  let context = null

  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Браузер не умеет захватывать микрофон. Откройте страницу в Chromium.')
    }

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })

    if (token !== state.startToken) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }

    context = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
    if (!context.audioWorklet) {
      throw new Error('AudioWorklet недоступен. Откройте страницу через http://127.0.0.1.')
    }

    await context.audioWorklet.addModule('/pcm-worklet.js')

    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, 'pcm-collector')
    const sink = context.createGain()
    sink.gain.value = 0

    source.connect(node)
    node.connect(sink)
    sink.connect(context.destination)
    node.port.onmessage = (event) => onAudioChunk(event.data)

    await context.resume()

    if (token !== state.startToken) {
      stream.getTracks().forEach((track) => track.stop())
      context.close().catch(() => {})
      return
    }

    state.audio = { stream, context, source, node, sink }
    state.resampler = context.sampleRate === 16000 ? null : new LinearResampler(context.sampleRate, 16000)
    state.acc = new Float32Array(0)
    state.speech = false
    state.epoch += 1

    const started = send({
      type: 'start',
      epoch: state.epoch,
      silenceMs: settings.silenceMs,
      sensitivity: settings.sensitivity,
    })
    if (!started) throw new Error('Соединение с сервером потеряно.')

    state.recording = true
    state.startedAt = Date.now()
    startTimer()
    setLevel(0)
    els.latency.textContent = ''
  } catch (error) {
    if (state.audio) cleanupAudio()
    if (stream) stream.getTracks().forEach((track) => track.stop())
    if (context) context.close().catch(() => {})
    state.recording = false
    toast(microphoneError(error), 'error')
  } finally {
    state.starting = false
    renderControls()
    renderState()
  }
}

function onAudioChunk(buffer) {
  if (!state.recording) return

  const input = new Float32Array(buffer)
  measureLevel(input)

  const samples = state.resampler ? state.resampler.process(input) : input
  if (!samples.length) return

  const merged = new Float32Array(state.acc.length + samples.length)
  merged.set(state.acc)
  merged.set(samples, state.acc.length)

  let offset = 0
  while (merged.length - offset >= 1024) {
    sendPcm(merged.subarray(offset, offset + 1024))
    offset += 1024
  }
  state.acc = merged.slice(offset)
}

function sendPcm(samples) {
  const socket = state.ws
  if (!socket || socket.readyState !== WebSocket.OPEN) return

  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    pcm[i] = clamp(Math.round(samples[i] * 32768), -32768, 32767)
  }
  try {
    socket.send(pcm.buffer)
  } catch {
    /* соединение закрылось между проверкой и отправкой */
  }
}

function stopRecording(silent = false) {
  state.startToken += 1
  const wasActive = state.recording

  state.recording = false
  state.speech = false
  stopTimer()
  setLevel(0)

  if (wasActive) send({ type: 'stop' })

  cleanupAudio()
  renderControls()
  renderState()
}

function cleanupAudio() {
  const audio = state.audio
  state.audio = null
  state.resampler = null
  state.acc = new Float32Array(0)
  if (!audio) return

  try {
    audio.node.port.onmessage = null
    audio.source.disconnect()
    audio.node.disconnect()
    audio.sink.disconnect()
  } catch {
    /* ignore */
  }

  try {
    audio.stream.getTracks().forEach((track) => track.stop())
  } catch {
    /* ignore */
  }

  audio.context.close().catch(() => {})
}

function microphoneError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
    return 'Доступ к микрофону запрещён. Разрешите его в настройках браузера и обновите страницу.'
  }
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') {
    return 'Микрофон не найден. Проверьте, что он подключён и выбран в системе.'
  }
  if (error?.name === 'NotReadableError') {
    return 'Микрофон занят другой программой. Закройте её и попробуйте снова.'
  }
  return error?.message || 'Не удалось включить микрофон.'
}

function measureLevel(samples) {
  const now = performance.now()
  if (now - state.lastLevelAt < 45) return
  state.lastLevelAt = now

  let energy = 0
  for (let i = 0; i < samples.length; i += 1) energy += samples[i] * samples[i]
  const rms = Math.sqrt(energy / samples.length)
  setLevel(Math.min(100, Math.sqrt(rms) * 260))
}

function setLevel(percent) {
  if (state.levelFrame) return
  state.levelFrame = requestAnimationFrame(() => {
    state.levelFrame = null
    els.levelBar.style.width = `${percent.toFixed(1)}%`
  })
}

function startTimer() {
  stopTimer()
  els.timer.textContent = '00:00'
  state.timerId = setInterval(() => {
    els.timer.textContent = formatClock(Date.now() - state.startedAt)
  }, 250)
}

function stopTimer() {
  if (state.timerId) {
    clearInterval(state.timerId)
    state.timerId = null
  }
  els.timer.textContent = '00:00'
}

/* ------------------------------------------------------------------ */
/* Блокнот                                                             */
/* ------------------------------------------------------------------ */

function appendText(text) {
  const clean = String(text || '').trim()
  if (!clean) return

  const field = els.notepad
  const value = field.value
  const focused = document.activeElement === field
  const start = field.selectionStart
  const end = field.selectionEnd

  let separator = ''
  if (value.length > 0 && !/\s$/.test(value)) {
    separator = /[.!?…]["»)]?\s*$/.test(value) ? '\n' : ' '
  }

  const atEnd = !focused || (start === value.length && end === value.length)

  field.value = value + separator + clean

  if (atEnd) {
    field.selectionStart = field.selectionEnd = field.value.length
    field.scrollTop = field.scrollHeight
  } else {
    field.selectionStart = start
    field.selectionEnd = end
  }

  field.classList.remove('flash')
  void field.offsetWidth
  field.classList.add('flash')

  saveDraft()
  updateStats()
}

function showLatency(message) {
  const audio = Number(message.audioSec)
  const wait = Number(message.waitMs)
  if (!Number.isFinite(audio) || !Number.isFinite(wait)) return
  els.latency.textContent = `Фраза ${formatSeconds(audio)} с → текст через ${formatSeconds(wait / 1000)} с`
}

function updateStats() {
  const text = els.notepad.value
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  els.stats.textContent =
    `${words} ${plural(words, 'слово', 'слова', 'слов')} · ` +
    `${text.length} ${plural(text.length, 'символ', 'символа', 'символов')}`
}

function saveDraft() {
  clearTimeout(state.draftTimer)
  state.draftTimer = setTimeout(flushDraft, 300)
}

function flushDraft() {
  clearTimeout(state.draftTimer)
  const text = els.notepad.value
  if (!text.trim()) {
    removeStored(STORAGE.draft)
    els.draftNote.textContent = 'Черновик автоматически сохраняется в браузере.'
    return
  }
  const savedAt = Date.now()
  writeJson(STORAGE.draft, { text, savedAt })
  els.draftNote.textContent = `Черновик сохранён в браузере в ${formatDateTime(savedAt)}.`
}

function restoreDraft() {
  const draft = readJson(STORAGE.draft)
  if (!draft?.text?.trim()) {
    els.draftNote.textContent = 'Черновик автоматически сохраняется в браузере.'
    return
  }
  els.notepad.value = draft.text
  const when = draft.savedAt ? formatDateTime(draft.savedAt) : ''
  els.draftNote.textContent = when
    ? `Восстановлен черновик от ${when}.`
    : 'Восстановлен сохранённый черновик.'
  updateStats()
}

function filenameStamp() {
  const date = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}`
  )
}

function download(extension) {
  const text = els.notepad.value
  if (!text.trim()) {
    toast('Блокнот пуст — нечего сохранять.', 'error')
    return
  }

  const body = text.endsWith('\n') ? text : `${text}\n`
  const type = extension === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8'
  const blob = new Blob([body], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `whisper-notes-${filenameStamp()}.${extension}`
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1500)
  toast(`Файл .${extension} сохраняется.`, 'success')
}

async function copyText() {
  const text = els.notepad.value
  if (!text.trim()) {
    toast('Блокнот пуст.', 'error')
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    toast('Текст скопирован в буфер обмена.', 'success')
  } catch {
    els.notepad.focus()
    els.notepad.select()
    const ok = document.execCommand('copy')
    toast(ok ? 'Текст скопирован.' : 'Не удалось скопировать текст.', ok ? 'success' : 'error')
  }
}

function clearNotepad() {
  if (!els.notepad.value.trim()) return
  if (!window.confirm('Очистить блокнот? Черновик в браузере тоже будет удалён.')) return

  els.notepad.value = ''
  removeStored(STORAGE.draft)
  state.speech = false
  state.epoch += 1
  send({ type: 'reset', epoch: state.epoch })
  updateStats()
  els.latency.textContent = ''
  els.draftNote.textContent = 'Черновик автоматически сохраняется в браузере.'
  toast('Блокнот очищен.', 'success')
}

function toast(message, kind = '') {
  clearTimeout(state.toastTimer)
  els.toast.textContent = message
  els.toast.className = `toast show ${kind}`.trim()
  state.toastTimer = setTimeout(() => {
    els.toast.className = 'toast'
  }, 4500)
}

/* ------------------------------------------------------------------ */
/* Настройки                                                           */
/* ------------------------------------------------------------------ */

function applySettingsToUI() {
  els.language.value = LANGUAGE_LABEL[settings.language] ? settings.language : 'ru'
  els.silence.value = String(clamp(Number(settings.silenceMs) || 900, 400, 2000))
  els.sensitivity.value = String(Math.round(clamp(Number(settings.sensitivity) || 0.55, 0, 1) * 100))
  els.threads.value = String(clamp(Math.round(Number(settings.threads) || 8), 1, 16))
  if (settings.modelPath) els.modelPath.value = settings.modelPath
  updateRangeLabels()
}

function updateRangeLabels() {
  els.silenceValue.textContent = `${formatSeconds(Number(els.silence.value) / 1000)} с`
  els.sensitivityValue.textContent = `${els.sensitivity.value}%`
}

function persistSettings() {
  settings.modelPath = els.modelPath.value.trim() || settings.modelPath
  settings.language = els.language.value
  settings.silenceMs = Number(els.silence.value)
  settings.sensitivity = Number(els.sensitivity.value) / 100
  settings.threads = clamp(Math.round(Number(els.threads.value) || 8), 1, 16)
  writeJson(STORAGE.settings, settings)
}

async function loadModel(silent = false) {
  if (state.recording) stopRecording(true)

  const path = els.modelPath.value.trim()
  if (!path) {
    toast('Укажите путь к папке с моделью Whisper.', 'error')
    return
  }

  const threads = clamp(Math.round(Number(els.threads.value) || 8), 1, 16)
  const language = LANGUAGE_LABEL[els.language.value] ? els.language.value : 'ru'

  state.modelState = 'loading'
  state.modelError = null
  renderModel()
  renderControls()
  renderState()

  try {
    const response = await fetch('/api/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, threads, language }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `Сервер ответил ${response.status}`)
    }

    const resolvedPath = data.status?.modelPath || path
    settings.modelPath = resolvedPath
    settings.threads = threads
    settings.language = language
    state.modelPathDirty = false
    els.modelPath.value = resolvedPath
    writeJson(STORAGE.settings, settings)
    if (!silent) toast('Модель загружается…')
  } catch (error) {
    state.modelState = 'error'
    state.modelError = error.message
    renderModel()
    renderControls()
    renderState()
    toast(error.message, 'error')
  }
}

/* ------------------------------------------------------------------ */
/* События                                                             */
/* ------------------------------------------------------------------ */

els.recordBtn.addEventListener('click', () => {
  if (state.recording) stopRecording()
  else startRecording()
})

els.loadModelBtn.addEventListener('click', () => loadModel())

els.modelPath.addEventListener('input', () => {
  state.modelPathDirty = true
})

els.language.addEventListener('change', () => {
  updateRangeLabels()
  persistSettings()
  loadModel()
})

els.threads.addEventListener('change', () => {
  persistSettings()
  loadModel()
})

els.silence.addEventListener('input', () => {
  updateRangeLabels()
  persistSettings()
})

els.sensitivity.addEventListener('input', () => {
  updateRangeLabels()
  persistSettings()
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.recording) {
    event.preventDefault()
    stopRecording()
  }
})

window.addEventListener('beforeunload', () => {
  flushDraft()
  if (state.recording) send({ type: 'stop' })
})

/* ------------------------------------------------------------------ */
/* Старт                                                               */
/* ------------------------------------------------------------------ */

applySettingsToUI()
restoreDraft()
updateStats()
renderModel()
renderControls()
renderState()
renderQueue()
connect()
