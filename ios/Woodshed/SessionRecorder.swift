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
    }

    private(set) var isActive = false
    private var name = ""
    private var startNs: UInt64 = 0
    private var startDate = Date()
    private var events: [[Int]] = []          // [ms, status, data1, data2]
    private var markers: [[String: Any]] = []
    private var devices: [String] = []
    private var lastSave = Date()

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
        if isActive { stop() }
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
        save(final: false)
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
            return Summary(name: url.lastPathComponent,
                           started: Double(obj["startedEpochMs"] as? Int ?? 0),
                           durationMs: obj["durationMs"] as? Int ?? 0,
                           notes: onsets.count,
                           playingMs: playing)
        }.sorted { $0.started > $1.started }
    }
}
