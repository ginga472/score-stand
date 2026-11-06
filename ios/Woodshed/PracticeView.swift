import SwiftUI
import UIKit
import WebKit

struct PracticeView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> PracticeViewController { PracticeViewController() }
    func updateUIViewController(_ controller: PracticeViewController, context: Context) {}
}

/// Hosts the two screens as web views (Music = Score Stand, Chord Sprint), feeds Chord Sprint the
/// piano, and owns practice-session recording so it keeps running whichever screen is showing.
///
/// Pages talk to the app through four message handlers:
///   nav      {to: "music" | "sprint"}
///   session  {cmd: "start" | "stop" | "marker" | "list" | "delete" | "share", ...}
///   practice {cmd: "metronome" | "plan_start" | "plan_end" | "state", ...}
///   store    Chord Sprint settings and stats (JSON string, kept in UserDefaults)
/// and the app calls back window.midiIn(status, d1, d2), window.midiDevices([names]),
/// window.sessionState({recording, startedMs, sessions, event}) and
/// window.practiceState({metronome, plan, event}).
final class PracticeViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {
    enum Screen: String { case music, sprint }
    private static let storeKey = "chordSprintStore"
    private static let screenKey = "lastScreen"

    private let scheme = LocalSchemeHandler()
    private let midi = MIDIInput()
    private let recorder = SessionRecorder()
    private let metronome = Metronome()
    private static let metronomeKey = "metronome"
    private var music: WKWebView!
    private var sprint: WKWebView!
    private var loaded: Set<ObjectIdentifier> = []
    private var screen: Screen = .music
    private let pill = UIButton(type: .system)
    private var pillTimer: Timer?
    private let pills = UIStackView()
    private let metroPill = UIButton(type: .system)
    private let planPill = UIButton(type: .system)

    /// The plan block being worked on, if any: a soft timer, nothing is locked.
    private struct PlanBlock {
        let id: String
        let label: String
        let goal: String
        let minutes: Int
        let started: Date
        var ends: Date
        var chimed = false
    }
    private var plan: PlanBlock?
    private var planTimer: Timer?

    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.078, green: 0.098, blue: 0.2, alpha: 1)  // theme.css --bg
        let saved = UserDefaults.standard.string(forKey: Self.storeKey) ?? ""
        music = makeWebView(page: "index.html", scrolls: true)
        sprint = makeWebView(page: "chord-sprint/index.html", scrolls: false,
                             extraScript: "window.__nativeStore = \(Self.json(saved));")
        setUpPills()
        restoreMetronome()

        midi.onMessages = { [weak self] messages in
            guard let self else { return }
            self.recorder.add(messages)
            guard self.screen == .sprint, self.loaded.contains(ObjectIdentifier(self.sprint)) else { return }
            let calls = messages.map { "window.midiIn(\($0.status),\($0.data1),\($0.data2));" }.joined()
            self.sprint.evaluateJavaScript(calls, completionHandler: nil)
        }
        midi.onDevicesChanged = { [weak self] names in
            self?.recorder.addMarker(["k": "devices", "names": names])
            self?.broadcast("window.midiDevices && window.midiDevices(\(Self.json(names)));")
        }

        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                // The click can't sound in the background; stop it so the session file stays true.
                if self?.metronome.isOn == true { self?.setMetronome(on: false) }
                self?.recorder.addMarker(["k": "app_inactive"])
                self?.recorder.flush()
                self?.sprint.evaluateJavaScript("window.screenShown && window.screenShown(false);", completionHandler: nil)
            }
        }
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.recorder.addMarker(["k": "app_active"])
                self.stopIfIdle()
                self.sendSession(event: nil)
                self.tellSprintIfShown()
            }
        }
        center.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.recorder.flush() }
        }

        // A session the app was closed in the middle of carries on where it left off.
        if recorder.resumeIfRecent(within: Self.idleLimit) { updatePill() }
        planTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tickPlan() }
        }
        // The app, not a page, decides when a forgotten session ends: it hears every key on every screen.
        idleTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.stopIfIdle() }
        }

        show(Screen(rawValue: UserDefaults.standard.string(forKey: Self.screenKey) ?? "") ?? .music)
    }

    // MARK: Web views

    private func makeWebView(page: String, scrolls: Bool, extraScript: String = "") -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(scheme, forURLScheme: LocalSchemeHandler.scheme)
        let content = config.userContentController
        content.addUserScript(WKUserScript(source: "window.__pianoApp = true;" + extraScript,
                                           injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let relay = WeakMessageHandler(self)
        for name in ["nav", "session", "store", "practice"] { content.add(relay, name: name) }

        let web = WKWebView(frame: view.bounds, configuration: config)
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.isScrollEnabled = scrolls
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.navigationDelegate = self
        #if DEBUG
        web.isInspectable = true  // Safari > Develop on the Mac can inspect the pages
        #endif
        view.addSubview(web)
        web.load(URLRequest(url: LocalSchemeHandler.url(page)))
        return web
    }

    /// Ends the session after 20 minutes without a key pressed, wherever the app is.
    static let idleLimit: TimeInterval = 20 * 60
    private var idleTimer: Timer?

    private func stopIfIdle() {
        guard recorder.isActive, Date().timeIntervalSince(recorder.lastActivity) > Self.idleLimit else { return }
        recorder.addMarker(["k": "auto_stop_silence"])
        recorder.stop()
        sendSession(event: "stopped")
    }

    /// Chord Sprint pauses a round while it's off screen.
    private func tellSprintIfShown() {
        guard loaded.contains(ObjectIdentifier(sprint)) else { return }
        sprint.evaluateJavaScript("window.screenShown && window.screenShown(\(screen == .sprint));", completionHandler: nil)
    }

    private func show(_ next: Screen) {
        screen = next
        tellSprintIfShown()
        music.isHidden = next != .music
        sprint.isHidden = next != .sprint
        (next == .music ? music : sprint)?.becomeFirstResponder()  // so a page-turn pedal reaches the reader
        UserDefaults.standard.set(next.rawValue, forKey: Self.screenKey)
        recorder.addMarker(["k": "screen", "to": next.rawValue])
        view.bringSubviewToFront(pills)
    }

    private func broadcast(_ js: String) {
        for web in [music, sprint] where web != nil && loaded.contains(ObjectIdentifier(web!)) {
            web!.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded.insert(ObjectIdentifier(webView))
        if webView == sprint { tellSprintIfShown() }
        webView.evaluateJavaScript("window.midiDevices && window.midiDevices(\(Self.json(midi.sourceNames())));", completionHandler: nil)
        sendSession(event: nil)
        sendPractice(event: nil)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loaded.remove(ObjectIdentifier(webView))
        webView.reload()
    }

    /// Only the bundled pages may load. Links to the web open in Safari instead.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url else { return .cancel }
        switch url.scheme {
        case LocalSchemeHandler.scheme where url.host == LocalSchemeHandler.host:
            return .allow
        case "about", "blob", "data":
            return .allow
        case "https" where navigationAction.navigationType == .linkActivated:
            _ = await UIApplication.shared.open(url)
            return .cancel
        default:
            return .cancel
        }
    }

    // MARK: Messages from the pages

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "store":
            if let body = message.body as? String { UserDefaults.standard.set(body, forKey: Self.storeKey) }
        case "nav":
            guard let body = message.body as? [String: Any], let to = body["to"] as? String, let next = Screen(rawValue: to) else { break }
            // Optional page inside the Music screen, e.g. "#/sessions". Only plain hash paths are accepted.
            if next == .music, let route = body["route"] as? String,
               route.range(of: "^#/[A-Za-z0-9/_-]*$", options: .regularExpression) != nil {
                music.evaluateJavaScript("location.hash = \(Self.json(route));", completionHandler: nil)
            }
            show(next)
        case "session":
            if let body = message.body as? [String: Any] { handleSession(body) }
        case "practice":
            if let body = message.body as? [String: Any] { handlePractice(body) }
        default:
            break
        }
    }

    private func handleSession(_ body: [String: Any]) {
        switch body["cmd"] as? String {
        case "start":
            guard !recorder.isActive else { sendSession(event: nil); break }  // a second tap never restarts a session
            startRecording()
        case "stop":
            recorder.stop()
            sendSession(event: "stopped")
        case "marker":
            var marker = body
            marker.removeValue(forKey: "cmd")
            recorder.addMarker(marker)
        case "list":
            sendSession(event: nil)
        case "delete":
            if let name = body["name"] as? String { recorder.delete(name) }
            sendSession(event: nil)
        case "share":
            if let name = body["name"] as? String, let url = recorder.url(for: name) { share(url) }
        case "notes":
            guard let name = body["name"] as? String, let text = body["text"] as? String else { break }
            let ok = recorder.saveNotes(text, for: name)
            music.evaluateJavaScript("window.notesSaved && window.notesSaved(\(ok));", completionHandler: nil)
            sendSession(event: nil)
        case "read":
            // A saved session's file, for uploading to your Supabase account.
            guard let name = body["name"] as? String else { break }
            let text = recorder.url(for: name).flatMap { try? String(contentsOf: $0, encoding: .utf8) }
            music.evaluateJavaScript("window.sessionFile && window.sessionFile(\(Self.json(name)), \(Self.json(text.map { $0 as Any } ?? NSNull())));", completionHandler: nil)
        case "paste":
            // Reading the clipboard shows iOS's own "Allow Paste" prompt.
            let text = UIPasteboard.general.string ?? ""
            music.evaluateJavaScript("window.pastedText && window.pastedText(\(Self.json(text)));", completionHandler: nil)
        default:
            break
        }
    }

    private func sendSession(event: String?) {
        let sessions = recorder.list().map {
            ["name": $0.name, "started": $0.started, "durationMs": $0.durationMs, "notes": $0.notes, "playingMs": $0.playingMs,
             "pieces": $0.pieces, "sprintRounds": $0.sprintRounds,
             "playing": $0.playing, "sprint": $0.sprint, "review": $0.review.map { $0 as Any } ?? NSNull(),
             "complete": $0.complete] as [String: Any]
        }
        var state: [String: Any] = ["recording": recorder.isActive, "startedMs": recorder.startedMs, "sessions": sessions]
        if let event { state["event"] = event }
        broadcast("window.sessionState && window.sessionState(\(Self.json(state)));")
        updatePill()
    }

    private func share(_ url: URL) {
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        sheet.popoverPresentationController?.permittedArrowDirections = []
        (presentedViewController ?? self).present(sheet, animated: true)
    }

    // MARK: Pills along the bottom (visible on every screen): plan timer, metronome, recording

    private func setUpPills() {
        pills.axis = .horizontal
        pills.spacing = 10
        pills.alignment = .center
        pills.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(pills)
        NSLayoutConstraint.activate([
            pills.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            pills.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -10),
        ])
        style(planPill, background: UIColor(red: 1, green: 0.741, blue: 0.349, alpha: 1),     // theme.css --accent
              foreground: UIColor(red: 0.169, green: 0.102, blue: 0.02, alpha: 1))
        style(metroPill, background: UIColor(red: 0.157, green: 0.188, blue: 0.345, alpha: 1), // --raised
              foreground: UIColor(red: 0.957, green: 0.925, blue: 0.863, alpha: 1))
        style(pill, background: UIColor(red: 0.85, green: 0.22, blue: 0.2, alpha: 1), foreground: .white)
        planPill.addTarget(self, action: #selector(planPillTapped), for: .touchUpInside)
        metroPill.addTarget(self, action: #selector(metroPillTapped), for: .touchUpInside)
        pill.addTarget(self, action: #selector(pillTapped), for: .touchUpInside)
        for p in [planPill, metroPill, pill] { p.isHidden = true; pills.addArrangedSubview(p) }
    }

    private func style(_ button: UIButton, background: UIColor, foreground: UIColor) {
        var config = UIButton.Configuration.filled()
        config.baseBackgroundColor = background
        config.baseForegroundColor = foreground
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 14, bottom: 6, trailing: 14)
        button.configuration = config
    }

    private func setTitle(_ button: UIButton, _ text: String) {
        var title = AttributedString(text)
        title.font = .monospacedDigitSystemFont(ofSize: 15, weight: .semibold)
        button.configuration?.attributedTitle = title
    }

    private func updatePill() {
        pill.isHidden = !recorder.isActive
        pillTimer?.invalidate()
        pillTimer = nil
        guard recorder.isActive else { return }
        refreshPillTitle()
        pillTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshPillTitle() }
        }
    }

    private func refreshPillTitle() {
        let seconds = Int(Date().timeIntervalSince1970 - recorder.startedMs / 1000)
        let clock = seconds >= 3600
            ? String(format: "%d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
            : String(format: "%d:%02d", seconds / 60, seconds % 60)
        setTitle(pill, "●  Recording \(clock)")
    }

    @objc private func pillTapped() {
        let alert = UIAlertController(title: "Stop recording?",
                                      message: "The session is saved and listed under Sessions, where you can share it.",
                                      preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Keep recording", style: .cancel))
        alert.addAction(UIAlertAction(title: "Stop & save", style: .default) { [weak self] _ in
            self?.recorder.stop()
            self?.sendSession(event: "stopped")
        })
        present(alert, animated: true)
    }

    // MARK: Metronome and plan blocks

    private func startRecording() {
        recorder.start(devices: midi.sourceNames())
        recorder.addMarker(["k": "screen", "to": screen.rawValue])
        if metronome.isOn { recorder.addMarker(metronomeMarker()) }
        if let plan { recorder.addMarker(["k": "plan_start", "id": plan.id, "label": plan.label, "min": plan.minutes, "continued": true]) }
        sendSession(event: "started")
    }

    private func handlePractice(_ body: [String: Any]) {
        switch body["cmd"] as? String {
        case "metronome":
            var s = metronome.settings
            if let v = body["bpm"] as? Double { s.bpm = Int(v.rounded()) }
            if let v = body["beats"] as? Double { s.beats = Int(v) }
            if let v = body["sub"] as? Double { s.sub = Int(v) }
            if let v = body["volume"] as? Double { s.volume = v }
            setMetronome(on: body["on"] as? Bool ?? metronome.isOn, settings: s)
        case "plan_start":
            startPlan(body)
        case "plan_end":
            endPlan(reason: Self.text(body["reason"], 20) == "skipped" ? "skipped" : "done")
        default:
            sendPractice(event: nil)
        }
    }

    private func setMetronome(on: Bool, settings: Metronome.Settings? = nil) {
        let wasOn = metronome.isOn, before = metronome.settings
        metronome.update(on: on, settings: settings ?? before)
        let s = metronome.settings
        UserDefaults.standard.set(["bpm": s.bpm, "beats": s.beats, "sub": s.sub, "volume": s.volume] as [String: Any], forKey: Self.metronomeKey)
        // Volume alone doesn't change the timing, so it isn't worth a marker.
        var timing = s
        timing.volume = before.volume
        if metronome.isOn != wasOn || timing != before { recorder.addMarker(metronomeMarker()) }
        sendPractice(event: nil)
    }

    private func restoreMetronome() {
        guard let saved = UserDefaults.standard.dictionary(forKey: Self.metronomeKey) else { return }
        var s = Metronome.Settings()
        if let v = saved["bpm"] as? Int { s.bpm = v }
        if let v = saved["beats"] as? Int { s.beats = v }
        if let v = saved["sub"] as? Int { s.sub = v }
        if let v = saved["volume"] as? Double { s.volume = v }
        metronome.update(on: false, settings: s)
    }

    /// What goes in the session file: clicks fall every 60000 / bpm / sub ms, forwards and backwards
    /// from downbeatMs (beat 1 of a bar), until the next metronome marker.
    private func metronomeMarker() -> [String: Any] {
        let s = metronome.settings
        guard metronome.isOn else { return ["k": "metronome", "on": false] }
        return ["k": "metronome", "on": true, "bpm": s.bpm, "beats": s.beats, "sub": s.sub,
                "downbeatMs": recorder.ms(metronome.nextDownbeatTicks()), "latencyMs": metronome.latencyMs]
    }

    private static func text(_ value: Any?, _ limit: Int) -> String {
        String(((value as? String) ?? "").prefix(limit))
    }

    private func startPlan(_ body: [String: Any]) {
        if plan != nil { endPlan(reason: "switched") }
        let minutes = min(60, max(1, Int((body["min"] as? Double ?? 10).rounded())))
        let block = PlanBlock(id: Self.text(body["id"], 80), label: Self.text(body["label"], 120),
                              goal: Self.text(body["goal"], 200), minutes: minutes,
                              started: Date(), ends: Date().addingTimeInterval(Double(minutes) * 60))
        // A plan block is practice worth reviewing: record it if nothing is recording yet.
        if !recorder.isActive { startRecording() }
        plan = block
        var marker: [String: Any] = ["k": "plan_start", "id": block.id, "label": block.label, "min": minutes]
        if let bars = body["bars"] as? String { marker["bars"] = String(bars.prefix(40)) }
        if let bpm = body["bpm"] as? Double, bpm >= 20, bpm <= 240 {
            marker["bpm"] = Int(bpm.rounded())
            var s = metronome.settings
            s.bpm = Int(bpm.rounded())
            recorder.addMarker(marker)
            setMetronome(on: true, settings: s)
        } else {
            recorder.addMarker(marker)
        }
        tickPlan()
        sendPractice(event: nil)
    }

    private func endPlan(reason: String) {
        guard let block = plan else { return }
        plan = nil
        recorder.addMarker(["k": "plan_end", "id": block.id, "reason": reason,
                            "playedMin": (Date().timeIntervalSince(block.started) / 6).rounded() / 10])
        tickPlan()
        sendPractice(event: ["planEnded": block.id, "reason": reason])
    }

    private func tickPlan() {
        guard var block = plan else { planPill.isHidden = true; return }
        let left = Int(block.ends.timeIntervalSinceNow.rounded(.up))
        if left <= 0 {
            if !block.chimed {
                block.chimed = true
                plan = block
                metronome.chime()
                recorder.addMarker(["k": "plan_time_up", "id": block.id])
                sendPractice(event: nil)
            }
            setTitle(planPill, "◎  Time's up · \(block.label)")
        } else {
            setTitle(planPill, String(format: "◎  %@ · %d:%02d", block.label, left / 60, left % 60))
        }
        planPill.isHidden = false
    }

    @objc private func planPillTapped() {
        guard let block = plan else { return }
        let left = block.ends.timeIntervalSinceNow
        let status = left > 0 ? "\(Int((left / 60).rounded(.up))) min left of \(block.minutes)." : "Your \(block.minutes) minutes are up. Keep going if it's useful."
        let alert = UIAlertController(title: block.label, message: [block.goal, status].filter { !$0.isEmpty }.joined(separator: "\n\n"),
                                      preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Keep going", style: .cancel))
        alert.addAction(UIAlertAction(title: "5 more minutes", style: .default) { [weak self] _ in
            guard let self, var b = self.plan else { return }
            b.ends = max(b.ends, Date()).addingTimeInterval(5 * 60)
            b.chimed = false
            self.plan = b
            self.recorder.addMarker(["k": "plan_extend", "id": b.id, "min": 5])
            self.tickPlan()
            self.sendPractice(event: nil)
        })
        alert.addAction(UIAlertAction(title: "Done with this", style: .default) { [weak self] _ in
            self?.endPlan(reason: "done")
        })
        present(alert, animated: true)
    }

    @objc private func metroPillTapped() {
        setMetronome(on: false)
    }

    private func sendPractice(event: [String: Any]?) {
        let s = metronome.settings
        metroPill.isHidden = !metronome.isOn
        if metronome.isOn { setTitle(metroPill, "♩ = \(s.bpm)  ■") }
        var state: [String: Any] = [
            "metronome": ["on": metronome.isOn, "bpm": s.bpm, "beats": s.beats, "sub": s.sub, "volume": s.volume] as [String: Any],
            "plan": plan.map { ["id": $0.id, "label": $0.label, "endsMs": $0.ends.timeIntervalSince1970 * 1000,
                                "over": $0.chimed] as [String: Any] as Any } ?? NSNull(),
        ]
        if let event { state["event"] = event }
        broadcast("window.practiceState && window.practiceState(\(Self.json(state)));")
    }

    static func json(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed),
              let text = String(data: data, encoding: .utf8) else { return "null" }
        return text
    }
}

/// Lets the pages message the controller without the web views keeping it alive.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
