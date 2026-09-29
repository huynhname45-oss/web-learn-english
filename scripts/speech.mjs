// BE/server/local-speech.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync2 } from "node:fs";
import { resolve as resolve2 } from "node:path";

// BE/lib/speech-voices.ts
var SPEECH_VOICES = [
  { id: "en-US-AriaNeural", name: "Aria", locale: "en-US", accent: "M\u1EF9", gender: "N\u1EEF" },
  { id: "en-US-JennyNeural", name: "Jenny", locale: "en-US", accent: "M\u1EF9", gender: "N\u1EEF" },
  { id: "en-US-GuyNeural", name: "Guy", locale: "en-US", accent: "M\u1EF9", gender: "Nam" },
  { id: "en-US-EricNeural", name: "Eric", locale: "en-US", accent: "M\u1EF9", gender: "Nam" },
  { id: "en-GB-SoniaNeural", name: "Sonia", locale: "en-GB", accent: "Anh", gender: "N\u1EEF" },
  { id: "en-GB-RyanNeural", name: "Ryan", locale: "en-GB", accent: "Anh", gender: "Nam" },
  { id: "en-AU-NatashaNeural", name: "Natasha", locale: "en-AU", accent: "\xDAc", gender: "N\u1EEF" },
  { id: "en-AU-WilliamMultilingualNeural", name: "William", locale: "en-AU", accent: "\xDAc", gender: "Nam" }
];
var OFFLINE_SPEECH_VOICES = [
  { id: "local-af-heart", modelVoice: "af_heart", name: "Heart", locale: "en-US", accent: "M\u1EF9", gender: "N\u1EEF" },
  { id: "local-af-bella", modelVoice: "af_bella", name: "Bella", locale: "en-US", accent: "M\u1EF9", gender: "N\u1EEF" },
  { id: "local-am-michael", modelVoice: "am_michael", name: "Michael", locale: "en-US", accent: "M\u1EF9", gender: "Nam" },
  { id: "local-am-fenrir", modelVoice: "am_fenrir", name: "Fenrir", locale: "en-US", accent: "M\u1EF9", gender: "Nam" },
  { id: "local-bf-emma", modelVoice: "bf_emma", name: "Emma", locale: "en-GB", accent: "Anh", gender: "N\u1EEF" },
  { id: "local-bf-isabella", modelVoice: "bf_isabella", name: "Isabella", locale: "en-GB", accent: "Anh", gender: "N\u1EEF" },
  { id: "local-bm-george", modelVoice: "bm_george", name: "George", locale: "en-GB", accent: "Anh", gender: "Nam" },
  { id: "local-bm-fable", modelVoice: "bm_fable", name: "Fable", locale: "en-GB", accent: "Anh", gender: "Nam" }
];
var ALL_SPEECH_VOICES = [...SPEECH_VOICES, ...OFFLINE_SPEECH_VOICES];
var DEFAULT_SPEECH_VOICE = SPEECH_VOICES[0].id;
function isOfflineSpeechVoice(id) {
  return OFFLINE_SPEECH_VOICES.some((voice) => voice.id === id);
}
function validSpeechVoice(id) {
  return id === "windows-auto" || ALL_SPEECH_VOICES.some((v) => v.id === id);
}
function resolveSpeechVoice(id, lang) {
  const selected = ALL_SPEECH_VOICES.find((v) => v.id === id);
  if (id === "windows-auto") return { id, locale: lang ?? "en-US" };
  if (selected) return selected;
  const sameEngine = isOfflineSpeechVoice(id) ? OFFLINE_SPEECH_VOICES : SPEECH_VOICES;
  return sameEngine.find((v) => v.locale === lang) ?? sameEngine[0];
}

// BE/lib/speech-rates.ts
var SPEECH_RATE_OPTIONS = [
  1.5,
  1.25,
  1,
  0.85,
  0.75,
  0.5,
  0.25
];
var DEFAULT_NORMAL_SPEECH_RATE = 1;
var DEFAULT_SLOW_SPEECH_RATE = 0.5;
function validSpeechRate(value) {
  return typeof value === "number" && SPEECH_RATE_OPTIONS.includes(value);
}

// BE/server/offline-speech.ts
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, open, rename } from "node:fs/promises";
import { resolve } from "node:path";
var OFFLINE_SPEECH_ASSETS = [
  {
    name: "kokoro-v1.0.fp16.onnx",
    bytes: 163527961,
    sha256: "f3a290d384fbb27966d462905c71a46cef9e5fd00516b40df32a0b4afe77ac96",
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.fp16.onnx"
  },
  {
    name: "voices-v1.0.bin",
    bytes: 28214398,
    sha256: "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin"
  }
];
var DOWNLOAD_IDLE_MS = 45e3;
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
var OfflineSpeechInstaller = class {
  constructor(directory, assets = OFFLINE_SPEECH_ASSETS) {
    this.directory = directory;
    this.assets = assets;
    this.task = null;
    this.controller = null;
    this.received = 0;
    this.error = "";
    this.verified = false;
    this.verification = null;
    this.ready = false;
  }
  get totalBytes() {
    return this.assets.reduce((sum, item) => sum + item.bytes, 0);
  }
  get modelPath() {
    return resolve(this.directory, this.assets[0].name);
  }
  get voicesPath() {
    return resolve(this.directory, this.assets[1].name);
  }
  sizesMatch() {
    try {
      return this.assets.every((asset) => {
        const path = resolve(this.directory, asset.name);
        return existsSync(path) && statSync(path).size === asset.bytes;
      });
    } catch {
      return false;
    }
  }
  async verify() {
    if (!this.sizesMatch()) {
      this.ready = false;
      this.verified = false;
      return false;
    }
    if (this.verified) return this.ready;
    if (this.verification) return this.verification;
    this.verification = (async () => {
      try {
        this.ready = (await Promise.all(this.assets.map(
          async (asset) => await sha256(resolve(this.directory, asset.name)) === asset.sha256
        ))).every(Boolean);
      } catch {
        this.ready = false;
      }
      this.verified = true;
      return this.ready;
    })().finally(() => {
      this.verification = null;
    });
    return this.verification;
  }
  async status() {
    if (!this.task) await this.verify();
    return {
      installed: this.ready,
      downloading: this.task !== null,
      received: this.ready ? this.totalBytes : this.received,
      total: this.totalBytes,
      percent: this.ready ? 100 : Math.min(99, Math.floor(this.received * 100 / this.totalBytes)),
      error: this.error
    };
  }
  start() {
    if (this.task) return;
    this.error = "";
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.task = (async () => {
      if (await this.verify()) return;
      await this.install(signal);
    })().catch((error) => {
      if (!signal.aborted)
        this.error = error instanceof Error ? error.message : "Kh\xF4ng t\u1EA3i \u0111\u01B0\u1EE3c b\u1ED9 gi\u1ECDng offline.";
    }).finally(() => {
      this.controller = null;
      this.task = null;
    });
  }
  async install(signal) {
    await mkdir(this.directory, { recursive: true });
    this.received = 0;
    for (const asset of this.assets) {
      const target = resolve(this.directory, asset.name);
      if (existsSync(target) && statSync(target).size === asset.bytes && await sha256(target) === asset.sha256) {
        this.received += asset.bytes;
        continue;
      }
      const partial = `${target}.partial`;
      let offset = existsSync(partial) ? statSync(partial).size : 0;
      if (offset === asset.bytes && await sha256(partial) === asset.sha256) {
        await rename(partial, target);
        this.received += asset.bytes;
        continue;
      }
      if (offset < 0 || offset >= asset.bytes) offset = 0;
      const idle = new AbortController();
      let idleTimer;
      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => idle.abort(), DOWNLOAD_IDLE_MS);
        idleTimer.unref();
      };
      resetIdle();
      try {
        const response = await fetch(asset.url, {
          headers: offset ? { Range: `bytes=${offset}-`, "User-Agent": "Atlas-English" } : { "User-Agent": "Atlas-English" },
          redirect: "follow",
          signal: AbortSignal.any([signal, idle.signal])
        });
        if (!response.ok || !response.body)
          throw new Error(`M\xE1y ch\u1EE7 gi\u1ECDng offline tr\u1EA3 v\u1EC1 l\u1ED7i ${response.status}. C\xF3 th\u1EC3 m\u1EDF l\u1EA1i \u0111\u1EC3 ti\u1EBFp t\u1EE5c t\u1EA3i.`);
        const resumed = offset > 0 && response.status === 206;
        if (!resumed) offset = 0;
        this.received += offset;
        const file = await open(partial, resumed ? "a" : "w");
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            resetIdle();
            await file.write(value);
            this.received += value.byteLength;
            if (this.received > this.totalBytes)
              throw new Error("Dung l\u01B0\u1EE3ng b\u1ED9 gi\u1ECDng offline kh\xF4ng h\u1EE3p l\u1EC7.");
          }
        } finally {
          reader.releaseLock();
          await file.close();
        }
      } catch (error) {
        if (idle.signal.aborted && !signal.aborted)
          throw new Error("T\u1EA3i gi\u1ECDng offline b\u1ECB ng\u1EAFt qu\xE1 l\xE2u. B\u1EA5m t\u1EA3i l\u1EA1i \u0111\u1EC3 ti\u1EBFp t\u1EE5c ph\u1EA7n \u0111\xE3 nh\u1EADn.");
        throw error;
      } finally {
        clearTimeout(idleTimer);
      }
      if (statSync(partial).size !== asset.bytes || await sha256(partial) !== asset.sha256)
        throw new Error("B\u1ED9 gi\u1ECDng offline t\u1EA3i ch\u01B0a to\xE0n v\u1EB9n. Atlas gi\u1EEF ph\u1EA7n t\u1EA3i \u0111\u1EC3 th\u1EED l\u1EA1i an to\xE0n.");
      await rename(partial, target);
    }
    this.verified = false;
    if (!await this.verify()) throw new Error("B\u1ED9 gi\u1ECDng offline ch\u01B0a \u0111\u1EA7y \u0111\u1EE7 ho\u1EB7c sai m\xE3 ki\u1EC3m tra.");
  }
  close() {
    this.controller?.abort();
  }
};

// BE/lib/speech-wav.ts
var HEADER_BYTES = 44;
var MAX_AUDIO_BYTES = 24 * 1024 * 1024;
function joinSpeechWavs(chunks) {
  if (!chunks.length) throw new Error("Empty local speech");
  let bytes = 0;
  for (const chunk of chunks) {
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (chunk.length < HEADER_BYTES || String.fromCharCode(...chunk.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...chunk.subarray(8, 16)) !== "WAVEfmt " || String.fromCharCode(...chunk.subarray(36, 40)) !== "data" || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 24e3 || view.getUint32(28, true) !== 48e3 || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 || view.getUint32(4, true) !== chunk.length - 8 || view.getUint32(40, true) !== chunk.length - HEADER_BYTES || (chunk.length - HEADER_BYTES) % 2 !== 0)
      throw new Error("Invalid local speech WAV");
    bytes += chunk.length - HEADER_BYTES;
    if (bytes + HEADER_BYTES > MAX_AUDIO_BYTES)
      throw new Error("Local speech is too large");
  }
  const output = new Uint8Array(HEADER_BYTES + bytes);
  output.set(chunks[0].subarray(0, HEADER_BYTES));
  const header = new DataView(output.buffer);
  header.setUint32(4, output.length - 8, true);
  header.setUint32(40, bytes, true);
  let offset = HEADER_BYTES;
  for (const chunk of chunks) {
    output.set(chunk.subarray(HEADER_BYTES), offset);
    offset += chunk.length - HEADER_BYTES;
  }
  return output;
}

// BE/server/local-speech.ts
var MAX_REQUEST_BYTES = 32e3;
var MAX_AUDIO_BYTES2 = 24 * 1024 * 1024;
var MAX_CACHE_BYTES = 32 * 1024 * 1024;
var SPEECH_TIMEOUT_MS = 24e3;
var NEURAL_WORKER_COUNT = 2;
var SpeechWorkerBusyError = class extends Error {
  constructor() {
    super("Speech worker is busy");
    this.name = "SpeechWorkerBusyError";
  }
};
var NeuralSpeechWorker = class {
  constructor(python, script, offlineOnly = false) {
    this.python = python;
    this.script = script;
    this.offlineOnly = offlineOnly;
    this.child = null;
    this.pending = null;
    this.lineBuffer = "";
    this.sequence = 0;
    this.ready = false;
  }
  get busy() {
    return this.pending !== null;
  }
  warm() {
    this.ensureChild();
  }
  ensureChild() {
    if (this.child && !this.child.killed) return this.child;
    const child = spawn(this.python, [this.script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        ATLAS_OFFLINE_WORKER: this.offlineOnly ? "1" : "0"
      }
    });
    this.child = child;
    this.lineBuffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => this.onStdout(text));
    child.stderr.resume();
    child.stdin.on("error", (error) => {
      if (this.child === child) this.reset(error);
    });
    child.once("error", (error) => {
      if (this.child === child) this.reset(error);
    });
    child.once("close", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      if (this.pending) {
        this.fail(new Error(`Speech worker stopped (${code ?? signal ?? "unknown"}).`));
      }
    });
    return child;
  }
  onStdout(text) {
    this.lineBuffer += text;
    let newline = this.lineBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.lineBuffer.slice(0, newline).trim();
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line) {
        try {
          this.onEvent(JSON.parse(line));
        } catch {
          this.reset(new Error("Speech worker returned malformed data."));
        }
      }
      newline = this.lineBuffer.indexOf("\n");
    }
    if (this.lineBuffer.length > MAX_AUDIO_BYTES2 * 2) {
      this.reset(new Error("Speech worker response is too large."));
    }
  }
  onEvent(event) {
    const pending = this.pending;
    if (!pending || event.id !== pending.id) return;
    if (event.type === "ready" && this.offlineOnly) {
      this.ready = true;
      this.pending = null;
      pending.resolve(Buffer.alloc(0));
      return;
    }
    if (event.type === "chunk" && typeof event.data === "string") {
      let chunk;
      try {
        chunk = Buffer.from(event.data, "base64");
      } catch {
        this.fail(new Error("Speech worker returned invalid audio."));
        return;
      }
      pending.bytes += chunk.length;
      if (pending.bytes > MAX_AUDIO_BYTES2) {
        this.fail(new Error("Speech audio is too large."));
        return;
      }
      pending.chunks.push(chunk);
      pending.onChunk(chunk);
      return;
    }
    if (event.type === "done") {
      const completed = this.pending;
      this.pending = null;
      if (!completed || completed.bytes <= 100) {
        completed?.reject(new Error("Speech worker returned no audio."));
        return;
      }
      try {
        const data = this.offlineOnly ? Buffer.from(joinSpeechWavs(completed.chunks)) : Buffer.concat(completed.chunks);
        if (this.offlineOnly) this.ready = true;
        completed.resolve(data);
      } catch (error) {
        completed.reject(error instanceof Error ? error : new Error("Invalid local speech"));
      }
      return;
    }
    if (event.type === "error") {
      this.fail(new Error(event.message || "Neural speech failed."));
    }
  }
  fail(error) {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }
  request(payload, onChunk, signal) {
    if (signal.aborted) return Promise.reject(new Error("Speech request canceled."));
    if (this.pending) throw new SpeechWorkerBusyError();
    const child = this.ensureChild();
    const id = String(++this.sequence);
    return new Promise((resolveResult, reject) => {
      const pending = {
        id,
        chunks: [],
        bytes: 0,
        onChunk,
        resolve: resolveResult,
        reject
      };
      this.pending = pending;
      const abort = () => {
        signal.removeEventListener("abort", abort);
        this.reset(new Error("Speech request canceled."));
      };
      signal.addEventListener("abort", abort, { once: true });
      const cleanup = () => signal.removeEventListener("abort", abort);
      pending.resolve = (data) => {
        cleanup();
        resolveResult(data);
      };
      pending.reject = (error) => {
        cleanup();
        reject(error);
      };
      try {
        child.stdin.write(JSON.stringify({ ...payload, id }) + "\n");
      } catch (error) {
        cleanup();
        this.reset(error instanceof Error ? error : new Error("Speech worker unavailable."));
      }
    });
  }
  reset(error = new Error("Speech worker reset.")) {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.lineBuffer = "";
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
    if (child && !child.killed) child.kill();
  }
  close() {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.lineBuffer = "";
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new Error("Speech worker closed."));
    if (child && !child.killed) child.kill();
  }
};
function localSpeech() {
  return {
    name: "atlas-local-speech",
    apply: "serve",
    configureServer(server) {
      const speech = createSpeechMiddleware(server.config.root);
      server.middlewares.use("/__atlas/speech", speech);
      server.httpServer?.once("close", speech.close);
    }
  };
}
function createSpeechMiddleware(root, pythonPath, neuralScriptPath = resolve2(root, "BE/scripts/synthesize-neural.py"), offlineModelDirectory = process.env.ATLAS_SPEECH_HOME ?? resolve2(
  process.env.ATLAS_DEV_HOME ?? process.env.LOCALAPPDATA ?? root,
  process.env.ATLAS_DEV_HOME ? "speech-models" : "AtlasEnglish-Dev/speech-models"
), offlineAssets) {
  const cache = /* @__PURE__ */ new Map();
  const neuralJobs = /* @__PURE__ */ new Map();
  const localJobs = /* @__PURE__ */ new Map();
  let cacheBytes = 0;
  let active = 0;
  const neuralPython = pythonPath ?? resolve2(root, ".venv-speech", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const neuralWorkers = Array.from(
    { length: NEURAL_WORKER_COUNT },
    () => new NeuralSpeechWorker(neuralPython, neuralScriptPath)
  );
  const localWorker = new NeuralSpeechWorker(neuralPython, neuralScriptPath, true);
  const offlineInstaller = new OfflineSpeechInstaller(offlineModelDirectory, offlineAssets);
  let localWarmup = null;
  let closed = false;
  const warmLocal = () => {
    if (localWarmup) return localWarmup;
    if (closed || localWorker.ready || localWorker.busy || !existsSync2(neuralPython))
      return Promise.resolve();
    localWarmup = (async () => {
      if (!await offlineInstaller.verify() || closed || localWorker.busy) return;
      await localWorker.request(
        {
          warmup: true,
          model_path: offlineInstaller.modelPath,
          voices_path: offlineInstaller.voicesPath
        },
        () => {
        },
        AbortSignal.timeout(3e4)
      );
    })().finally(() => {
      localWarmup = null;
    });
    return localWarmup;
  };
  const warmTimer = existsSync2(neuralPython) ? setTimeout(() => neuralWorkers.forEach((worker) => worker.warm()), 500) : void 0;
  warmTimer?.unref();
  const remember = (key, data) => {
    const old = cache.get(key);
    if (old) cacheBytes -= old.length;
    cache.delete(key);
    cache.set(key, data);
    cacheBytes += data.length;
    while (cacheBytes > MAX_CACHE_BYTES && cache.size) {
      const oldest = cache.keys().next().value;
      if (oldest === void 0) break;
      const removed = cache.get(oldest);
      if (removed) cacheBytes -= removed.length;
      cache.delete(oldest);
    }
  };
  const neuralJob = (payload, local = false, speculative = false) => {
    const jobs = local ? localJobs : neuralJobs;
    const existing = jobs.get(payload);
    if (existing) {
      if (!speculative) existing.speculative = false;
      return existing;
    }
    const worker = local ? localWorker.busy ? void 0 : localWorker : neuralWorkers.find((candidate) => !candidate.busy);
    if (!worker) throw new SpeechWorkerBusyError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), local ? 6e4 : SPEECH_TIMEOUT_MS);
    const job = {
      chunks: [],
      listeners: /* @__PURE__ */ new Set(),
      controller,
      promise: Promise.resolve(Buffer.alloc(0)),
      settled: false,
      speculative
    };
    jobs.set(payload, job);
    try {
      const request = JSON.parse(payload);
      if (local) {
        request.model_path = offlineInstaller.modelPath;
        request.voices_path = offlineInstaller.voicesPath;
      }
      job.promise = worker.request(
        request,
        (chunk) => {
          job.chunks.push(chunk);
          job.listeners.forEach((listener) => listener(chunk));
        },
        controller.signal
      ).then((data) => {
        const valid = data.length > 100 && (local ? data.toString("ascii", 0, 4) === "RIFF" : data[0] === 255 || data.toString("ascii", 0, 3) === "ID3");
        if (!valid) throw new Error("Invalid speech audio.");
        remember(payload, data);
        return data;
      }).finally(() => {
        job.settled = true;
        if (job.cancelTimer) clearTimeout(job.cancelTimer);
        clearTimeout(timer);
        if (jobs.get(payload) === job) jobs.delete(payload);
      });
    } catch (error) {
      clearTimeout(timer);
      jobs.delete(payload);
      throw error;
    }
    return job;
  };
  const middleware = (async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
      res.writeHead(403).end();
      return;
    }
    const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
    if (pathname.endsWith("/offline")) {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(await offlineInstaller.status()));
        return;
      }
      if (req.method === "POST") {
        offlineInstaller.start();
        res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify(await offlineInstaller.status()));
        return;
      }
      res.writeHead(405).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    try {
      for await (const chunk of req) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) {
          res.writeHead(413).end();
          return;
        }
      }
      const input = JSON.parse(raw);
      if (pathname.endsWith("/warm")) {
        if (!isOfflineSpeechVoice(input.voice)) {
          res.writeHead(400).end();
          return;
        }
        if (!await offlineInstaller.verify()) {
          res.writeHead(424, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "offline-voices-not-installed" }));
          return;
        }
        void warmLocal().catch(() => {
        });
        res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ installed: true, ready: localWorker.ready }));
        return;
      }
      const rate = typeof input.rate === "number" ? input.rate : input.slow === true ? DEFAULT_SLOW_SPEECH_RATE : input.slow === false ? DEFAULT_NORMAL_SPEECH_RATE : Number.NaN;
      if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 6e3 || !["en-US", "en-GB", "en-AU"].includes(input.lang) || !validSpeechRate(rate) || input.voice !== void 0 && !validSpeechVoice(input.voice)) {
        res.writeHead(400).end();
        return;
      }
      const voice = resolveSpeechVoice(input.voice ?? DEFAULT_SPEECH_VOICE, input.lang);
      const windowsVoice = voice.id === "windows-auto";
      const localVoice = isOfflineSpeechVoice(voice.id);
      const payload = JSON.stringify({
        text: input.text.replace(/\s+/g, " ").trim(),
        lang: voice.locale,
        rate,
        voice: voice.id
      });
      const headers = { "Content-Type": windowsVoice || localVoice ? "audio/wav" : "audio/mpeg", "X-Atlas-Voice": voice.id };
      const cached = cache.get(payload);
      if (cached) {
        cache.delete(payload);
        cache.set(payload, cached);
        res.writeHead(200, headers).end(cached);
        return;
      }
      if (!windowsVoice && !existsSync2(neuralPython) || windowsVoice && process.platform !== "win32") {
        res.writeHead(503).end();
        return;
      }
      if (localVoice && !await offlineInstaller.verify()) {
        res.writeHead(424, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "offline-voices-not-installed" }));
        return;
      }
      if (!windowsVoice) {
        let job;
        const speculative = req.headers["x-atlas-speech-priority"] === "low";
        try {
          if (localVoice) {
            if (localWarmup) await localWarmup;
            if (!speculative && !localJobs.has(payload)) {
              for (const waiting of localJobs.values()) {
                if (!waiting.speculative) continue;
                if (waiting.cancelTimer) clearTimeout(waiting.cancelTimer);
                waiting.cancelTimer = void 0;
                await waiting.promise.catch(() => {
                });
              }
            }
            if (closed || res.destroyed || res.writableEnded) return;
          }
          job = neuralJob(payload, localVoice, speculative);
        } catch (error) {
          if (error instanceof SpeechWorkerBusyError) res.writeHead(429).end();
          else res.writeHead(503).end();
          return;
        }
        let headersSent = false;
        const streamingLocal = localVoice && input.stream === true;
        const responseHeaders = streamingLocal ? { ...headers, "Content-Type": "audio/x-atlas-wav-stream" } : headers;
        const sendChunk = (chunk) => {
          if (res.writableEnded || res.destroyed) return;
          if (localVoice && !streamingLocal) return;
          if (!headersSent) {
            res.writeHead(200, responseHeaders);
            res.flushHeaders();
            headersSent = true;
          }
          if (streamingLocal) {
            const frame = Buffer.allocUnsafe(4);
            frame.writeUInt32LE(chunk.length);
            res.write(frame);
          }
          res.write(chunk);
        };
        if (job.cancelTimer) {
          clearTimeout(job.cancelTimer);
          job.cancelTimer = void 0;
        }
        job.listeners.add(sendChunk);
        job.chunks.forEach(sendChunk);
        const unsubscribe = () => {
          job.listeners.delete(sendChunk);
          if (!job.listeners.size && !job.settled && !job.cancelTimer) {
            job.cancelTimer = setTimeout(() => {
              job.cancelTimer = void 0;
              if (!job.listeners.size && !job.settled)
                job.controller.abort();
            }, 750);
            job.cancelTimer.unref();
          }
        };
        res.once("close", unsubscribe);
        try {
          const data = await job.promise;
          if (res.writableEnded || res.destroyed) return;
          if (!headersSent) res.writeHead(200, headers).end(data);
          else res.end();
        } catch {
          if (res.writableEnded || res.destroyed) return;
          if (headersSent) res.destroy();
          else res.writeHead(503).end();
        } finally {
          unsubscribe();
          res.off("close", unsubscribe);
        }
        return;
      }
      if (active >= 3) {
        res.writeHead(429).end();
        return;
      }
      active++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SPEECH_TIMEOUT_MS);
      const cancel = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", cancel);
      try {
        const child = spawn(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve2(root, "BE/scripts/synthesize-speech.ps1")],
          { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
        );
        const childChunks = [];
        let bytes = 0;
        const childPromise = new Promise((resolveResult, reject) => {
          child.stdout.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > MAX_AUDIO_BYTES2) child.kill();
            else childChunks.push(chunk);
          });
          child.stderr.resume();
          child.once("error", reject);
          child.once("close", (code) => {
            const output = Buffer.from(Buffer.concat(childChunks).toString().trim(), "base64");
            if (code !== 0 || output.toString("ascii", 0, 4) !== "RIFF") reject(new Error("Windows speech failed."));
            else resolveResult(output);
          });
        });
        const abort = () => child.kill();
        controller.signal.addEventListener("abort", abort, { once: true });
        child.stdin.on("error", () => {
        });
        child.stdin.end(payload, "utf8");
        const data = await childPromise;
        controller.signal.removeEventListener("abort", abort);
        if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
        const valid = data.toString("ascii", 0, 4) === "RIFF";
        if (!valid) throw new Error("Invalid speech audio.");
        remember(payload, data);
        res.writeHead(200, headers).end(data);
      } catch (error) {
        if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
        if (error instanceof SpeechWorkerBusyError) res.writeHead(429).end();
        else res.writeHead(503).end();
      } finally {
        clearTimeout(timer);
        active--;
        res.off("close", cancel);
      }
    } catch {
      if (!res.writableEnded) res.writeHead(400).end();
    }
  });
  middleware.close = () => {
    closed = true;
    if (warmTimer) clearTimeout(warmTimer);
    neuralJobs.forEach((job) => {
      if (job.cancelTimer) clearTimeout(job.cancelTimer);
      job.controller.abort();
    });
    localJobs.forEach((job) => {
      if (job.cancelTimer) clearTimeout(job.cancelTimer);
      job.controller.abort();
    });
    neuralJobs.clear();
    localJobs.clear();
    neuralWorkers.forEach((worker) => worker.close());
    localWorker.close();
    offlineInstaller.close();
  };
  return middleware;
}
export {
  createSpeechMiddleware,
  localSpeech
};
