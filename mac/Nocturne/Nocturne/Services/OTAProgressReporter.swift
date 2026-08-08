import Foundation
import os

/// Rate-limits ota.download_progress.
///
/// Each report is an RPC round trip over the same ~2 KB/s RFCOMM link the
/// download is competing with, so reporting every callback would slow the very
/// transfer it describes. Mirrors nocturne-manager.ts: emit at 100%, or when
/// the percentage has moved 5 points, or after 15 s of silence.
actor OTAProgressReporter {
    private let client: RPCClient
    private let updateId: String
    private let log: Logger
    private var lastPercent = -1
    private var lastReportedAt = Date.distantPast

    init(client: RPCClient, updateId: String, log: Logger) {
        self.client = client
        self.updateId = updateId
        self.log = log
    }

    func report(downloaded: Int, total: Int) async {
        let percent = total > 0 ? Int((Double(downloaded) / Double(total)) * 100) : 0
        let now = Date()
        if percent < 100,
           percent < lastPercent + 5,
           now.timeIntervalSince(lastReportedAt) < 15 {
            return
        }
        lastPercent = percent
        lastReportedAt = now
        do {
            _ = try await client.call(method: "ota.download_progress", params: .map([
                (.string("updateId"), .string(updateId)),
                (.string("percent"), .int(Int64(percent)))
            ]))
        } catch {
            log.warning("OTA download progress report failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
