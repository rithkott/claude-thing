import Foundation

// The transfer window the connector is willing to serve in one reply.
//
// The device asks for a window and we hand back that many bytes, so an
// unbounded ask is an unbounded allocation on this side. 4.1's daemon caps its
// own pull at OTA_MAX_PULL_WINDOW_SIZE (256 KiB) and falls back to
// OTA_LEGACY_PULL_SIZE (1800 B) when a companion advertises nothing; upstream's
// own guard is the tighter 128 KiB, and matching upstream is what keeps a
// device that trusts maxTransferChunkSize from ever being told more than the
// connector will actually serve.
//
// Port of ota-transfer.ts.
enum OTATransfer {
    static let maxWindowBytes = 128 * 1024

    @discardableResult
    static func requireWindow(_ size: Int) throws -> Int {
        guard size > 0, size <= maxWindowBytes else {
            throw OTAError("Invalid OTA transfer size \(size)")
        }
        return size
    }
}
