$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$speaker = [System.Speech.Synthesis.SpeechSynthesizer]::new()
$stream = [System.IO.MemoryStream]::new()
try {
    $voice = $speaker.GetInstalledVoices() | Where-Object {
        $_.Enabled -and $_.VoiceInfo.Culture.Name -eq $request.lang
    } | Select-Object -First 1
    if (-not $voice) { throw 'Requested voice is not installed.' }
    $speaker.SelectVoice($voice.VoiceInfo.Name)
    $rate = if ($null -ne $request.rate) {
        [double]$request.rate
    } elseif ($request.slow) {
        0.5
    } else {
        1.0
    }
    $speaker.Rate = if ($rate -ge 1.5) { 5 } elseif ($rate -ge 1.25) { 2 } elseif ($rate -ge 1) { 0 } elseif ($rate -ge 0.85) { -2 } elseif ($rate -ge 0.75) { -3 } elseif ($rate -ge 0.5) { -5 } else { -8 }
    $speaker.SetOutputToWaveStream($stream)
    $speaker.Speak([string]$request.text)
    $speaker.SetOutputToNull()
    [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
} finally {
    $speaker.Dispose()
    $stream.Dispose()
}
