import Foundation
import Darwin

/// Records one practice session: every note on/off and pedal message with its time, plus markers
/// from the game (round started, chord played). Saved as JSON in Documents/Sessions, which is also
/// visible in the Files app. Use from the main thread only.
final class SessionRecorder {
    struct Summary: Codable {
        let name: String
        let started: Double      // ms since 1970
        let durationMs: Int
        let notes: Int
        let playingMs: Int
        let pieces: [String]     // scores opened while recording, in order
        let sprintRounds: Int
        let playing: [[Double]]  // stretches of playing, as fractions of the session [start, end]
        let sprint: [[Double]]   // Chord Sprint rounds, the same way
    }

    private(set) var isActive = false
    private var name = ""
    private var startNs: UInt64 = 0
    private var startDate = Date()
    private var events: [[Int]] = []          // [ms, status, data1, data2]
    private var markers: [[String: Any]] = []
    private var devices: [String] = []
    private var lastSave = Date()
    /// Last time a key was pressed (or the session started). Used to end a forgotten session.
    private(set) var lastActivity = Date()

    static let folder: URL = {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("Sessions", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    static func nanoseconds(_ ticks: UInt64) -> UInt64 {
        ticks * UInt64(timebase.numer) / UInt64(timebase.denom)
    }

    var startedMs: Double { startDate.timeIntervalSince1970 * 1000 }

    func start(devices: [String]) {
        guard !isActive else { return }  // already recording: keep the current session
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        startDate = Date()
        name = "session-\(formatter.string(from: startDate)).json"
        startNs = SessionRecorder.nanoseconds(mach_absolute_time())
        events = []
        markers = []
        self.devices = devices
        isActive = true
        lastActivity = Date()
        save(final: false)
    }

    /// Picks up a session that was still recording when the app was closed (iOS can quit a
    /// background app at any time), as long as it was saved within `within` seconds.
    /// Its timeline keeps following the wall clock, so the gap shows up as a pause.
    func resumeIfRecent(within: TimeInterval) -> Bool {
        guard !isActive else { return false }
        let files = (try? FileManager.default.contentsOfDirectory(at: SessionRecorder.folder,
                                                                 includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let newest = files.filter { $0.pathExtension == "json" }
            .compactMap { url -> (URL, Date)? in
                guard let date = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate else { return nil }
                return (url, date)
            }
            .max { $0.1 < $1.1 }
        guard let (url, savedAt) = newest, Date().timeIntervalSince(savedAt) < within,
              let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              obj["complete"] as? Bool == false,
              let startedMs = obj["startedEpochMs"] as? Int else { return false }
        let start = Date(timeIntervalSince1970: Double(startedMs) / 1000)
        let elapsedNs = UInt64(max(0, Date().timeIntervalSince(start)) * 1_000_000_000)
        let nowNs = SessionRecorder.nanoseconds(mach_absolute_time())
        guard elapsedNs < nowNs else { return false }
        name = url.lastPathComponent
        startDate = start
        startNs = nowNs - elapsedNs
        events = obj["events"] as? [[Int]] ?? []
        markers = obj["markers"] as? [[String: Any]] ?? []
        devices = obj["devices"] as? [String] ?? []
        isActive = true
        lastActivity = Date()
        addMarker(["k": "resumed"])
        save(final: false)
        return true
    }

    func stop() {
        guard isActive else { return }
        addMarker(["k": "stop"])
        save(final: true)
        isActive = false
    }

    /// Writes what has been recorded so far (e.g. when the app goes to the background).
    func flush() {
        if isActive { save(final: false) }
    }

    private func ms(_ ticks: UInt64) -> Int {
        let ns = SessionRecorder.nanoseconds(ticks)
        return ns > startNs ? Int((ns - startNs) / 1_000_000) : 0
    }

    func add(_ messages: [MIDIInput.Message]) {
        guard isActive else { return }
        for m in messages {
            let kind = m.status & 0xF0
            // Notes, plus sustain / sostenuto / soft pedal.
            guard kind == 0x80 || kind == 0x90 || (kind == 0xB0 && [64, 66, 67].contains(m.data1)) else { continue }
            events.append([ms(m.ticks), Int(m.status), Int(m.data1), Int(m.data2)])
            if kind == 0x90 && m.data2 > 0 { lastActivity = Date() }
        }
        if Date().timeIntervalSince(lastSave) > 30 { save(final: false) }
    }

    func addMarker(_ marker: [String: Any]) {
        guard isActive else { return }
        var entry = marker
        entry["ms"] = ms(mach_absolute_time())
        markers.append(entry)
    }

    private func save(final: Bool) {
        lastSave = Date()
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        let body: [String: Any] = [
            "version": 1,
            "app": "woodshed",
            "started": iso.string(from: startDate),
            "startedEpochMs": Int(startedMs),
            "durationMs": ms(mach_absolute_time()),
            "complete": final,
            "devices": devices,
            "eventFormat": ["ms", "status", "data1", "data2"],
            "events": events,
            "markers": markers,
        ]
        guard JSONSerialization.isValidJSONObject(body),
              let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        try? data.write(to: SessionRecorder.folder.appendingPathComponent(name), options: .atomic)
    }

    func url(for name: String) -> URL? {
        let url = SessionRecorder.folder.appendingPathComponent(name)
        guard url.lastPathComponent == name, name.hasSuffix(".json"),
              FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }

    func delete(_ name: String) {
        if let url = url(for: name), !(isActive && name == self.name) {
            try? FileManager.default.removeItem(at: url)
        }
    }

    /// Saved sessions, newest first. Playing time counts gaps of up to 5 s between notes.
    func list() -> [Summary] {
        let files = (try? FileManager.default.contentsOfDirectory(at: SessionRecorder.folder, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }.compactMap { url -> Summary? in
            guard let data = try? Data(contentsOf: url),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            let events = obj["events"] as? [[Int]] ?? []
            let onsets = events.filter { $0.count == 4 && $0[1] & 0xF0 == 0x90 && $0[3] > 0 }.map { $0[0] }
            var playing = onsets.isEmpty ? 0 : 1000
            for (a, b) in zip(onsets, onsets.dropFirst()) where b - a <= 5000 { playing += b - a }
            let markers = obj["markers"] as? [[String: Any]] ?? []
            var pieces: [String] = []
            for m in markers where m["k"] as? String == "page" {
                if let score = m["score"] as? String, !pieces.contains(score) { pieces.append(score) }
            }
            let rounds = markers.filter { $0["k"] as? String == "round_start" }.count
            let duration = max(1, obj["durationMs"] as? Int ?? 1)
            let frac = { (ms: Int) -> Double in (Double(min(ms, duration)) / Double(duration) * 1000).rounded() / 1000 }
            // Playing stretches for the timeline: notes less than 10 s apart belong together.
            var spans: [[Double]] = []
            var runStart = onsets.first ?? 0, runEnd = runStart
            for t in onsets.dropFirst() {
                if t - runEnd > 10_000 { spans.append([frac(runStart), frac(runEnd + 1000)]); runStart = t }
                runEnd = t
            }
            if !onsets.isEmpty { spans.append([frac(runStart), frac(runEnd + 1000)]) }
            var sprint: [[Double]] = []
            var roundStart: Int?
            for m in markers {
                let ms = m["ms"] as? Int ?? 0
                switch m["k"] as? String {
                case "round_start": roundStart = ms
                case "round_end", "stop": if let r = roundStart { sprint.append([frac(r), frac(ms)]); roundStart = nil }
                default: break
                }
            }
            return Summary(name: url.lastPathComponent,
                           started: Double(obj["startedEpochMs"] as? Int ?? 0),
                           durationMs: obj["durationMs"] as? Int ?? 0,
                           notes: onsets.count,
                           playingMs: playing,
                           pieces: pieces,
                           sprintRounds: rounds,
                           playing: Array(spans.prefix(200)),
                           sprint: sprint)
        }.sorted { $0.started > $1.started }
    }
}
