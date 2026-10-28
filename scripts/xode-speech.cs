// XodeCode dictation helper: Windows' own speech engine (the one behind
// voice typing, Win+H), driven directly so no Windows UI appears.
//
// XodeCode compiles this once with the C# compiler that ships with Windows
// (.NET Framework 4.x csc.exe) and runs it while the mic is on. It prints one
// line per event on stdout:
//   READY                 listening
//   PARTIAL <tab> text    the words so far in the current phrase (live)
//   FINAL <tab> text      a finished phrase, with punctuation
//   ERROR <tab> message   something went wrong (then it exits)
// It stops when stdin closes or the process is killed.

using System;
using System.Threading;
using Windows.Foundation;
using Windows.Media.SpeechRecognition;

static class XodeSpeech
{
    static readonly object Gate = new object();

    static void Emit(string kind, string text)
    {
        lock (Gate)
        {
            string clean = (text ?? "").Replace("\r", " ").Replace("\n", " ").Trim();
            Console.Out.WriteLine(clean.Length > 0 ? kind + "\t" + clean : kind);
            Console.Out.Flush();
        }
    }

    // Block until a WinRT call finishes (works without the Windows SDK, which
    // the async/await helpers would need).
    static T Wait<T>(IAsyncOperation<T> operation)
    {
        while (operation.Status == AsyncStatus.Started) Thread.Sleep(10);
        if (operation.Status != AsyncStatus.Completed) throw new Exception("call " + operation.Status + ": " + operation.ErrorCode);
        return operation.GetResults();
    }

    static void Wait(IAsyncAction action)
    {
        while (action.Status == AsyncStatus.Started) Thread.Sleep(10);
        if (action.Status != AsyncStatus.Completed) throw new Exception("call " + action.Status + ": " + action.ErrorCode);
        action.GetResults();
    }

    static int Main()
    {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        try
        {
            Run();
            return 0;
        }
        catch (Exception error)
        {
            Exception inner = error is AggregateException ? error.InnerException : error;
            Emit("ERROR", inner.Message);
            return 1;
        }
    }

    static void Run()
    {
        SpeechRecognizer recognizer = new SpeechRecognizer();
        // No constraints added: the built-in free-form dictation grammar.
        SpeechRecognitionCompilationResult compiled = Wait(recognizer.CompileConstraintsAsync());
        if (compiled.Status != SpeechRecognitionResultStatus.Success)
        {
            throw new Exception("speech engine unavailable: " + compiled.Status);
        }

        recognizer.HypothesisGenerated += (sender, args) => Emit("PARTIAL", args.Hypothesis.Text);

        SpeechContinuousRecognitionSession session = recognizer.ContinuousRecognitionSession;
        // Keep listening through long pauses; the app stops us.
        session.AutoStopSilenceTimeout = TimeSpan.FromHours(4);
        session.ResultGenerated += (sender, args) =>
        {
            if (args.Result.Confidence != SpeechRecognitionConfidence.Rejected)
            {
                Emit("FINAL", args.Result.Text);
            }
        };

        ManualResetEvent done = new ManualResetEvent(false);
        string failure = null;
        session.Completed += (sender, args) =>
        {
            if (args.Status != SpeechRecognitionResultStatus.Success)
            {
                failure = args.Status.ToString();
            }
            done.Set();
        };

        Wait(session.StartAsync());
        Emit("READY", "");

        // Stop when the app closes our stdin.
        new Thread(() =>
        {
            try
            {
                while (Console.In.Read() != -1) { }
            }
            catch { }
            done.Set();
        }) { IsBackground = true }.Start();

        done.WaitOne();
        if (failure != null)
        {
            throw new Exception("dictation stopped: " + failure);
        }
    }
}
