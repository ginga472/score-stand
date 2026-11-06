import AVFoundation
import Darwin

/// The built-in click. Every click is scheduled on the host clock, the same clock the piano's MIDI
/// timestamps use, so a recorded session knows exactly where each click fell and a review can tell
/// whether the playing stayed with it. Also plays the soft chime when a plan block's time is up.
/// Use from the main thread only.
final class Metronome {
    struct Settings: Equatable {
        var bpm = 60        // quarter notes per minute
        var beats = 4       // beats per bar; 1 = no accent
        var sub = 1         // clicks per beat: 1 = quarters, 2 = eighths (helps at very slow tempos)
        var volume = 0.8    // 0...1
    }

    private(set) var isOn = false
    private(set) var settings = Settings()
    /// Host time (mach ticks) of the downbeat the current run started on.
    private(set) var anchorTicks: UInt64 = 0

    private let engine = AVAudioEngine()
    private let clicks = AVAudioPlayerNode()
    private let bell = AVAudioPlayerNode()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
    private lazy var accentClick = Metronome.click(format, freq: 1760, gain: 0.9)
    private lazy var beatClick = Metronome.click(format, freq: 1175, gain: 0.7)
    private lazy var subClick = Metronome.click(format, freq: 880, gain: 0.3)
    private lazy var chimeSound = Metronome.chime(format)
    private var next = 0            // index of the next click to schedule, counted from the anchor
    private var timer: Timer?
    private var engineReady = false

    init() {
        engine.attach(clicks)
        engine.attach(bell)
        engine.connect(clicks, to: engine.mainMixerNode, format: format)
        engine.connect(bell, to: engine.mainMixerNode, format: format)
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            // A route change (headphones, a USB device) stops the engine; carry on with a fresh run.
            MainActor.assumeIsolated {
                guard let self else { return }
                self.engineReady = false
                if self.isOn { self.restart() }
            }
        }
    }

    /// Seconds between two clicks (subdivisions included).
    private var clickSeconds: Double { 60.0 / Double(settings.bpm) / Double(settings.sub) }

    /// Sound output latency, recorded so a review can line clicks up with what was heard.
    var latencyMs: Int {
        let s = AVAudioSession.sharedInstance()
        return Int(((s.outputLatency + s.ioBufferDuration) * 1000).rounded())
    }

    func update(on: Bool, settings new: Settings) {
        var s = new
        s.bpm = min(240, max(20, s.bpm))
        s.beats = min(12, max(1, s.beats))
        s.sub = min(4, max(1, s.sub))
        s.volume = min(1, max(0, s.volume))
        let changed = s != settings || on != isOn
        settings = s
        clicks.volume = Float(s.volume)
        guard changed else { return }
        if on { restart() } else { stop() }
    }

    func stop() {
        isOn = false
        timer?.invalidate()
        timer = nil
        clicks.stop()
    }

    private func restart() {
        guard startEngine() else { isOn = false; return }
        isOn = true
        clicks.stop()           // drops clicks scheduled at the old tempo
        clicks.play()
        clicks.volume = Float(settings.volume)
        anchorTicks = Metronome.now() + Metronome.ticks(seconds: 0.12)
        next = 0
        schedule()
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.schedule() }
        }
    }

    /// Keeps about a third of a second of clicks queued. Each click's time is computed from the
    /// anchor, never from the previous click, so the beat can't drift.
    private func schedule() {
        guard isOn else { return }
        let horizon = Metronome.now() + Metronome.ticks(seconds: 0.35)
        while true {
            let at = clickTicks(next)
            if at > horizon { break }
            let perBar = settings.sub * settings.beats
            let buffer: AVAudioPCMBuffer
            if next % settings.sub != 0 { buffer = subClick }
            else if settings.beats > 1 && next % perBar == 0 { buffer = accentClick }
            else { buffer = beatClick }
            if at > Metronome.now() { clicks.scheduleBuffer(buffer, at: AVAudioTime(hostTime: at), options: [], completionHandler: nil) }
            next += 1
        }
    }

    private func clickTicks(_ index: Int) -> UInt64 {
        anchorTicks + Metronome.ticks(seconds: clickSeconds * Double(index))
    }

    /// Host time of the next downbeat (beat 1 of a bar) from now, for the session file.
    func nextDownbeatTicks() -> UInt64 {
        let now = Metronome.now()
        guard now > anchorTicks else { return anchorTicks }
        let bar = clickSeconds * Double(settings.sub * settings.beats)
        let elapsed = Double(Metronome.nanoseconds(now - anchorTicks)) / 1e9
        return anchorTicks + Metronome.ticks(seconds: (elapsed / bar).rounded(.up) * bar)
    }

    func chime() {
        guard startEngine() else { return }
        if !bell.isPlaying { bell.play() }
        bell.scheduleBuffer(chimeSound, at: nil, options: [], completionHandler: nil)
    }

    private func startEngine() -> Bool {
        if engineReady && engine.isRunning { return true }
        do {
            let session = AVAudioSession.sharedInstance()
            // Plays through the speaker or headphones, alongside anything else that's playing.
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setPreferredIOBufferDuration(0.005)
            try session.setActive(true)
            engine.prepare()
            try engine.start()
            engineReady = true
            return true
        } catch {
            engineReady = false
            return false
        }
    }

    // MARK: Clock

    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()
    static func now() -> UInt64 { mach_absolute_time() }
    static func ticks(seconds: Double) -> UInt64 {
        UInt64(max(0, seconds) * 1e9 * Double(timebase.denom) / Double(timebase.numer))
    }
    static func nanoseconds(_ ticks: UInt64) -> UInt64 {
        ticks * UInt64(timebase.numer) / UInt64(timebase.denom)
    }

    // MARK: Sounds (made here, so there are no audio files to ship)

    /// A short woodblock-like tick: a sine burst with a fast decay.
    private static func click(_ format: AVAudioFormat, freq: Double, gain: Double) -> AVAudioPCMBuffer {
        let rate = format.sampleRate
        let frames = AVAudioFrameCount(rate * 0.035)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        buffer.frameLength = frames
        let out = buffer.floatChannelData![0]
        for i in 0..<Int(frames) {
            let t = Double(i) / rate
            let attack = min(1, t / 0.0015)
            out[i] = Float(gain * attack * exp(-t / 0.007) * sin(2 * .pi * freq * t))
        }
        return buffer
    }

    /// Two soft bell notes, for "time's up".
    private static func chime(_ format: AVAudioFormat) -> AVAudioPCMBuffer {
        let rate = format.sampleRate
        let frames = AVAudioFrameCount(rate * 1.8)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        buffer.frameLength = frames
        let out = buffer.floatChannelData![0]
        for i in 0..<Int(frames) {
            let t = Double(i) / rate
            var v = 0.0
            for (start, f) in [(0.0, 880.0), (0.35, 1318.5)] where t >= start {
                let u = t - start
                let env = min(1, u / 0.004) * exp(-u / 0.45)
                v += env * (sin(2 * .pi * f * u) + 0.3 * sin(2 * .pi * f * 2.76 * u) * exp(-u / 0.1))
            }
            out[i] = Float(0.22 * v)
        }
        return buffer
    }
}
