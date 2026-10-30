# Third-party notices

Whisper Notepad is MIT-licensed. It uses the following third-party components at
runtime. None of them are vendored into this repository; `npm install` downloads
the JavaScript packages, and the model is downloaded separately by the user.

## sherpa-onnx / sherpa-onnx-node

- Project: https://github.com/k2-fsa/sherpa-onnx
- License: Apache License 2.0
- Used as: speech recognition runtime and Node.js binding
  (`sherpa-onnx-node` 1.13.8 and the matching platform package, e.g.
  `sherpa-onnx-linux-x64`).

The platform packages contain compiled binaries: `sherpa-onnx.node`,
`libsherpa-onnx-c-api.so`, `libsherpa-onnx-cxx-api.so` and `libonnxruntime.so`.
If you redistribute a built application that includes those binaries, keep the
Apache-2.0 license and notices that come with the packages.

## ONNX Runtime

- Project: https://github.com/microsoft/onnxruntime
- License: MIT
- Used as: inference engine inside the sherpa-onnx platform package
  (`libonnxruntime.so`, CPU build).

## ws

- Project: https://github.com/websockets/ws
- License: MIT
- Used as: WebSocket server in `server.mjs`.

## Whisper Medium model

- Original model: https://github.com/openai/whisper
- Weights license: MIT (OpenAI Whisper)
- ONNX conversion used here: https://huggingface.co/csukuangfj/sherpa-onnx-whisper-medium
- Used as: int8 encoder/decoder (`encoder.int8.onnx`, `decoder.int8.onnx`) and
  `tokens.txt`.

The model is **not** included in this repository; download it from Hugging Face.
Check the model card and the laws of your jurisdiction before redistributing
the weights.

## Node.js

- Project: https://nodejs.org/
- License: MIT
- Used as: runtime. Not bundled.
