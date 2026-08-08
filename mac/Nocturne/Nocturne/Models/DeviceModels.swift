import Foundation

struct CarThingInfo: Equatable {
    var device: String?
    var version: String?
    var fullVersion: String?
    // 4.1 updates three things on independent version lanes — the rootfs image,
    // the bandaid overlay, and the daemon — so a single `version` is no longer
    // enough to ask the OTA server what is missing. Both are absent on older
    // firmware, where they fall back to `version`.
    var imageVersion: String?
    var bandaidVersion: String?
    var buildDate: String?
    var gitHash: String?
    var serialNumber: String?
}

struct ConnectedDevice: Identifiable, Equatable {
    let id: String
    let address: String
    var info: CarThingInfo?
}

struct ConnectorInfo: Equatable {
    let version: String
    let osVersion: String
}
