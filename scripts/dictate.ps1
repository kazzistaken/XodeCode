# Dictation for XodeCode.
#
# Prefers the modern Windows speech engine (Windows.Media.SpeechRecognition,
# the one behind Windows voice typing): far more accurate, adds punctuation,
# and handles natural speech. It needs "Online speech recognition" turned on
# in Windows Settings > Privacy > Speech. If that engine is unavailable, it
# falls back to the classic offline engine (System.Speech), listening
# continuously so no words are lost between phrases.
#
# Prints READY once listening, then one recognised phrase per line. The parent
# process kills this when dictation stops. Must run in Windows PowerShell 5.1
# (powershell.exe), which can call WinRT.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Emit([string]$text) {
  $clean = ($text -replace '\s+', ' ').Trim()
  if ($clean) {
    [Console]::Out.WriteLine($clean)
    [Console]::Out.Flush()
  }
}

# ---------------------------------------------------------------- WinRT --

function Start-WinRtDictation {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.SpeechRecognition.SpeechRecognizer, Windows.Media.SpeechRecognition, ContentType = WindowsRuntime]

  $asTaskGeneric = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } |
    Select-Object -First 1

  function Await($operation, [Type]$resultType) {
    $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($operation))
    $null = $task.Wait(-1)
    return $task.Result
  }

  # With no constraints added the recogniser uses its built-in dictation grammar
  # (Constraints.Add cannot be called from PowerShell 5.1 on a WinRT vector).
  $recognizer = New-Object Windows.Media.SpeechRecognition.SpeechRecognizer

  $compiled = Await ($recognizer.CompileConstraintsAsync()) ([Windows.Media.SpeechRecognition.SpeechRecognitionCompilationResult])
  if ($compiled.Status -ne [Windows.Media.SpeechRecognition.SpeechRecognitionResultStatus]::Success) {
    throw "WinRT dictation unavailable: $($compiled.Status)"
  }

  # Wait patiently for speech to start; end a phrase after a short natural pause.
  $recognizer.Timeouts.InitialSilenceTimeout = [TimeSpan]::FromSeconds(60)
  $recognizer.Timeouts.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(800)
  $recognizer.Timeouts.BabbleTimeout = [TimeSpan]::FromSeconds(0)

  # The first recognition proves the engine (and the privacy setting) works.
  # Run it before announcing READY so a failure falls back cleanly.
  $resultType = [Windows.Media.SpeechRecognition.SpeechRecognitionResult]
  $first = $recognizer.RecognizeAsync()

  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()

  $operation = $first
  $failures = 0
  while ($true) {
    try {
      $result = Await $operation $resultType
      $failures = 0
      if ($result.Status -eq [Windows.Media.SpeechRecognition.SpeechRecognitionResultStatus]::Success -and
          $result.Confidence -ne [Windows.Media.SpeechRecognition.SpeechRecognitionConfidence]::Rejected) {
        Emit $result.Text
      }
    } catch {
      $failures += 1
      if ($failures -ge 3) { throw }
      Start-Sleep -Milliseconds 300
    }
    $operation = $recognizer.RecognizeAsync()
  }
}

# -------------------------------------------------------- System.Speech --

function Start-ClassicDictation {
  Add-Type -AssemblyName System.Speech

  $recognizers = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  if (-not $recognizers -or $recognizers.Count -eq 0) {
    throw 'No Windows speech recogniser is installed.'
  }
  # Prefer a recogniser for the user's own language.
  $culture = [System.Globalization.CultureInfo]::CurrentUICulture
  $info = $recognizers | Where-Object { $_.Culture.Name -eq $culture.Name } | Select-Object -First 1
  if (-not $info) { $info = $recognizers[0] }

  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $engine.SetInputToDefaultAudioDevice()
  $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(700)
  $engine.EndSilenceTimeoutAmbiguous = [TimeSpan]::FromMilliseconds(900)
  $engine.BabbleTimeout = [TimeSpan]::FromSeconds(0)
  $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(0)

  # Continuous recognition: the engine never stops listening between phrases.
  $null = Register-ObjectEvent -InputObject $engine -EventName SpeechRecognized -SourceIdentifier 'xode.speech'
  $engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)

  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()

  try {
    while ($true) {
      $event = Wait-Event -SourceIdentifier 'xode.speech'
      $result = $event.SourceEventArgs.Result
      Remove-Event -EventIdentifier $event.EventIdentifier
      # Low-confidence guesses are usually background noise.
      if ($result -and $result.Text -and $result.Confidence -ge 0.35) {
        Emit $result.Text
      }
    }
  } finally {
    $engine.RecognizeAsyncCancel()
    $engine.Dispose()
  }
}

# ------------------------------------------------------------------ run --

try {
  Start-WinRtDictation
} catch {
  [Console]::Error.WriteLine("winrt: $($_.Exception.Message)")
  try {
    Start-ClassicDictation
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
  }
}
