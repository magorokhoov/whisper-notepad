EN / RU

Russian is below

# Whisper Notepad

A minimal local dictation notepad: speak, pause, and the text appears in an editable
notepad. Speech recognition runs on the CPU with Whisper via
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). Russian with English terms is
supported out of the box.

> **Note:** all code and documentation were produced by an AI assistant. The owner
> simply wanted a simple dictation notepad that turns speech into text after natural
> pauses.

## Features

- Automatic silence detection: each phrase is recognized when you pause.
- Editable notepad with `.txt` / `.md` export and draft autosave.
- Russian + English by default; English and auto-detect are also available.
- Any sherpa-onnx Whisper model: `small`, `medium`, `large`, int8 or fp32.
- Fully offline: audio never leaves the machine.
- Simple browser UI; no Electron, no installers, no cloud.

## Requirements

- Node.js 20.11+ (22 LTS recommended).
- Linux x64 or Windows x64.
- Chrome, Chromium, or Edge with microphone access.
- A Whisper model in sherpa-onnx format (downloaded separately).
- About 2 GB of RAM for `medium`.

## Install

### Linux

```bash
git clone https://github.com/magorokhoov/whisper-notepad.git
cd whisper-notepad
npm install
./start.sh
```

Or run `npm start`; the browser opens at <http://127.0.0.1:8765>.

### Windows

Install [Node.js](https://nodejs.org/) 20.11+, then in Command Prompt:

```cmd
git clone https://github.com/magorokhoov/whisper-notepad.git
cd whisper-notepad
npm install
start.cmd
```

`npm start` works too. If the browser does not open, visit
<http://127.0.0.1:8765>.

## Model

Download one of these model folders:

- small, ~375 MB: <https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small>
- medium, ~903 MB: <https://huggingface.co/csukuangfj/sherpa-onnx-whisper-medium>

Put the folder into `models/medium` inside the project, or paste any absolute path
into the **Model** panel in the UI and press **Load model**. File names with prefixes
are supported, so `small-encoder.int8.onnx`, `small-decoder.int8.onnx`, and
`small-tokens.txt` can be used as-is. The model is not included in this repository.

## Use

1. Wait for **Model ready**.
2. Press **Listen** and allow microphone access.
3. Speak; after a pause (0.9 s by default) the phrase is added to the notepad.
4. Press **Stop** or `Esc` to finish.
5. Edit the text and save it as `.txt` or `.md`.

Whisper Medium on CPU takes roughly 1.5 seconds per second of speech, so expect
8–10 seconds for a short phrase. `small` is about 3× faster; `large` is slower and
needs more RAM. The draft is stored in the browser's `localStorage`.

The server listens only on `127.0.0.1` and has no authentication; do not expose the
port to the network.

## License

MIT — see [LICENSE](LICENSE). Third-party components are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

# Whisper-блокнот

Минимальная локальная надиктовка: говорите, делаете паузу — текст появляется в
редактируемом блокноте. Распознавание идёт на CPU через Whisper и
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). Русская речь с английскими
терминами поддерживается сразу.

> **Примечание:** весь код и документация созданы нейросетью. Владелец лишь хотел
> простую программу-блокнот для надиктовки, которая сама превращает речь в текст
> после естественных пауз.

## Возможности

- Автоматическое определение тишины: фраза распознаётся после паузы.
- Редактируемый блокнот, сохранение в `.txt` / `.md`, автосохранение черновика.
- По умолчанию русский + английский; есть английский и автоопределение.
- Любая модель sherpa-onnx Whisper: `small`, `medium`, `large`, int8 или fp32.
- Полностью офлайн: аудио не покидает компьютер.
- Простой интерфейс в браузере; без Electron, установщиков и облака.

## Что нужно

- Node.js 20.11+ (рекомендуется 22 LTS).
- Linux x64 или Windows x64.
- Chrome, Chromium или Edge с доступом к микрофону.
- Модель Whisper в формате sherpa-onnx (скачивается отдельно).
- Около 2 ГБ ОЗУ для `medium`.

## Установка

### Linux

```bash
git clone https://github.com/magorokhoov/whisper-notepad.git
cd whisper-notepad
npm install
./start.sh
```

Или `npm start`; браузер откроется на <http://127.0.0.1:8765>.

### Windows

Установите [Node.js](https://nodejs.org/) 20.11+, затем в командной строке:

```cmd
git clone https://github.com/magorokhoov/whisper-notepad.git
cd whisper-notepad
npm install
start.cmd
```

Можно и просто `npm start`. Если браузер не открылся, зайдите на
<http://127.0.0.1:8765>.

## Модель

Скачайте одну из папок:

- small, ~375 МБ: <https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small>
- medium, ~903 МБ: <https://huggingface.co/csukuangfj/sherpa-onnx-whisper-medium>

Положите папку в `models/medium` внутри проекта или вставьте абсолютный путь в
панель **«Модель»** и нажмите **«Загрузить модель»**. Имена файлов с префиксами
поддерживаются: `small-encoder.int8.onnx`, `small-decoder.int8.onnx` и
`small-tokens.txt` можно использовать как есть. Модель в репозиторий не входит.

## Как пользоваться

1. Дождитесь статуса **«Модель готова»**.
2. Нажмите **«Слушать»** и разрешите доступ к микрофону.
3. Говорите; после паузы (по умолчанию 0,9 с) фраза появится в блокноте.
4. Нажмите **«Стоп»** или `Esc`, чтобы закончить.
5. Редактируйте текст и сохраняйте в `.txt` или `.md`.

Whisper Medium на CPU тратит примерно 1,5 секунды на секунду речи: короткая фраза
занимает 8–10 секунд. `small` примерно в 3 раза быстрее; `large` медленнее и
требует больше ОЗУ. Черновик хранится в `localStorage` браузера.

Сервер слушает только `127.0.0.1` и не имеет аутентификации — не открывайте порт
наружу.

## Лицензия

MIT — см. [LICENSE](LICENSE). Сторонние компоненты перечислены в
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
