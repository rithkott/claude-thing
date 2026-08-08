import Foundation
import Combine

@MainActor
final class ClaudeRelayService: ObservableObject {
    @Published var connected = false

    private var task: URLSessionWebSocketTask?
    private var pending: [String: CheckedContinuation<[String: Any], Error>] = [:]
    private var attempts = 0
    private var statusTimer: Timer?

    /// Set by RPCManager: forwards daemon events to every connected Car Thing.
    var onEvent: ((String, [String: Any]) -> Void)?

    // Superseding state events (session list, per-session detail, usage) are
    // coalesced before they cross Bluetooth: only the newest frame per key
    // survives a 200ms window. The daemon already debounces at the source;
    // this is the second line of defense for a link that is slower than the
    // daemon thinks. Asks and their resolutions are never held back.
    private var pendingState: [String: (topic: String, data: [String: Any])] = [:]
    private var flushTimer: Timer?
    private let coalesceInterval: TimeInterval = 0.2
    /// Set by NocturneApp: current Bluetooth link summary for the daemon's webpage.
    var statusProvider: (() -> [String: Any])?

    private let url = URL(string: "ws://127.0.0.1:8790/ws")!

    func start() {
        guard SessionStore.shared.claudeRelayEnabled else { return }
        connect()
    }

    func stop() {
        statusTimer?.invalidate()
        statusTimer = nil
        flushTimer?.invalidate()
        flushTimer = nil
        pendingState = [:]
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        connected = false
    }

    private func connect() {
        let t = URLSession.shared.webSocketTask(with: url)
        task = t
        t.resume()
        receive()
        send(["type": "request", "id": "hello-connector", "method": "bridge.hello",
              "params": ["role": "connector",
                         "info": ["app": "Nocturne", "version": AppConfig.connectorVersion]]])
        connected = true
        attempts = 0
        pushStatus()
        statusTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.pushStatus() }
        }
    }

    /// Reconnect with backoff; the daemon is optional, so failure is quiet.
    private func scheduleReconnect() {
        stop()
        guard SessionStore.shared.claudeRelayEnabled else { return }
        attempts += 1
        let delay = min(pow(2.0, Double(attempts - 1)), 30)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            Task { @MainActor in self?.connect() }
        }
    }

    func pushStatus() {
        guard connected, let provider = statusProvider else { return }
        send(["type": "request", "id": UUID().uuidString.lowercased(),
              "method": "bridge.status", "params": ["bt": provider()]])
    }

    /// Called from RPCManager for any `claude.*` method coming off the device.
    func call(_ method: String, params: [String: Any]) async throws -> [String: Any] {
        guard connected else { throw NSError(domain: "claude", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "daemon unreachable"]) }
        let id = UUID().uuidString.lowercased()
        return try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
            send(["type": "request", "id": id, "method": method, "params": params])
            DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
                Task { @MainActor in
                    if let c = self?.pending.removeValue(forKey: id) {
                        c.resume(throwing: NSError(domain: "claude", code: 2,
                            userInfo: [NSLocalizedDescriptionKey: "timeout"]))
                    }
                }
            }
        }
    }

    /// RPCValueBridge.pack, minus the Darwin trap: JSONSerialization numbers
    /// are NSNumber, and an NSNumber holding 0 or 1 succeeds `as Bool` — so
    /// upstream wrap()'s Bool case swallows every small count before its
    /// (correct) NSNumber arm can run, and "1 session" crosses Bluetooth as
    /// true. Test CFBoolean explicitly, FIRST, then number-ness. Only the
    /// claude.* paths route through here; spotify.* packing is untouched.
    nonisolated static func packJSON(_ value: Any?) -> MessagePackValue {
        guard let value, !(value is NSNull) else { return .nilValue }
        switch value {
        case let n as NSNumber:
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
            if CFNumberIsFloatType(n) { return .double(n.doubleValue) }
            return .int(n.int64Value)
        case let s as String: return .string(s)
        case let arr as [Any]: return .array(arr.map { packJSON($0) })
        case let dict as [String: Any]:
            return .map(dict.map { (.string($0.key), packJSON($0.value)) })
        default: return RPCValueBridge.pack(value)
        }
    }

    private func send(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }

    private func receive() {
        task?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .failure:
                    self.scheduleReconnect()
                case .success(let message):
                    if case .string(let text) = message { self.handle(text) }
                    self.receive()
                }
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let frame = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = frame["type"] as? String else { return }

        if type == "event", let topic = frame["topic"] as? String, topic.hasPrefix("claude.") {
            let data = frame["data"] as? [String: Any] ?? [:]
            if let key = coalesceKey(topic, data) {
                pendingState[key] = (topic, data)
                scheduleFlush()
            } else {
                onEvent?(topic, data)
            }
            return
        }
        guard let id = frame["id"] as? String, let cont = pending.removeValue(forKey: id) else { return }
        if type == "response" {
            cont.resume(returning: frame["result"] as? [String: Any] ?? [:])
        } else {
            cont.resume(throwing: NSError(domain: "claude", code: 3,
                userInfo: [NSLocalizedDescriptionKey: frame["error"] as? String ?? "error"]))
        }
    }

    /// One key per stream whose frames supersede each other; nil = deliver now.
    /// Session details are keyed per session so one chatty session cannot
    /// swallow another's update inside the same window.
    private func coalesceKey(_ topic: String, _ data: [String: Any]) -> String? {
        switch topic {
        case "claude.sessions.update", "claude.usage.update":
            return topic
        case "claude.session.update":
            return topic + ":" + ((data["id"] as? String) ?? "?")
        default:
            return nil
        }
    }

    private func scheduleFlush() {
        guard flushTimer == nil else { return }
        flushTimer = Timer.scheduledTimer(withTimeInterval: coalesceInterval, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.flushState() }
        }
    }

    private func flushState() {
        flushTimer = nil
        let batch = pendingState
        pendingState = [:]
        for (_, event) in batch { onEvent?(event.topic, event.data) }
    }
}
// MARK: - Integration
//
// Drop this file into nocturne-connector/macos/Nocturne/Services/, then make the
// edits described in patches/swift-connector.md:
//   1. RPCManager           — hold the relay, route `claude.*` through
//                             claudeRelay.call(...), forward onEvent to
//                             broadcastToDevices(...)
//   2. NocturneApp.init     — construct it, give it statusProvider, call start()
//   3. SessionStore         — a `claudeRelayEnabled` toggle, surfaced in
//                             SettingsView
//
// scripts/build-connector-dmg.sh does all of that automatically against a
// nocturne-connector checkout; this file plus the notes are for doing it by
// hand. Both were compiled against nocturne-connector 2.0.5 (Swift 5 mode).
