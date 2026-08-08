import Foundation
import os
import Combine
import AppKit

@MainActor
final class AuthService: ObservableObject {
    private let log = Log.make(for: "AuthService")
    private let api = APIClient()
    private let store = SessionStore.shared

    @Published private(set) var status: AuthStatus = AuthStatus(isInitializing: true)

    private var refreshLoopTask: Task<Void, Never>?
    private var inFlightRefresh: Task<Void, Error>?
    private var accessTokenExpiresAt: Date?
    private var wakeObserver: NSObjectProtocol?

    private static let proactiveLeeway: TimeInterval = 10 * 60
    private static let onDemandLeeway: TimeInterval = 2 * 60

    init() {
        status.setupComplete = store.setupComplete
        if let tokens = store.loadSupabaseTokens() {
            accessTokenExpiresAt = Self.jwtExpiry(tokens.accessToken)
        }
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { _ in
            Task { @MainActor [weak self] in
                await self?.recoverAfterWake()
            }
        }
    }

    deinit {
        if let wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver)
        }
    }

    func initialize() async {
        status.isInitializing = true
        defer { status.isInitializing = false }

        guard let tokens = store.loadSupabaseTokens() else {
            log.info("No persisted Supabase session")
            return
        }

        do {
            try await refreshSession()
        } catch {
            guard store.loadSupabaseTokens() != nil else { return }
            log.warning("Stored session refresh failed (transient, will keep retrying): \(error.localizedDescription, privacy: .public)")
            let stillValid = (accessTokenExpiresAt ?? Self.jwtExpiry(tokens.accessToken)).map { $0 > Date() } ?? false
            status.authenticated = stillValid
            if stillValid, status.user == nil {
                status.user = try? await fetchUser(accessToken: tokens.accessToken)
            }
        }
        startRefreshLoop()
    }

    func pair(code: String) async throws -> NocturneUser {
        let url = AppConfig.nocturneSiteURL.appendingPathComponent("api/pair/redeem")
        let body = try JSONSerialization.data(withJSONObject: ["code": code])
        let (data, http) = try await api.request(url, method: "POST", body: body)

        let decoded = (try? JSONDecoder().decode(PairRedeemResponse.self, from: data)) ?? PairRedeemResponse(access_token: nil, refresh_token: nil, error: nil)

        guard (200..<300).contains(http.statusCode),
              let access = decoded.access_token,
              let refresh = decoded.refresh_token else {
            throw HTTPError.status(http.statusCode, decoded.error ?? String(data: data, encoding: .utf8))
        }

        let tokens = SupabaseTokens(accessToken: access, refreshToken: refresh)
        store.saveSupabaseTokens(tokens)
        accessTokenExpiresAt = Self.jwtExpiry(access)

        let user = try await fetchUser(accessToken: access)
        status.authenticated = true
        status.user = user
        startRefreshLoop()
        return user
    }

    func signOut() async {
        stopRefreshLoop()
        if let tokens = store.loadSupabaseTokens() {
            let url = AppConfig.supabaseURL.appendingPathComponent("auth/v1/logout")
            _ = try? await api.request(
                url,
                method: "POST",
                headers: authHeaders(accessToken: tokens.accessToken),
                body: Data("{}".utf8)
            )
        }
        store.clearSupabaseTokens()
        accessTokenExpiresAt = nil
        status.authenticated = false
        status.user = nil
    }

    func deleteAccount() async throws {
        guard let tokens = store.loadSupabaseTokens(), let user = status.user else {
            throw HTTPError.status(401, "Not authenticated")
        }
        let url = AppConfig.supabaseURL.appendingPathComponent("functions/v1/delete-account")
        let body = try JSONSerialization.data(withJSONObject: ["userId": user.id])
        let (data, http) = try await api.request(
            url,
            method: "POST",
            headers: authHeaders(accessToken: tokens.accessToken),
            body: body
        )
        guard (200..<300).contains(http.statusCode) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
                .flatMap { ($0["message"] as? String) ?? ($0["error"] as? String) }
            if http.statusCode == 404 {
                throw HTTPError.status(404, "Account deletion is not yet available. Please try again later.")
            }
            throw HTTPError.status(http.statusCode, msg)
        }
        await signOut()
    }

    func markSetupComplete() {
        store.setupComplete = true
        status.setupComplete = true
    }

    func currentAccessToken() async throws -> String {
        try await validAccessToken()
    }

    func validAccessToken(forceRefresh: Bool = false) async throws -> String {
        guard let tokens = store.loadSupabaseTokens() else {
            throw HTTPError.status(401, "Not authenticated")
        }
        let expiresAt = accessTokenExpiresAt ?? Self.jwtExpiry(tokens.accessToken)
        let usable = !forceRefresh && (expiresAt.map { $0.timeIntervalSinceNow > Self.onDemandLeeway } ?? false)
        if usable { return tokens.accessToken }

        try await refreshSession()
        guard let fresh = store.loadSupabaseTokens() else {
            throw HTTPError.status(401, "Not authenticated")
        }
        return fresh.accessToken
    }

    func recoverAfterWake() async {
        guard store.loadSupabaseTokens() != nil else { return }
        do {
            _ = try await validAccessToken(forceRefresh: true)
        } catch {
            guard store.loadSupabaseTokens() != nil else { return }
            log.warning("Wake session refresh failed; refresh loop will keep retrying: \(error.localizedDescription, privacy: .public)")
        }
        startRefreshLoop()
    }

    private func startRefreshLoop() {
        stopRefreshLoop()
        refreshLoopTask = Task { @MainActor [weak self] in
            var backoff: TimeInterval = 5
            while !Task.isCancelled {
                guard let self, self.store.loadSupabaseTokens() != nil else { return }
                let due = (self.accessTokenExpiresAt ?? .distantPast).addingTimeInterval(-Self.proactiveLeeway)
                let wait = due.timeIntervalSinceNow
                if wait > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                    if Task.isCancelled { return }
                }
                do {
                    try await self.refreshSession()
                    backoff = 5
                } catch {
                    guard self.store.loadSupabaseTokens() != nil else { return }
                    self.log.warning("Session refresh failed (retrying in \(Int(backoff), privacy: .public)s): \(error.localizedDescription, privacy: .public)")
                    try? await Task.sleep(nanoseconds: UInt64(backoff * 1_000_000_000))
                    backoff = min(backoff * 2, 300)
                }
            }
        }
    }

    private func stopRefreshLoop() {
        refreshLoopTask?.cancel()
        refreshLoopTask = nil
    }

    private func refreshSession() async throws {
        if let inFlight = inFlightRefresh {
            try await inFlight.value
            return
        }
        let task = Task { try await self.doRefreshSession() }
        inFlightRefresh = task
        defer { inFlightRefresh = nil }
        try await task.value
    }

    private func doRefreshSession() async throws {
        guard let tokens = store.loadSupabaseTokens() else {
            throw HTTPError.status(401, "Not authenticated")
        }
        let url = AppConfig.supabaseURL.appendingPathComponent("auth/v1/token")
        var comp = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        comp.queryItems = [URLQueryItem(name: "grant_type", value: "refresh_token")]
        let body = try JSONSerialization.data(withJSONObject: ["refresh_token": tokens.refreshToken])

        let (data, http) = try await api.request(
            comp.url!,
            method: "POST",
            headers: ["apikey": AppConfig.supabaseAnonKey],
            body: body
        )

        let decoded = try? JSONDecoder().decode(SupabaseTokenResponse.self, from: data)

        guard (200..<300).contains(http.statusCode),
              let access = decoded?.access_token,
              let refresh = decoded?.refresh_token else {
            let msg = decoded.flatMap { $0.error_description ?? $0.error ?? $0.msg ?? $0.message }
            if Self.isRetryableAuthFailure(http.statusCode) {
                // The refresh loop's backoff is the retry; the session is
                // untouched, so the user stays signed in through a Supabase
                // outage or a rate limit.
                log.warning("Supabase token refresh returned retryable HTTP \(http.statusCode, privacy: .public) — keeping the session")
            } else if Self.isDefinitiveAuthFailure(http.statusCode, message: msg) {
                log.error("Supabase session no longer valid (HTTP \(http.statusCode, privacy: .public)): \(msg ?? "no detail", privacy: .public) — signing out")
                store.clearSupabaseTokens()
                accessTokenExpiresAt = nil
                status.authenticated = false
                status.user = nil
            }
            throw HTTPError.status(http.statusCode, msg)
        }

        store.saveSupabaseTokens(SupabaseTokens(accessToken: access, refreshToken: refresh))
        accessTokenExpiresAt = Self.jwtExpiry(access)
        if let u = decoded?.user {
            status.user = NocturneUser(id: u.id, email: u.email)
        } else if status.user == nil {
            status.user = try? await fetchUser(accessToken: access)
        }
        status.authenticated = true
    }

    // Supabase's own vocabulary for "this session is gone, re-authenticate".
    // Anything outside it is a server or transport problem, not a verdict on
    // the user's session. Mirrors DEFINITIVE_PATTERNS in auth-service.ts.
    private static let definitivePatterns = [
        "refresh_token_not_found",
        "refresh_token_already_used",
        "invalid_grant",
        "invalid_token",
        "session_not_found",
        "user_not_found",
        "invalid refresh token",
    ]

    // resilient-auth-fetch.ts remaps these on the refresh endpoint so the
    // client retries instead of surfacing them: 408 request timeout, 425 too
    // early, 429 rate limited, plus anything 5xx. 0 stands for "no response".
    private static let retryableStatuses: Set<Int> = [0, 408, 425, 429]

    static func isRetryableAuthFailure(_ statusCode: Int) -> Bool {
        retryableStatuses.contains(statusCode) || statusCode >= 500
    }

    /// Status first, message second.
    ///
    /// The old test was 400/401/403 with a message merely *containing*
    /// "invalid" — which signed the user out on, say, a 400 "invalid request
    /// body" from a proxy, and equally on a 429 whose body happened to mention
    /// an invalid rate. Now: retryable statuses are never definitive; 401 and
    /// 403 always are; 400 and everything else only when the message carries a
    /// Supabase pattern that actually means the session is gone.
    /// Mirrors isDefinitiveAuthError in auth-service.ts.
    static func isDefinitiveAuthFailure(_ statusCode: Int, message: String?) -> Bool {
        if isRetryableAuthFailure(statusCode) { return false }
        let msg = message?.lowercased() ?? ""
        if statusCode == 401 || statusCode == 403 { return true }
        return definitivePatterns.contains { msg.contains($0) }
    }

    private static func jwtExpiry(_ jwt: String) -> Date? {
        let parts = jwt.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var payload = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 { payload += "=" }
        guard let data = Data(base64Encoded: payload),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let exp = obj["exp"] as? TimeInterval else { return nil }
        return Date(timeIntervalSince1970: exp)
    }

    private func fetchUser(accessToken: String) async throws -> NocturneUser {
        let url = AppConfig.supabaseURL.appendingPathComponent("auth/v1/user")
        let (data, http) = try await api.request(
            url,
            method: "GET",
            headers: authHeaders(accessToken: accessToken)
        )
        guard (200..<300).contains(http.statusCode) else {
            throw HTTPError.status(http.statusCode, String(data: data, encoding: .utf8))
        }
        let supaUser = try JSONDecoder().decode(SupabaseUser.self, from: data)
        return NocturneUser(id: supaUser.id, email: supaUser.email)
    }

    private func authHeaders(accessToken: String) -> [String: String] {
        [
            "apikey": AppConfig.supabaseAnonKey,
            "Authorization": "Bearer \(accessToken)"
        ]
    }
}
