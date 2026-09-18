// server/local-speech.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// lib/speech-voices.ts
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
var DEFAULT_SPEECH_VOICE = SPEECH_VOICES[0].id;
function validSpeechVoice(id) {
  return id === "windows-auto" || SPEECH_VOICES.some((v) => v.id === id);
}
function resolveSpeechVoice(id, lang) {
  const selected = SPEECH_VOICES.find((v) => v.id === id);
  if (id === "windows-auto") return { id, locale: lang ?? "en-US" };
  if (selected && (!lang || selected.locale === lang)) return selected;
  return SPEECH_VOICES.find((v) => v.locale === lang) ?? SPEECH_VOICES[0];
}

// lib/speech-rates.ts
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

// server/local-speech.ts
function localSpeech() {
  return {
    name: "atlas-local-speech",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__atlas/speech", createSpeechMiddleware(server.config.root));
    }
  };
}
function createSpeechMiddleware(root, pythonPath) {
  const cache = /* @__PURE__ */ new Map();
  let cacheBytes = 0, active = 0;
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
      res.writeHead(403).end();
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    try {
      for await (const chunk of req) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 32e3) {
          res.writeHead(413).end();
          return;
        }
      }
      const input = JSON.parse(raw);
      const rate = typeof input.rate === "number" ? input.rate : input.slow === true ? DEFAULT_SLOW_SPEECH_RATE : input.slow === false ? DEFAULT_NORMAL_SPEECH_RATE : Number.NaN;
      if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 6e3 || !["en-US", "en-GB", "en-AU"].includes(input.lang) || !validSpeechRate(rate) || input.voice !== void 0 && !validSpeechVoice(input.voice)) {
        res.writeHead(400).end();
        return;
      }
      const voice = resolveSpeechVoice(input.voice ?? DEFAULT_SPEECH_VOICE, input.lang);
      const offline = voice.id === "windows-auto";
      const payload = JSON.stringify({ text: input.text.replace(/\s+/g, " ").trim(), lang: voice.locale, rate, voice: voice.id });
      const headers = { "Content-Type": offline ? "audio/wav" : "audio/mpeg", "X-Atlas-Voice": voice.id };
      const cached = cache.get(payload);
      if (cached) {
        res.writeHead(200, headers).end(cached);
        return;
      }
      if (active >= 3) {
        res.writeHead(429).end();
        return;
      }
      const python = pythonPath ?? resolve(root, ".venv-speech", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
      if (!offline && !existsSync(python) || offline && process.platform !== "win32") {
        res.writeHead(503).end();
        return;
      }
      active++;
      const child = offline ? spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve(root, "scripts/synthesize-speech.ps1")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }) : spawn(python, [resolve(root, "scripts/synthesize-neural.py")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => child.kill(), 24e3);
      const cancel = () => {
        if (!res.writableEnded) child.kill();
      };
      res.once("close", cancel);
      const chunks = [];
      let bytes = 0;
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 24 * 1024 * 1024) child.kill();
        else {
          chunks.push(chunk);
          if (!offline && !res.writableEnded) {
            if (!res.headersSent) {
              res.writeHead(200, headers);
              res.flushHeaders();
            }
            res.write(chunk);
          }
        }
      });
      child.stderr.resume();
      child.stdin.on("error", () => {
      });
      child.once("error", () => {
        if (!res.writableEnded) {
          if (res.headersSent) res.destroy();
          else res.writeHead(503).end();
        }
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        active--;
        res.off("close", cancel);
        if (res.destroyed || res.writableEnded) return;
        const output = Buffer.concat(chunks);
        const data = offline ? Buffer.from(output.toString().trim(), "base64") : output;
        const valid = offline ? data.toString("ascii", 0, 4) === "RIFF" : data.length > 100 && (data[0] === 255 || data.toString("ascii", 0, 3) === "ID3");
        if (code !== 0 || !valid) {
          if (res.headersSent) res.destroy();
          else res.writeHead(503).end();
          return;
        }
        while (cacheBytes + data.length > 32 * 1024 * 1024 && cache.size) {
          const key = cache.keys().next().value;
          cacheBytes -= cache.get(key).length;
          cache.delete(key);
        }
        if (data.length <= 32 * 1024 * 1024) {
          cache.set(payload, data);
          cacheBytes += data.length;
        }
        if (offline) res.writeHead(200, headers).end(data);
        else res.end();
      });
      child.stdin.end(payload, "utf8");
    } catch {
      if (!res.writableEnded) res.writeHead(400).end();
    }
  };
}
export {
  createSpeechMiddleware,
  localSpeech
};
