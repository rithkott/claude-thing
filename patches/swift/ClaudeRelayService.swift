import Foundation

@MainActor
final class ClaudeRelayService: ObservableObject {
    @Published var connected = false

    private var task: URLSessionWebSocketTask?
    private var pending: [String: CheckedContinuation<[String: Any], Error>] = [:]
    private var attempts = 0
    private var statusTimer: Timer?

    /// Set by RPCManager: forwards daemon events to every connected Car Thing.
    var onEvent: ((String, [String: Any]) -> Void)?
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
            onEvent?(topic, frame["data"] as? [String: Any] ?? [:])
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
}
// MARK: - Integration
//
// Drop this file into nocturne-connector/macos/Nocturne/Services/, then make the
// three edits described in patches/swift-connector.md:
//   1. RPCManager.dispatch — route `claude.*` through claudeRelay.call(...)
//   2. RPCManager init      — claudeRelay.onEvent → broadcastToDevices(...)
//   3. NocturneApp.init     — construct it, give it statusProvider, call start()
//      plus a `claudeRelayEnabled` toggle in SessionStore + SettingsView.
//
// Verified to parse with the Swift 5 compiler; it is not compiled against the
// Nocturne target here, so the three call sites above are what to check first if
// the build complains.
