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
/// Pages talk to the app through three message handlers:
///   nav     {to: "music" | "sprint"}
///   session {cmd: "start" | "stop" | "marker" | "list" | "delete" | "share", ...}
///   store   Chord Sprint settings and stats (JSON string, kept in UserDefaults)
/// and the app calls back window.midiIn(status, d1, d2), window.midiDevices([names]) and
/// window.sessionState({recording, startedMs, sessions, event}).
final class PracticeViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate {
    enum Screen: String { case music, sprint }
    private static let storeKey = "chordSprintStore"
    private static let screenKey = "lastScreen"

    private let scheme = LocalSchemeHandler()
    private let midi = MIDIInput()
    private let recorder = SessionRecorder()
    private var music: WKWebView!
    private var sprint: WKWebView!
    private var loaded: Set<ObjectIdentifier> = []
    private var screen: Screen = .music
    private let pill = UIButton(type: .system)
    private var pillTimer: Timer?

    override var prefersStatusBarHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.106, green: 0.114, blue: 0.133, alpha: 1)
        let saved = UserDefaults.standard.string(forKey: Self.storeKey) ?? ""
        music = makeWebView(page: "index.html", scrolls: true)
        sprint = makeWebView(page: "chord-sprint/index.html", scrolls: false,
                             extraScript: "window.__nativeStore = \(Self.json(saved));")
        setUpPill()

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
                self?.recorder.addMarker(["k": "app_inactive"])
                self?.recorder.flush()
            }
        }
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.recorder.addMarker(["k": "app_active"])
                self?.sendSession(event: nil)
            }
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
        for name in ["nav", "session", "store"] { content.add(relay, name: name) }

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

    private func show(_ next: Screen) {
        screen = next
        music.isHidden = next != .music
        sprint.isHidden = next != .sprint
        (next == .music ? music : sprint)?.becomeFirstResponder()  // so a page-turn pedal reaches the reader
        UserDefaults.standard.set(next.rawValue, forKey: Self.screenKey)
        recorder.addMarker(["k": "screen", "to": next.rawValue])
        view.bringSubviewToFront(pill)
    }

    private func broadcast(_ js: String) {
        for web in [music, sprint] where web != nil && loaded.contains(ObjectIdentifier(web!)) {
            web!.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded.insert(ObjectIdentifier(webView))
        webView.evaluateJavaScript("window.midiDevices && window.midiDevices(\(Self.json(midi.sourceNames())));", completionHandler: nil)
        sendSession(event: nil)
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
        default:
            break
        }
    }

    private func handleSession(_ body: [String: Any]) {
        switch body["cmd"] as? String {
        case "start":
            recorder.start(devices: midi.sourceNames())
            recorder.addMarker(["k": "screen", "to": screen.rawValue])
            sendSession(event: "started")
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
        default:
            break
        }
    }

    private func sendSession(event: String?) {
        let sessions = recorder.list().map {
            ["name": $0.name, "started": $0.started, "durationMs": $0.durationMs, "notes": $0.notes, "playingMs": $0.playingMs,
             "pieces": $0.pieces, "sprintRounds": $0.sprintRounds] as [String: Any]
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

    // MARK: Recording indicator (visible on every screen while recording)

    private func setUpPill() {
        var config = UIButton.Configuration.filled()
        config.baseBackgroundColor = UIColor(red: 0.85, green: 0.22, blue: 0.2, alpha: 1)
        config.baseForegroundColor = .white
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 14, bottom: 6, trailing: 14)
        pill.configuration = config
        pill.isHidden = true
        pill.translatesAutoresizingMaskIntoConstraints = false
        pill.addTarget(self, action: #selector(pillTapped), for: .touchUpInside)
        view.addSubview(pill)
        NSLayoutConstraint.activate([
            pill.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            pill.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -10),
        ])
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
        var title = AttributedString("●  Recording \(clock)")
        title.font = .monospacedDigitSystemFont(ofSize: 15, weight: .semibold)
        pill.configuration?.attributedTitle = title
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
