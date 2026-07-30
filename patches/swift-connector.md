# Nocturne macOS connector — `claude.*` relay

Adds a Claude Mode relay to the Swift Nocturne app so the Car Thing can reach
the claude-thing daemon over the existing Bluetooth link. Three edits plus one
new file; nothing about the existing music/Spotify surface changes.

Repo: `~/Desktop/Projects/nocturne/nocturne-connector/macos/Nocturne/`

The relay is a WebSocket **client** of the daemon (`ws://127.0.0.1:8790/ws`),
not a server: one socket carries request dispatch, event push, and status
heartbeats, and its liveness *is* the link state — no extra port, no polling.

---

## 1. New file: `Services/ClaudeRelayService.swift`

```swift
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
```

## 2. `Services/RPCManager.swift`

Store the relay (constructor injection alongside the existing services) and add
one branch to the `default:` arm of `dispatch(method:params:)`, next to the
existing `spotify.` prefix test:

```swift
            if method.hasPrefix("claude.") {
                let result = try await claudeRelay.call(method,
                                                        params: RPCValueBridge.dictionary(params))
                return RPCValueBridge.pack(result)
            }
```

Event direction, wired once during init (uses the existing
`broadcastToDevices(topic:data:)`):

```swift
        claudeRelay.onEvent = { [weak self] topic, data in
            Task { @MainActor in self?.broadcastToDevices(topic: topic, data: data) }
        }
```

## 3. `NocturneApp.swift`

Construct the relay in `init()` with the other services, pass it to
`RPCManager`, give it the Bluetooth summary, and start it:

```swift
        let claudeRelay = ClaudeRelayService()
        claudeRelay.statusProvider = { [weak bluetooth] in
            guard let bt = bluetooth, let conn = bt.carThingConnections.first else {
                return ["connected": false]
            }
            return [
                "connected": true,
                "device": conn.name ?? "Car Thing",
                "address": conn.address,
                "serial": rpcManager.deviceInfo(for: conn.address)?.serial ?? "",
                "firmware": rpcManager.deviceInfo(for: conn.address)?.version ?? "",
            ]
        }
        claudeRelay.start()
```

Also call `claudeRelay.pushStatus()` from the existing Bluetooth connect /
disconnect handlers so the daemon's webpage updates immediately instead of on
the next 10 s tick.

## 4. `Services/SessionStore.swift` + Settings UI

Add a persisted toggle following the `systemMediaEnabled` pattern:

```swift
    var claudeRelayEnabled: Bool {
        get { defaults.bool(forKey: "nocturne.claudeRelayEnabled") }
        set { defaults.set(newValue, forKey: "nocturne.claudeRelayEnabled") }
    }
```

Surface it in `Views/Pages/SettingsView.swift` as a new section ("Claude Mode —
relay Claude Code sessions to the Car Thing"), and optionally add a row to
`DashboardView` showing `claudeRelay.connected`.

---

## Verification on hardware

1. Enable the toggle; the daemon's webpage (`http://127.0.0.1:8790`) flips
   *Nocturne connector* to **relaying** and fills in the Bluetooth rows.
2. On the device, hold preset 1 + preset 4 for one second → Claude Mode; the
   session list should populate (requires `patches/nocturned-claude-forward.patch`
   in the running firmware, otherwise requests answer "Unknown method").
3. Trigger a permission prompt in a Claude Code session on the Mac → it appears
   fullscreen on the device; preset 1 allows, preset 4 denies, back skips.
