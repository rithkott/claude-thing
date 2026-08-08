import Foundation
import CryptoKit
import os

// The v2 manifest OTA path, ported from car-thing-ota-service.ts.
//
// The legacy path in OTAService POSTs to /check-update and /update, gets one
// .swu back, and hands it to the device MD5-verified. 4.1 updates four kinds of
// thing on independent version lanes (image, daemon, builtinWebapp, bandaid),
// so the server needs all three lane versions to answer, the reply is a
// manifest of assets rather than one file, and integrity is SHA-256.
//
// Everything the device or the server sends is treated as untrusted: names,
// sizes and digests are pattern-checked before they reach the filesystem or an
// allocation, and a downloaded artifact is verified against both its expected
// size and its expected digest before it is moved into place.

enum CarThingOtaKind: String, Codable, CaseIterable {
    case image
    case daemon
    case builtinWebapp
    case bandaid
}

struct CarThingOtaAsset: Equatable, Codable {
    let name: String
    let size: Int
    let sha256: String
}

struct CarThingAvailableUpdate: Equatable {
    let version: String
    let channel: String
    let kind: CarThingOtaKind
    let updateId: String
    let expectedSha256: String
    let expectedSize: Int
    let updateUrlBase: String
    let primaryAsset: String
    let rangeAssets: [CarThingOtaAsset]
    let requiresReflash: Bool
    let flashthingZipURL: String?
}

struct CarThingUpdateCheck: Equatable {
    let available: Bool
    let channel: String
    let update: CarThingAvailableUpdate?
}

struct CarThingOtaVersionLanes: Equatable {
    let currentVersion: String
    let imageVersion: String
    let bandaidVersion: String

    // A device that reports only `version` — anything pre-4.1 — has all three
    // lanes at that version.
    init?(currentVersion: String?, imageVersion: String?, bandaidVersion: String?) {
        guard let current = CarThingOTAService.nonEmpty(currentVersion) else { return nil }
        self.currentVersion = current
        self.imageVersion = CarThingOTAService.nonEmpty(imageVersion) ?? current
        self.bandaidVersion = CarThingOTAService.nonEmpty(bandaidVersion) ?? current
    }
}

actor CarThingOTAService {
    private let log = Log.make(for: "CarThingOTA")
    private let serverURL: URL
    private let stateDir: URL
    private let session: URLSession

    private static let sha256Pattern = try! NSRegularExpression(pattern: "^[0-9a-f]{64}$", options: [.caseInsensitive])
    private static let assetNamePattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$")
    private static let updateIdPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    // The wire carries sizes as u32.
    private static let maxWireSize = 0xffff_ffff

    init(serverURL: URL = AppConfig.otaServerURL, stateDir: URL? = nil) {
        self.serverURL = serverURL
        self.stateDir = stateDir ?? Self.defaultStateDir()
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 30 * 60
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: config)
    }

    private static func defaultStateDir() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base
            .appendingPathComponent("Nocturne", isDirectory: true)
            .appendingPathComponent("car-thing-ota", isDirectory: true)
    }

    // MARK: - manifest

    func checkUpdate(
        currentVersion: String?,
        channel: String,
        imageVersion: String?,
        bandaidVersion: String?
    ) async throws -> CarThingUpdateCheck {
        guard let lanes = CarThingOtaVersionLanes(
            currentVersion: currentVersion,
            imageVersion: imageVersion,
            bandaidVersion: bandaidVersion
        ) else {
            throw OTAError("Device version is unavailable")
        }

        var components = URLComponents(
            url: serverURL.appendingPathComponent("v2/manifest"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [
            URLQueryItem(name: "channel", value: channel),
            URLQueryItem(name: "from", value: lanes.currentVersion),
            URLQueryItem(name: "image_from", value: lanes.imageVersion),
            URLQueryItem(name: "bandaid_from", value: lanes.bandaidVersion),
        ]
        guard let url = components?.url else {
            throw OTAError("Could not build the OTA manifest URL")
        }

        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw OTAError("OTA manifest returned an invalid response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw OTAError("OTA manifest returned HTTP \(http.statusCode)")
        }

        let manifest = try Self.object(JSONSerialization.jsonObject(with: data), "OTA manifest")
        let responseChannel = Self.optionalString(manifest["channel"]) ?? channel
        guard manifest["update_available"] as? Bool == true else {
            return CarThingUpdateCheck(available: false, channel: responseChannel, update: nil)
        }
        let update = try Self.parseAvailableUpdate(
            Self.object(manifest["update"], "OTA manifest update"),
            fallbackChannel: responseChannel
        )
        return CarThingUpdateCheck(available: true, channel: responseChannel, update: update)
    }

    // MARK: - primary artifact

    /// Downloads the primary asset and moves it into place only after both its
    /// size and its SHA-256 check out, so a partial or corrupted artifact is
    /// never visible under its final name. An artifact already on disk that
    /// verifies is reused, which is what makes a resumed install cheap.
    func preparePrimaryArtifact(
        _ update: CarThingAvailableUpdate,
        onProgress: (@Sendable (Int, Int) async -> Void)? = nil
    ) async throws -> URL {
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        let destination = primaryPath(for: update)
        if try await verify(destination, expectedSize: update.expectedSize, expectedSha256: update.expectedSha256) {
            await onProgress?(update.expectedSize, update.expectedSize)
            return destination
        }

        let partial = destination.appendingPathExtension("part")
        try? FileManager.default.removeItem(at: partial)

        guard let assetURL = assetURL(base: update.updateUrlBase, name: update.primaryAsset) else {
            throw OTAError("Could not build the OTA artifact URL")
        }
        var request = URLRequest(url: assetURL)
        request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")

        // A download task, not URLSession.bytes: AsyncBytes yields one UInt8 at
        // a time and an OTA artifact is hundreds of megabytes, so the Swift-
        // level loop would cost more than the transfer. The delegate cancels as
        // soon as the response overruns expectedSize, which is the same bound
        // the streaming version gave.
        let temp = try await download(request, expectedSize: update.expectedSize, onProgress: onProgress)
        try? FileManager.default.removeItem(at: partial)
        try FileManager.default.moveItem(at: temp, to: partial)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: partial.path)

        let downloaded = (try? fileSize(at: partial)) ?? -1
        guard downloaded == update.expectedSize else {
            try? FileManager.default.removeItem(at: partial)
            throw OTAError("OTA artifact size mismatch: expected \(update.expectedSize), got \(downloaded)")
        }
        guard try await verify(partial, expectedSize: update.expectedSize, expectedSha256: update.expectedSha256) else {
            try? FileManager.default.removeItem(at: partial)
            throw OTAError("OTA artifact hash mismatch: expected \(update.expectedSha256)")
        }

        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: partial, to: destination)
        log.info("OTA artifact ready: \(update.primaryAsset, privacy: .public) (\(downloaded, privacy: .public) bytes)")
        return destination
    }

    private let bufferSize = 256 * 1024

    /// Runs a download task to completion, reporting progress and refusing a
    /// response that overruns `expectedSize`. Returns a temp file the caller
    /// owns; URLSession deletes its own once the delegate returns, so it is
    /// moved aside first.
    private func download(
        _ request: URLRequest,
        expectedSize: Int,
        onProgress: (@Sendable (Int, Int) async -> Void)?
    ) async throws -> URL {
        let delegate = OTADownloadDelegate(expectedSize: expectedSize, onProgress: onProgress)
        return try await withCheckedThrowingContinuation { continuation in
            delegate.continuation = continuation
            let task = session.downloadTask(with: request)
            task.delegate = delegate
            delegate.retain = task
            task.resume()
        }
    }

    func readPrimaryChunk(_ update: CarThingAvailableUpdate, offset: Int, size: Int) throws -> Data {
        guard offset >= 0 else { throw OTAError("Invalid OTA offset \(offset)") }
        try OTATransfer.requireWindow(size)
        let path = primaryPath(for: update)
        let total = try fileSize(at: path)
        guard offset < total else {
            throw OTAError("OTA offset \(offset) is outside \(total)-byte artifact")
        }
        let length = min(size, total - offset)
        let handle = try FileHandle(forReadingFrom: path)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(offset))
        return try handle.read(upToCount: length) ?? Data()
    }

    // MARK: - range assets

    /// A byte range of a non-primary asset, fetched straight from the server
    /// rather than downloaded whole — this is what lets the device pull only
    /// the parts of a large asset it is missing.
    func fetchAssetRange(
        _ update: CarThingAvailableUpdate,
        asset: CarThingOtaAsset,
        start: Int,
        length: Int
    ) async throws -> Data {
        guard start >= 0, length > 0, start + length <= asset.size else {
            throw OTAError("Invalid range \(start)+\(length) for \(asset.name)")
        }
        let end = start + length - 1
        guard let url = assetURL(base: update.updateUrlBase, name: asset.name) else {
            throw OTAError("Could not build the OTA asset URL")
        }
        var request = URLRequest(url: url)
        request.setValue("bytes=\(start)-\(end)", forHTTPHeaderField: "Range")

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw OTAError("OTA range returned an invalid response")
        }
        // 200 here would mean the whole asset: the server ignored the Range and
        // we would hand the device the wrong bytes at the right offset.
        guard http.statusCode == 206 else {
            throw OTAError("OTA range returned HTTP \(http.statusCode)")
        }
        let expected = "bytes \(start)-\(end)/\(asset.size)"
        guard http.value(forHTTPHeaderField: "Content-Range") == expected else {
            throw OTAError("OTA range Content-Range mismatch: expected \(expected)")
        }
        guard data.count == length else {
            throw OTAError("OTA range returned \(data.count) bytes, expected \(length)")
        }
        return data
    }

    // MARK: - persisted session

    // active.json survives a connector restart mid-install, so the device can
    // resume a range session against the artifact already on disk.
    func rememberActiveUpdate(_ update: CarThingAvailableUpdate) throws {
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        let assets: [[String: Any]] = [[
            "name": update.primaryAsset,
            "size": update.expectedSize,
            "sha256": update.expectedSha256,
        ]] + update.rangeAssets.map { ["name": $0.name, "size": $0.size, "sha256": $0.sha256] }

        var persisted: [String: Any] = [
            "version": update.version,
            "channel": update.channel,
            "kind": update.kind.rawValue,
            "update_id": update.updateId,
            "expected_sha256": update.expectedSha256,
            "expected_size": update.expectedSize,
            "update_url_base": update.updateUrlBase,
            "assets": assets,
            "requires_reflash": update.requiresReflash,
        ]
        persisted["flashthing_zip_url"] = update.flashthingZipURL ?? NSNull()

        let data = try JSONSerialization.data(withJSONObject: persisted)
        let next = sessionPath.appendingPathExtension("next")
        try data.write(to: next, options: .atomic)
        try? FileManager.default.removeItem(at: sessionPath)
        try FileManager.default.moveItem(at: next, to: sessionPath)
    }

    func activeUpdate() -> CarThingAvailableUpdate? {
        guard let data = try? Data(contentsOf: sessionPath) else { return nil }
        guard let raw = try? Self.object(JSONSerialization.jsonObject(with: data), "persisted OTA session") else {
            return nil
        }
        return try? Self.parseAvailableUpdate(raw, fallbackChannel: "stable")
    }

    func clearActiveUpdate(deleteArtifact: Bool) {
        let active = activeUpdate()
        try? FileManager.default.removeItem(at: sessionPath)
        try? FileManager.default.removeItem(at: sessionPath.appendingPathExtension("next"))
        if deleteArtifact, let active {
            let path = primaryPath(for: active)
            try? FileManager.default.removeItem(at: path)
            try? FileManager.default.removeItem(at: path.appendingPathExtension("part"))
        }
    }

    // MARK: - paths and helpers

    private var sessionPath: URL { stateDir.appendingPathComponent("active.json") }

    private func primaryPath(for update: CarThingAvailableUpdate) -> URL {
        // updateId and primaryAsset are both pattern-checked at parse time and
        // cannot contain "/" or "..", so this cannot escape stateDir.
        stateDir.appendingPathComponent("\(update.updateId)-\(update.primaryAsset)")
    }

    private func assetURL(base: String, name: String) -> URL? {
        let trimmed = base.hasSuffix("/") ? String(base.dropLast()) : base
        guard let escaped = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else {
            return nil
        }
        return URL(string: "\(trimmed)/\(escaped)")
    }

    private func fileSize(at url: URL) throws -> Int {
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        guard let size = (attrs[.size] as? NSNumber)?.intValue else {
            throw OTAError("OTA artifact not found")
        }
        return size
    }

    private func verify(_ url: URL, expectedSize: Int, expectedSha256: String) async throws -> Bool {
        guard let size = try? fileSize(at: url), size == expectedSize else { return false }
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: bufferSize), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined() == expectedSha256
    }

    // MARK: - manifest parsing

    static func parseAvailableUpdate(
        _ raw: [String: Any],
        fallbackChannel: String = "stable"
    ) throws -> CarThingAvailableUpdate {
        let updateId = try requiredString(raw["update_id"] ?? raw["updateId"], "update_id")
        guard matches(updateIdPattern, updateId), !updateId.contains("..") else {
            throw OTAError("OTA update_id contains unsupported characters")
        }
        let kindRaw = try requiredString(raw["kind"], "kind")
        guard let kind = CarThingOtaKind(rawValue: kindRaw) else {
            throw OTAError("Unsupported OTA kind \(kindRaw)")
        }

        let expectedSha256 = try requiredString(raw["expected_sha256"] ?? raw["expectedSha256"], "expected_sha256").lowercased()
        guard matches(sha256Pattern, expectedSha256) else {
            throw OTAError("OTA expected_sha256 must be 64 hexadecimal characters")
        }
        let expectedSize = try requiredInt(raw["expected_size"] ?? raw["expectedSize"], "expected_size")
        guard expectedSize > 0, expectedSize <= maxWireSize else {
            throw OTAError("OTA expected_size \(expectedSize) is outside the wire limit")
        }

        guard let rawAssets = raw["assets"] as? [Any] else {
            throw OTAError("assets must be an array")
        }
        let assets = try rawAssets.map { try parseAsset(object($0, "OTA asset")) }
        guard let primary = assets.first else { throw OTAError("OTA manifest has no assets") }
        // The manifest states the digest twice; disagreeing with itself means
        // we cannot tell which one the device should be told to expect.
        guard primary.size == expectedSize, primary.sha256 == expectedSha256 else {
            throw OTAError("OTA primary asset does not match expected size and SHA-256")
        }

        return CarThingAvailableUpdate(
            version: try requiredString(raw["version"], "version"),
            channel: optionalString(raw["channel"]) ?? fallbackChannel,
            kind: kind,
            updateId: updateId,
            expectedSha256: expectedSha256,
            expectedSize: expectedSize,
            updateUrlBase: try requiredString(raw["update_url_base"] ?? raw["updateUrlBase"], "update_url_base"),
            primaryAsset: primary.name,
            rangeAssets: Array(assets.dropFirst()),
            requiresReflash: raw["requires_reflash"] as? Bool == true || raw["requiresReflash"] as? Bool == true,
            flashthingZipURL: optionalString(raw["flashthing_zip_url"] ?? raw["flashthingZipUrl"])
        )
    }

    private static func parseAsset(_ raw: [String: Any]) throws -> CarThingOtaAsset {
        let name = try requiredString(raw["name"], "asset name")
        // The name becomes a path component under stateDir and a URL path
        // segment, so "../" or "/" in it is a traversal.
        guard matches(assetNamePattern, name), !name.contains("..") else {
            throw OTAError("Invalid OTA asset name \(name)")
        }
        let size = try requiredInt(raw["size"], "\(name) size")
        guard size > 0, size <= maxWireSize else {
            throw OTAError("Invalid OTA asset size \(size) for \(name)")
        }
        let sha256 = try requiredString(raw["sha256"], "\(name) sha256").lowercased()
        guard matches(sha256Pattern, sha256) else {
            throw OTAError("Invalid OTA asset SHA-256 for \(name)")
        }
        return CarThingOtaAsset(name: name, size: size, sha256: sha256)
    }

    static func object(_ value: Any?, _ label: String) throws -> [String: Any] {
        guard let dict = value as? [String: Any] else {
            throw OTAError("\(label) must be an object")
        }
        return dict
    }

    private static func requiredString(_ value: Any?, _ label: String) throws -> String {
        guard let s = optionalString(value) else {
            throw OTAError("\(label) must be a non-empty string")
        }
        return s
    }

    static func optionalString(_ value: Any?) -> String? {
        guard let s = value as? String else { return nil }
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private static func requiredInt(_ value: Any?, _ label: String) throws -> Int {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else {
            throw OTAError("\(label) must be a finite number")
        }
        let d = n.doubleValue
        guard d.isFinite, d == d.rounded(), abs(d) <= Double(Int.max) else {
            throw OTAError("\(label) must be a finite number")
        }
        return n.intValue
    }

    private static func matches(_ regex: NSRegularExpression, _ value: String) -> Bool {
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return regex.firstMatch(in: value, options: [], range: range) != nil
    }
}

/// URLSessionDownloadDelegate bridged to an async continuation.
///
/// `didFinishDownloadingTo` hands back a temp file that URLSession deletes the
/// moment this method returns, so it is moved somewhere we own synchronously,
/// before resuming the caller.
private final class OTADownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let expectedSize: Int
    private let onProgress: (@Sendable (Int, Int) async -> Void)?
    private var finished = false
    private var overran = false

    var continuation: CheckedContinuation<URL, Error>?
    /// The task retains the delegate, so something must retain the task.
    var retain: URLSessionTask?

    init(expectedSize: Int, onProgress: (@Sendable (Int, Int) async -> Void)?) {
        self.expectedSize = expectedSize
        self.onProgress = onProgress
    }

    private func finish(_ result: Result<URL, Error>) {
        guard !finished else { return }
        finished = true
        retain = nil
        let continuation = self.continuation
        self.continuation = nil
        switch result {
        case .success(let url): continuation?.resume(returning: url)
        case .failure(let error): continuation?.resume(throwing: error)
        }
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        if totalBytesWritten > Int64(expectedSize) {
            overran = true
            downloadTask.cancel()
            return
        }
        if let onProgress {
            let written = Int(totalBytesWritten)
            let total = expectedSize
            Task { await onProgress(written, total) }
        }
    }

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didFinishDownloadingTo location: URL
    ) {
        if let http = downloadTask.response as? HTTPURLResponse, http.statusCode != 200 {
            finish(.failure(OTAError("OTA artifact returned HTTP \(http.statusCode)")))
            return
        }
        let owned = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("nocturne-ota-\(UUID().uuidString)")
        do {
            try FileManager.default.moveItem(at: location, to: owned)
            finish(.success(owned))
        } catch {
            finish(.failure(error))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if overran {
            finish(.failure(OTAError("OTA artifact exceeded expected size \(expectedSize)")))
        } else if let error {
            finish(.failure(error))
        } else {
            finish(.failure(OTAError("OTA artifact download produced no file")))
        }
    }
}
