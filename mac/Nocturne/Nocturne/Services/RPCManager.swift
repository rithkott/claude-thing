import Foundation
import os
import Combine
#if canImport(IOBluetooth)
import IOBluetooth
#endif

@MainActor
final class RPCManager: ObservableObject {
    private let log = Log.make(for: "RPCManager")
    private let spotify: SpotifyService
    private let nowPlaying: NowPlayingService
    private let analytics: AnalyticsService?
    private let currentUserID: () -> String?
    private let ota = OTAService()
    private let carThingOta = CarThingOTAService()
    let claudeRelay: ClaudeRelayService

    @Published private(set) var deviceInfo: CarThingInfo? = nil
    @Published private(set) var deviceInfoByAddress: [String: CarThingInfo] = [:]
    @Published private(set) var lastPing: Date? = nil

    private struct Connection {
        let address: String
        #if canImport(IOBluetooth)
        weak var channel: IOBluetoothRFCOMMChannel?
        #endif
        let client: RPCClient
    }

    private var connections: [String: Connection] = [:]
    private var keepAliveTask: Task<Void, Never>?
    private var keepAliveFailures: [String: Int] = [:]
    private static let keepAliveFailureLimit = 2
    private var downloadedOTAFileURL: URL? = nil
    private var activeCarThingUpdate: CarThingAvailableUpdate? = nil
    private var carThingInstallTask: Task<Void, Never>? = nil
    private var carThingRangeTasks: [String: Task<Void, Never>] = [:]
    private var authObservation: AnyCancellable?
    private var pendingVolumePercent: Int?
    private var volumeReportTask: Task<Void, Never>?
    var onStaleConnection: ((String) -> Void)?

    init(
        spotify: SpotifyService,
        nowPlaying: NowPlayingService,
        analytics: AnalyticsService? = nil,
        currentUserID: @escaping () -> String? = { nil },
        claudeRelay: ClaudeRelayService
    ) {
        self.spotify = spotify
        self.nowPlaying = nowPlaying
        self.analytics = analytics
        self.currentUserID = currentUserID
        self.claudeRelay = claudeRelay

        // Daemon events arrive on the relay's socket and go straight out to
        // every paired Car Thing, same path the spotify.* broadcasts take.
        claudeRelay.onEvent = { [weak self] topic, data in
            Task { @MainActor [weak self] in
                await self?.broadcastToDevices(topic: topic, data: ClaudeRelayService.packJSON(data))
            }
        }

        spotify.onDeviceBroadcast = { [weak self] topic, data in
            Task { @MainActor [weak self] in
                await self?.broadcastToDevices(topic: topic, data: RPCValueBridge.pack(data))
            }
        }

        nowPlaying.onNowPlaying = { [weak self] payload in
            Task { @MainActor [weak self] in
                await self?.broadcastToDevices(topic: "media.nowPlaying.update", data: RPCValueBridge.pack(payload))
            }
        }
        nowPlaying.onArtwork = { [weak self] base64 in
            Task { @MainActor [weak self] in
                await self?.broadcastToDevices(topic: "media.nowPlaying.artwork", data: .map([
                    (.string("data"), .string(base64)),
                    (.string("contentType"), .string("image/jpeg"))
                ]))
            }
        }
        nowPlaying.onVolumeChanged = { [weak self] percent in
            self?.queueVolumeUpdate(percent)
        }

        authObservation = spotify.$authState
            .removeDuplicates()
            .sink { [weak self] state in
                Task { @MainActor [weak self] in
                    await self?.handleAuthStateChange(state)
                }
            }
    }

    #if canImport(IOBluetooth)
    func attach(channel: IOBluetoothRFCOMMChannel, address: String) {
        let key = channelKey(address: address, channel: channel)
        if connections[key] != nil { return }

        let client = RPCClient(id: key)
        client.onCall = { [weak self] method, params in
            await self?.handleCall(method: method, params: params) ?? (nil, "manager gone")
        }
        client.onEvent = { [weak self] topic, data in
            self?.handleEvent(topic: topic, data: data)
        }
        // Throws rather than returning: a dropped or half-written message used
        // to look identical to a delivered one from RPCClient's side, so a call
        // waiting on the reply sat out its full 30 s timeout instead of failing
        // at once. Mirrors rpc-client.ts's "Write attempted on closed
        // connection".
        client.onWrite = { [weak self, weak channel] data in
            guard let channel else { throw RPCError.write("channel deallocated") }
            guard channel.isOpen() else { throw RPCError.write("channel closed") }
            let mtu = Int(channel.getMTU())
            let segment = mtu > 0 ? mtu : 1000
            var failure: RPCError?
            data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                guard let base = raw.baseAddress else {
                    failure = .write("unreadable buffer")
                    return
                }
                var offset = 0
                while offset < data.count {
                    let len = min(segment, data.count - offset)
                    let ptr = UnsafeMutableRawPointer(mutating: base.advanced(by: offset))
                    let rc = channel.writeSync(ptr, length: UInt16(len))
                    if rc != kIOReturnSuccess {
                        self?.log.error("RFCOMM writeSync failed rc=\(rc, privacy: .public) len=\(len, privacy: .public) mtu=\(mtu, privacy: .public)")
                        failure = .write("writeSync rc=\(rc) after \(offset) of \(data.count) bytes")
                        return
                    }
                    offset += len
                }
            }
            if let failure { throw failure }
        }

        connections[key] = Connection(address: address, channel: channel, client: client)
        keepAliveFailures[key] = 0
        log.info("RPC client attached: \(key, privacy: .public) (RFCOMM MTU \(channel.getMTU(), privacy: .public))")

        startKeepAliveIfNeeded()

        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            await self?.sendInitialPing(key: key)
        }
    }

    func ingest(_ data: Data, channel: IOBluetoothRFCOMMChannel, address: String) {
        let key = channelKey(address: address, channel: channel)
        if let conn = connections[key] {
            Task { @MainActor in await conn.client.ingest(data) }
        } else {
            attach(channel: channel, address: address)
            if let conn = connections[key] {
                Task { @MainActor in await conn.client.ingest(data) }
            }
        }
    }

    func detach(channel: IOBluetoothRFCOMMChannel, address: String) {
        let key = channelKey(address: address, channel: channel)
        if let conn = connections.removeValue(forKey: key) {
            conn.client.cleanup()
            keepAliveFailures.removeValue(forKey: key)
            log.info("RPC client detached: \(key, privacy: .public)")
        }
        if !connections.values.contains(where: { $0.address == address }) {
            deviceInfoByAddress.removeValue(forKey: address)
            if deviceInfoByAddress.isEmpty {
                deviceInfo = nil
            }
        }
        if connections.isEmpty {
            stopKeepAlive()
        }
    }

    func detachAll(address: String) {
        for (key, conn) in connections where conn.address == address {
            conn.client.cleanup()
            connections.removeValue(forKey: key)
            keepAliveFailures.removeValue(forKey: key)
            log.info("RPC client detached: \(key, privacy: .public)")
        }
        deviceInfoByAddress.removeValue(forKey: address)
        if deviceInfoByAddress.isEmpty {
            deviceInfo = nil
        }
        if connections.isEmpty {
            stopKeepAlive()
        }
    }

    private func channelKey(address: String, channel: IOBluetoothRFCOMMChannel) -> String {
        "\(address)#\(channel.getID())"
    }
    #endif

    private func sendInitialPing(key: String) async {
        guard let conn = connections[key] else { return }
        do {
            _ = try await conn.client.call(
                method: "ping",
                params: .map([(.string("message"), .string("RPi connected"))])
            )
            lastPing = Date()
            log.info("Initial ping sent to \(key, privacy: .public)")
        } catch {
            log.error("Initial ping failed for \(key, privacy: .public): \(error.localizedDescription, privacy: .public)")
            return
        }

        await sendAppReady()
        Task { @MainActor [weak self] in
            for seconds in [2, 5] as [UInt64] {
                try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
                guard let self, self.connections[key] != nil else { return }
                await self.broadcastToDevices(topic: "spotify.auth.status", data: self.spotifyAuthPayload())
            }
        }

        Task { @MainActor [weak self] in
            guard let self, let conn = self.connections[key] else { return }
            do {
                let info = try await conn.client.call(method: "device.info", params: .map([]), timeout: 5)
                guard self.connections[key] != nil else { return }
                let parsed = self.parseDeviceInfo(info)
                self.deviceInfo = parsed
                self.deviceInfoByAddress[conn.address] = parsed
                await self.recordConnectionAnalytics(parsed)
            } catch {
                self.log.warning("device.info failed for \(key, privacy: .public) after app.ready: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    func deviceInfo(for address: String) -> CarThingInfo? {
        deviceInfoByAddress[address] ?? deviceInfo
    }

    private func startKeepAliveIfNeeded() {
        guard keepAliveTask == nil else { return }
        keepAliveTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                guard let self, !Task.isCancelled else { return }
                var staleAddresses = Set<String>()
                for (key, conn) in self.connections {
                    do {
                        _ = try await conn.client.call(
                            method: "ping",
                            params: .map([
                                (.string("message"), .string("keepalive")),
                                (.string("volumePercent"), .int(Int64(self.nowPlaying.currentVolumePercent ?? 50)))
                            ])
                        )
                        self.lastPing = Date()
                        self.keepAliveFailures[key] = 0
                    } catch {
                        let failures = (self.keepAliveFailures[key] ?? 0) + 1
                        self.keepAliveFailures[key] = failures
                        self.log.warning("Keep-alive failed (\(failures, privacy: .public)/\(Self.keepAliveFailureLimit, privacy: .public)) for \(key, privacy: .public): \(error.localizedDescription, privacy: .public)")
                        if failures >= Self.keepAliveFailureLimit {
                            staleAddresses.insert(conn.address)
                        }
                    }
                }
                for address in staleAddresses {
                    self.log.error("RPC link to \(address, privacy: .public) is unresponsive; tearing it down until the next Car Thing probe")
                    self.onStaleConnection?(address)
                }
                await self.broadcastToDevices(topic: "spotify.auth.status", data: self.spotifyAuthPayload())
            }
        }
    }

    private func stopKeepAlive() {
        keepAliveTask?.cancel()
        keepAliveTask = nil
    }

    private func handleEvent(topic: String, data: MessagePackValue) {
        log.info("daemon → topic=\(topic, privacy: .public)")
        switch topic {
        case "daemon.ready":
            Task { @MainActor [weak self] in await self?.sendAppReady() }
        case "chunk.retransmit_request":
            guard let messageId = data.mapValue("message_id")?.stringValue,
                  let chunkIdx = data.mapValue("chunk_idx")?.intValue else { return }
            let clients = connections.values.map(\.client)
            Task { @MainActor in
                for client in clients {
                    await client.retransmitChunk(messageId: messageId, chunkIndex: chunkIdx)
                }
            }

        case "ota.request_check":
            Task { @MainActor [weak self] in await self?.handleCarThingOtaCheck(data) }

        case "ota.request_install":
            // One install at a time: a second request while one is downloading
            // would race two writers onto the same artifact path.
            if carThingInstallTask != nil {
                log.info("Ignoring duplicate OTA install request while one is active")
                return
            }
            carThingInstallTask = Task { @MainActor [weak self] in
                await self?.handleCarThingOtaInstall(data)
                self?.carThingInstallTask = nil
            }

        case "ota.asset_range":
            Task { @MainActor [weak self] in await self?.handleCarThingAssetRange(data) }

        case "ota.asset_range_abandon":
            guard let requestId = Self.stringParam(data, "requestId", "request_id") else { return }
            carThingRangeTasks.removeValue(forKey: requestId)?.cancel()

        case "ota.complete":
            cancelCarThingRangeTasks()
            activeCarThingUpdate = nil
            Task { [carThingOta] in await carThingOta.clearActiveUpdate(deleteArtifact: true) }

        case "ota.error":
            cancelCarThingRangeTasks()

        default:
            break
        }
    }

    // MARK: - Car Thing OTA (v2 manifest)

    private func cancelCarThingRangeTasks() {
        for (_, task) in carThingRangeTasks { task.cancel() }
        carThingRangeTasks.removeAll()
    }

    /// The device drives OTA over one link, so any connected client will do.
    private func otaClient() -> RPCClient? {
        connections.values.first?.client
    }

    private static func stringParam(_ value: MessagePackValue, _ camel: String, _ snake: String) -> String? {
        value.mapValue(camel)?.stringValue ?? value.mapValue(snake)?.stringValue
    }

    /// The device may or may not restate its versions in the request; fall back
    /// to what it told us in device.info. Pre-4.1 firmware has only `version`,
    /// and CarThingOtaVersionLanes puts all three lanes there.
    private func carThingLanes(_ params: MessagePackValue) -> CarThingOtaVersionLanes? {
        let info = deviceInfo ?? deviceInfoByAddress.values.first
        return CarThingOtaVersionLanes(
            currentVersion: Self.stringParam(params, "currentVersion", "current_version") ?? info?.version,
            imageVersion: Self.stringParam(params, "imageVersion", "image_version") ?? info?.imageVersion,
            bandaidVersion: Self.stringParam(params, "bandaidVersion", "bandaid_version") ?? info?.bandaidVersion
        )
    }

    private func handleCarThingOtaCheck(_ params: MessagePackValue) async {
        guard let client = otaClient() else { return }
        let channel = params.mapValue("channel")?.stringValue ?? "stable"

        guard let lanes = carThingLanes(params) else {
            await client.sendEvent(topic: "ota.check_result", data: .map([
                (.string("available"), .bool(false)),
                (.string("channel"), .string(channel)),
                (.string("requiresReflash"), .bool(false)),
                (.string("error"), .string("Device version is unavailable"))
            ]))
            return
        }

        do {
            let check = try await carThingOta.checkUpdate(
                currentVersion: lanes.currentVersion,
                channel: channel,
                imageVersion: lanes.imageVersion,
                bandaidVersion: lanes.bandaidVersion
            )
            await sendCarThingCheckResult(client, update: check.update, channel: check.channel)
        } catch {
            log.error("Car Thing OTA check failed: \(error.localizedDescription, privacy: .public)")
            await client.sendEvent(topic: "ota.check_result", data: .map([
                (.string("available"), .bool(false)),
                (.string("channel"), .string(channel)),
                (.string("requiresReflash"), .bool(false)),
                (.string("error"), .string(error.localizedDescription))
            ]))
        }
    }

    private func sendCarThingCheckResult(
        _ client: RPCClient,
        update: CarThingAvailableUpdate?,
        channel: String
    ) async {
        await client.sendEvent(topic: "ota.check_result", data: .map([
            (.string("available"), .bool(update != nil)),
            (.string("version"), update.map { .string($0.version) } ?? .nilValue),
            (.string("kind"), update.map { .string($0.kind.rawValue) } ?? .nilValue),
            (.string("channel"), .string(channel)),
            (.string("requiresReflash"), .bool(update?.requiresReflash ?? false)),
            (.string("flashthingZipUrl"), update?.flashthingZipURL.map { .string($0) } ?? .nilValue)
        ]))
    }

    private func handleCarThingOtaInstall(_ params: MessagePackValue) async {
        guard let client = otaClient() else { return }
        let channel = params.mapValue("channel")?.stringValue ?? "stable"
        var beganUpdateId: String?

        do {
            guard let lanes = carThingLanes(params) else {
                throw RPCDispatchError("Device version is unavailable")
            }
            let check = try await carThingOta.checkUpdate(
                currentVersion: lanes.currentVersion,
                channel: channel,
                imageVersion: lanes.imageVersion,
                bandaidVersion: lanes.bandaidVersion
            )
            guard let update = check.update else {
                throw RPCDispatchError("No update is available to install")
            }

            // The device asked to install something specific. If the manifest
            // has moved on since its check, tell it what is actually there
            // rather than installing a different build under the old label.
            let wantVersion = Self.stringParam(params, "targetVersion", "target_version")
            let wantKind = Self.stringParam(params, "targetKind", "target_kind")
            if (wantVersion != nil && wantVersion != update.version)
                || (wantKind != nil && wantKind != update.kind.rawValue) {
                await sendCarThingCheckResult(client, update: update, channel: check.channel)
                log.warning("Refusing changed OTA target \(wantVersion ?? "*", privacy: .public)/\(wantKind ?? "*", privacy: .public); latest is \(update.version, privacy: .public)/\(update.kind.rawValue, privacy: .public)")
                return
            }
            if update.requiresReflash {
                throw RPCDispatchError("This update requires a full reflash")
            }

            let begin = try await client.call(method: "ota.begin", params: .map([
                (.string("kind"), .string(update.kind.rawValue)),
                (.string("updateId"), .string(update.updateId)),
                (.string("updateUrlBase"), .string(update.updateUrlBase)),
                (.string("expectedSha256"), .string(update.expectedSha256)),
                (.string("expectedSize"), .int(Int64(update.expectedSize)))
            ]))
            beganUpdateId = update.updateId
            let resumeFromOffset = begin.mapValue("resumeFromOffset")?.intValue
                ?? begin.mapValue("resume_from_offset")?.intValue ?? 0

            // Progress is rate-limited to every 5% or 15 s: each report is an
            // RPC round trip over a 2 KB/s-ish RFCOMM link shared with the
            // download it is reporting on.
            let reporter = OTAProgressReporter(client: client, updateId: update.updateId, log: log)
            _ = try await carThingOta.preparePrimaryArtifact(update) { downloaded, total in
                await reporter.report(downloaded: downloaded, total: total)
            }

            try await carThingOta.rememberActiveUpdate(update)
            activeCarThingUpdate = update

            // The negotiation fields are the whole point of this event. 4.1
            // reads them at msgpack.rs:598-639; omit them and it falls back to
            // OTA_LEGACY_PULL_SIZE — 1800-byte windows instead of 128 KiB, i.e.
            // a transfer roughly 70x slower.
            await client.sendEvent(topic: "ota.package_ready", data: .map([
                (.string("updateId"), .string(update.updateId)),
                (.string("version"), .string(update.version)),
                (.string("size"), .int(Int64(update.expectedSize))),
                (.string("expectedSha256"), .string(update.expectedSha256)),
                (.string("resumeFromOffset"), .int(Int64(resumeFromOffset))),
                (.string("maxTransferChunkSize"), .int(Int64(OTATransfer.maxWindowBytes))),
                (.string("supportsChunkedTransferResponse"), .bool(true)),
                (.string("transferDataEncoding"), .string("msgpack_binary"))
            ]))
        } catch {
            log.error("Car Thing OTA install failed: \(error.localizedDescription, privacy: .public)")
            // The device is holding a slot open for an update that is not
            // coming; tell it so rather than leaving it to time out.
            if let beganUpdateId {
                _ = try? await client.call(method: "ota.abandon", params: .map([
                    (.string("updateId"), .string(beganUpdateId))
                ]))
            }
        }
    }

    private func handleCarThingAssetRange(_ params: MessagePackValue) async {
        guard let client = otaClient() else { return }
        guard let requestId = Self.stringParam(params, "requestId", "request_id") else { return }

        carThingRangeTasks.removeValue(forKey: requestId)?.cancel()
        let task = Task { @MainActor [weak self] () -> Void in
            await self?.serveCarThingAssetRange(client, requestId: requestId, params: params)
        }
        carThingRangeTasks[requestId] = task
        await task.value
        if carThingRangeTasks[requestId] == task { carThingRangeTasks[requestId] = nil }
    }

    private func serveCarThingAssetRange(
        _ client: RPCClient,
        requestId: String,
        params: MessagePackValue
    ) async {
        var replied = false
        var failurePartIndex = 0
        var failureOffset = 0

        do {
            let update: CarThingAvailableUpdate
            if let active = activeCarThingUpdate {
                update = active
            } else if let persisted = await carThingOta.activeUpdate() {
                activeCarThingUpdate = persisted
                update = persisted
            } else {
                throw RPCDispatchError("No active OTA range session")
            }

            let updateId = Self.stringParam(params, "updateId", "update_id")
            guard updateId == update.updateId else {
                throw RPCDispatchError("Unknown OTA update ID")
            }
            let assetName = params.mapValue("asset")?.stringValue
            guard let asset = update.rangeAssets.first(where: { $0.name == assetName }) else {
                throw RPCDispatchError("Unknown OTA range asset \(assetName ?? "")")
            }
            let ranges = try Self.parseRanges(params.mapValue("ranges"), asset: asset)

            _ = try await client.call(method: "ota.asset_range_reply", params: .map([
                (.string("requestId"), .string(requestId)),
                (.string("totalSize"), .int(Int64(asset.size))),
                (.string("parts"), .array(ranges.map { range in
                    .map([
                        (.string("start"), .int(Int64(range.start))),
                        (.string("length"), .int(Int64(range.length)))
                    ])
                }))
            ]))
            replied = true

            for (partIndex, range) in ranges.enumerated() {
                var cursor = 0
                while cursor < range.length {
                    if Task.isCancelled { return }
                    let length = min(OTATransfer.maxWindowBytes, range.length - cursor)
                    let offset = range.start + cursor
                    failurePartIndex = partIndex
                    failureOffset = offset
                    let bytes = try await carThingOta.fetchAssetRange(
                        update, asset: asset, start: offset, length: length
                    )
                    cursor += length
                    let last = partIndex == ranges.count - 1 && cursor == range.length
                    _ = try await client.call(method: "ota.asset_range_chunk", params: .map([
                        (.string("requestId"), .string(requestId)),
                        (.string("partIndex"), .int(Int64(partIndex))),
                        (.string("offset"), .int(Int64(offset))),
                        (.string("bytes"), .data(bytes)),
                        (.string("last"), .bool(last))
                    ]), timeout: 60)
                    // Breathing room for the device to flush to flash before the
                    // next window lands.
                    if !last { try? await Task.sleep(nanoseconds: 15_000_000) }
                }
            }
        } catch {
            if Task.isCancelled { return }
            log.error("OTA asset range \(requestId, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            // Once the reply has gone out the device is waiting for chunks, so
            // the only way to end the transfer is an empty final chunk;
            // before that, an outright rejection is still possible.
            if replied {
                _ = try? await client.call(method: "ota.asset_range_chunk", params: .map([
                    (.string("requestId"), .string(requestId)),
                    (.string("partIndex"), .int(Int64(failurePartIndex))),
                    (.string("offset"), .int(Int64(failureOffset))),
                    (.string("bytes"), .data(Data())),
                    (.string("last"), .bool(true))
                ]))
            } else {
                _ = try? await client.call(method: "ota.asset_range_rejected", params: .map([
                    (.string("requestId"), .string(requestId)),
                    (.string("reason"), .string(error.localizedDescription))
                ]))
            }
        }
    }

    private static func parseRanges(
        _ value: MessagePackValue?,
        asset: CarThingOtaAsset
    ) throws -> [(start: Int, length: Int)] {
        guard let entries = value?.arrayValue, !entries.isEmpty else {
            throw RPCDispatchError("OTA range request has no ranges")
        }
        return try entries.enumerated().map { index, entry in
            let start = entry.mapValue("start")?.intValue ?? -1
            let length = entry.mapValue("length")?.intValue ?? -1
            guard start >= 0, length > 0, start + length <= asset.size else {
                throw RPCDispatchError("Invalid OTA range \(index) for \(asset.name)")
            }
            return (start, length)
        }
    }

    private func sendAppReady() async {
        let now = Date()
        let tz = TimeZone.current

        let authState = spotify.authState
        await broadcastToDevices(topic: "spotify.auth.status", data: spotifyAuthPayload(for: authState))

        await broadcastToDevices(topic: "app.ready", data: .map([
            (.string("platform"), .string("web")),
            (.string("timestamp"), .int(Int64(now.timeIntervalSince1970 * 1000))),
            (.string("spotifySkipped"), .bool(authState.isSkipped)),
            (.string("datetime"), .string(Self.utcDatetimeString(now))),
            (.string("time"), .string(Self.localTimeString(now))),
            (.string("timezone"), .map([
                (.string("identifier"), .string(tz.identifier)),
                (.string("secondsFromGMT"), .int(Int64(tz.secondsFromGMT(for: now)))),
                (.string("abbreviation"), .string(tz.abbreviation(for: now) ?? "")),
                (.string("isDaylightSavingTime"), .bool(tz.isDaylightSavingTime(for: now)))
            ]))
        ]))
        log.info("Sent app.ready to \(self.connections.count, privacy: .public) device(s)")

        nowPlaying.replayLatest()
        if let percent = nowPlaying.currentVolumePercent {
            await sendVolumeUpdate(percent)
        }
    }

    private func queueVolumeUpdate(_ percent: Int) {
        pendingVolumePercent = percent
        guard volumeReportTask == nil else { return }
        volumeReportTask = Task { @MainActor [weak self] in
            while true {
                guard let self, let percent = self.pendingVolumePercent else { break }
                self.pendingVolumePercent = nil
                await self.sendVolumeUpdate(percent)
            }
            self?.volumeReportTask = nil
        }
    }

    private func sendVolumeUpdate(_ percent: Int) async {
        for (_, conn) in connections {
            do {
                _ = try await conn.client.call(
                    method: "device.volume.update",
                    params: .map([(.string("volumePercent"), .int(Int64(percent)))]),
                    timeout: 5
                )
            } catch {
                log.warning("device.volume.update failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private func handleAuthStateChange(_ state: SpotifyAuthState) async {
        await broadcastToDevices(topic: "spotify.auth.status", data: spotifyAuthPayload(for: state))

        switch state {
        case .loading, .polling:
            await broadcastToDevices(topic: "spotify.auth.started", data: .map([
                (.string("status"), .string("authorization_started"))
            ]))
        case .linked:
            await broadcastToDevices(topic: "spotify.auth.completed", data: .map([
                (.string("authenticated"), .bool(true))
            ]))
        default:
            break
        }
    }

    private func spotifyAuthPayload(for state: SpotifyAuthState? = nil) -> MessagePackValue {
        switch state ?? spotify.authState {
        case .linked:
            return .map([
                (.string("authenticated"), .bool(true)),
                (.string("skipped"), .bool(false)),
                (.string("needsAuthorization"), .bool(false))
            ])
        case .skipped:
            return .map([
                (.string("authenticated"), .bool(false)),
                (.string("skipped"), .bool(true))
            ])
        case .loading:
            return .map([
                (.string("authenticated"), .bool(false)),
                (.string("skipped"), .bool(false)),
                (.string("loading"), .bool(true)),
                (.string("needsAuthorization"), .bool(false))
            ])
        case .polling:
            return .map([
                (.string("authenticated"), .bool(false)),
                (.string("skipped"), .bool(false)),
                (.string("authorizationInProgress"), .bool(true))
            ])
        case .idle:
            return .map([
                (.string("authenticated"), .bool(false)),
                (.string("skipped"), .bool(false)),
                (.string("needsAuthorization"), .bool(true))
            ])
        }
    }

    private func broadcastToDevices(topic: String, data: MessagePackValue) async {
        for (_, conn) in connections {
            await conn.client.sendEvent(topic: topic, data: data)
        }
    }

    private func handleCall(method: String, params: MessagePackValue) async -> (result: MessagePackValue?, error: String?) {
        log.info("RPC call: \(method, privacy: .public)")
        do {
            if let result = try await dispatch(method: method, params: params) {
                return (result, nil)
            }
            log.warning("Unknown method: \(method, privacy: .public)")
            return (nil, "Unknown method: \(method)")
        } catch {
            log.error("RPC call \(method, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
            return (nil, error.localizedDescription)
        }
    }

    private func dispatch(method: String, params: MessagePackValue) async throws -> MessagePackValue? {
        switch method {
        case "ping":
            let message = params.mapValue("message")?.stringValue ?? "pong"
            return .map([(.string("pong"), .string(message))])

        case "device.info":
            return .map([
                (.string("device"), .string("nocturne-connector")),
                (.string("version"), .string(AppConfig.connectorVersion))
            ])

        // Answered here rather than through the registry, so it needs the alias
        // spelling explicitly.
        case "spotify.auth.getStatus", "spotify.auth.get_status":
            return spotifyAuthPayload()

        case "device.ota.check":
            let currentVersion = params.mapValue("currentVersion")?.stringValue ?? "unknown"
            let check = try await ota.checkForUpdates(currentVersion: currentVersion, channel: "beta")
            let metadata: MessagePackValue = check.metadata.map {
                .map([
                    (.string("auto_updateable"), .bool($0.autoUpdateable)),
                    (.string("critical"), .bool($0.critical))
                ])
            } ?? .nilValue
            return .map([
                (.string("updateAvailable"), .bool(check.updateAvailable)),
                (.string("version"), check.version.map { .string($0) } ?? .nilValue),
                (.string("channel"), check.channel.map { .string($0) } ?? .nilValue),
                (.string("metadata"), metadata)
            ])

        case "device.ota.download":
            let currentVersion = params.mapValue("currentVersion")?.stringValue ?? "unknown"
            let targetVersion = params.mapValue("targetVersion")?.stringValue ?? "unknown"
            let fileURL = try await ota.downloadUpdate(currentVersion: currentVersion, targetVersion: targetVersion)
            downloadedOTAFileURL = fileURL
            let size = try ota.fileSize(at: fileURL)
            let md5 = try await ota.calculateMD5(at: fileURL)
            await broadcastToDevices(topic: "device.ota.package_state", data: .map([
                (.string("state"), .string("download_success")),
                (.string("name"), .string("nocturne-os")),
                (.string("version"), .string(targetVersion)),
                (.string("hash"), .string(md5)),
                (.string("size"), .int(Int64(size)))
            ]))
            return .map([
                (.string("success"), .bool(true)),
                (.string("message"), .string("Update downloaded, ready for transfer"))
            ])

        case "device.ota.transfer":
            guard let fileURL = downloadedOTAFileURL else {
                throw RPCDispatchError("No OTA file available")
            }
            let offset = params.mapValue("offset")?.intValue ?? 0
            let size = params.mapValue("size")?.intValue ?? 31680
            let chunk = try await ota.readChunk(at: fileURL, offset: offset, size: size)
            return .map([(.string("data"), .string(chunk))])

        case "device.timezone.get":
            let tz = TimeZone.current
            return .map([
                (.string("identifier"), .string(tz.identifier)),
                (.string("secondsFromGMT"), .int(Int64(tz.secondsFromGMT(for: Date())))),
                (.string("abbreviation"), .string("")),
                (.string("isDaylightSavingTime"), .bool(false))
            ])

        case "device.time.get":
            let now = Date()
            return .map([
                (.string("datetime"), .string(Self.utcDatetimeString(now))),
                (.string("time"), .string(Self.localTimeString(now)))
            ])

        default:
            if method.hasPrefix("media.control.") {
                return RPCValueBridge.pack(nowPlaying.handleMediaControl(method))
            }
            if method.hasPrefix("spotify.") {
                let result = try await spotify.dispatch(method, params: RPCValueBridge.dictionary(params))
                return RPCValueBridge.pack(result)
            }
            if method.hasPrefix("claude.") {
                let result = try await claudeRelay.call(method, params: RPCValueBridge.dictionary(params))
                return ClaudeRelayService.packJSON(result)
            }
            return nil
        }
    }

    private func parseDeviceInfo(_ value: MessagePackValue) -> CarThingInfo {
        // 4.1 canonicalised these to snake_case and only down-converts for web
        // companions, so read either spelling rather than betting on which side
        // of that conversion a given daemon build sits. Mirrors
        // normalizeDeviceInfo in nocturne-manager.ts.
        func field(_ camel: String, _ snake: String) -> String? {
            value.mapValue(camel)?.stringValue ?? value.mapValue(snake)?.stringValue
        }
        return CarThingInfo(
            device: value.mapValue("device")?.stringValue,
            version: value.mapValue("version")?.stringValue,
            fullVersion: field("fullVersion", "full_version"),
            imageVersion: field("imageVersion", "image_version"),
            bandaidVersion: field("bandaidVersion", "bandaid_version"),
            buildDate: field("buildDate", "build_date"),
            gitHash: field("gitHash", "git_hash"),
            serialNumber: field("serialNumber", "serial_number")
        )
    }

    private func recordConnectionAnalytics(_ info: CarThingInfo) async {
        guard let analytics else { return }
        let serial = (info.serialNumber?.isEmpty == false) ? info.serialNumber! : "unknown"
        let firmwareVersion = (info.version?.isEmpty == false) ? info.version! : "unknown"
        let shortSerial = serial.count >= 4 ? String(serial.suffix(4)) : serial
        let deviceName = "Nocturne (\(shortSerial))"
        let userID = currentUserID()

        await analytics.recordDailyActive(
            deviceSerial: serial,
            userId: userID,
            appVersion: AppConfig.connectorVersion,
            firmwareVersion: firmwareVersion,
            phoneVersion: "Connector"
        )

        await analytics.trackEvent(
            deviceSerial: serial,
            userId: userID,
            eventType: "connection.established",
            eventData: [
                "device": deviceName,
                "mfi_serial": serial,
                "firmware_version": firmwareVersion,
            ]
        )
    }

    private static let utcDatetimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        f.timeZone = TimeZone(identifier: "UTC")
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static let localTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    private static func utcDatetimeString(_ date: Date) -> String {
        utcDatetimeFormatter.string(from: date)
    }

    private static func localTimeString(_ date: Date) -> String {
        localTimeFormatter.string(from: date)
    }
}

struct RPCDispatchError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
