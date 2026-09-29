"""Long-lived neural speech worker.

The parent process sends one JSON request per line. Audio is returned as
base64-encoded JSON-line chunks so the parent can stream it to the browser
without spawning Python for every utterance.
"""
import asyncio
import base64
import io
import json
import os
import socket
import sys
import wave
import edge_tts

os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("ORT_LOG_SEVERITY_LEVEL", "3")

OFFLINE_ONLY = os.environ.get("ATLAS_OFFLINE_WORKER") == "1"
if OFFLINE_ONLY:
    _socket_connect = socket.socket.connect
    _socket_connect_ex = socket.socket.connect_ex
    _socket_getaddrinfo = socket.getaddrinfo

    def require_loopback(address):
        host = address[0] if isinstance(address, tuple) else address
        if host not in ("127.0.0.1", "::1", "localhost"):
            raise RuntimeError("The local voice worker cannot use the Internet")

    def local_connect(connection, address):
        require_loopback(address)
        return _socket_connect(connection, address)

    def local_connect_ex(connection, address):
        require_loopback(address)
        return _socket_connect_ex(connection, address)

    def local_getaddrinfo(host, *args, **kwargs):
        require_loopback((host,))
        return _socket_getaddrinfo(host, *args, **kwargs)

    # Windows asyncio uses loopback sockets internally; never permit remote
    # connections or DNS while preserving its local event-loop wakeup.
    socket.socket.connect = local_connect
    socket.socket.connect_ex = local_connect_ex
    socket.getaddrinfo = local_getaddrinfo

LOCAL_VOICES = {
    "local-af-heart": "af_heart",
    "local-af-bella": "af_bella",
    "local-am-michael": "am_michael",
    "local-am-fenrir": "am_fenrir",
    "local-bf-emma": "bf_emma",
    "local-bf-isabella": "bf_isabella",
    "local-bm-george": "bm_george",
    "local-bm-fable": "bm_fable",
}
_kokoro = None
_kokoro_paths = None
_local_warmed = False

def rate_percent(rate):
    percent = round((float(rate) - 1) * 100)
    return f"{percent:+d}%"

def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def wav_bytes(samples, sample_rate):
    import numpy as np
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    return output.getvalue()


def load_local_model(data):
    global _kokoro, _kokoro_paths, _local_warmed
    from kokoro_onnx import Kokoro
    import onnxruntime as ort

    paths = (data["model_path"], data["voices_path"])
    if _kokoro is None or _kokoro_paths != paths:
        options = ort.SessionOptions()
        options.intra_op_num_threads = min(4, max(1, os.cpu_count() or 1))
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        session = ort.InferenceSession(
            paths[0], sess_options=options, providers=["CPUExecutionProvider"]
        )
        _kokoro = Kokoro.from_session(session, paths[1])
        _kokoro_paths = paths
        _local_warmed = False
    return _kokoro


def warm_local_model(data):
    global _local_warmed
    model = load_local_model(data)
    if not _local_warmed:
        # Exercise inference and both phonemizers once without playing audio.
        model.create("Ready.", voice="am_fenrir", lang="en-us")
        model.tokenizer.phonemize("Ready.", "en-gb")
        _local_warmed = True


def local_speech_chunks(data):
    from kokoro_onnx.chunker import pause_after, split_phonemes
    model = load_local_model(data)
    voice = LOCAL_VOICES[data["voice"]]
    language = "en-gb" if voice.startswith(("bf_", "bm_")) else "en-us"
    speed = float(data.get("rate", 1))
    phonemes = " ".join(model.tokenizer.phonemize(data["text"], language).split())
    batches = split_phonemes(phonemes, 100)
    if not batches:
        raise RuntimeError("No local speech audio returned")
    style = model.get_voice_style(voice)
    for index, batch in enumerate(batches):
        # Native phoneme duration also supports 0.25x; never slow a fast WAV.
        pause = pause_after(batch, 0.25, 0.1) if index < len(batches) - 1 else 0.0
        samples, _ = model._create_batch(
            batch, style, speed, trim=True, pause=pause
        )
        yield wav_bytes(samples, 24000)


def emit_local_speech(data, request_id):
    for audio in local_speech_chunks(data):
        emit({
            "id": request_id,
            "type": "chunk",
            "data": base64.b64encode(audio).decode("ascii"),
        })


async def synthesize(data):
    request_id = str(data.get("id", ""))
    try:
        if data.get("warmup"):
            await asyncio.to_thread(warm_local_model, data)
            emit({"id": request_id, "type": "ready"})
            return
        if OFFLINE_ONLY and data.get("voice") not in LOCAL_VOICES:
            raise ValueError("Only local voices are allowed in the offline worker")
        if data.get("list"):
            voices = await edge_tts.list_voices()
            emit({"id": request_id, "type": "voices", "voices": [v["ShortName"] for v in voices]})
            return
        voice = data["voice"]
        if voice in LOCAL_VOICES:
            await asyncio.to_thread(emit_local_speech, data, request_id)
            emit({"id": request_id, "type": "done"})
            return
        if not voice.startswith(("en-US-", "en-GB-", "en-AU-")):
            raise ValueError("Unsupported voice")
        # A fresh Communicate instance preserves coarticulation and sentence
        # prosody. The Python process itself remains warm between jobs.
        speech = edge_tts.Communicate(
            data["text"],
            voice,
            rate=rate_percent(data.get("rate", 1)),
        )
        emitted = False
        async for chunk in speech.stream():
            if chunk["type"] == "audio":
                emitted = True
                emit({
                    "id": request_id,
                    "type": "chunk",
                    "data": base64.b64encode(chunk["data"]).decode("ascii"),
                })
        if not emitted:
            raise RuntimeError("No speech audio returned")
        emit({"id": request_id, "type": "done"})
    except Exception as error:
        emit({"id": request_id, "type": "error", "message": str(error)[:500]})


async def main():
    while True:
        line = await asyncio.to_thread(sys.stdin.buffer.readline)
        if not line:
            return
        try:
            data = json.loads(line.decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("Invalid request")
            await synthesize(data)
        except Exception as error:
            emit({"id": "", "type": "error", "message": str(error)[:500]})

if __name__ == "__main__":
    asyncio.run(main())
