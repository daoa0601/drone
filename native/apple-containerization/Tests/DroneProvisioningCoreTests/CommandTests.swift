import DroneProvisioningCore
import Testing

@Suite("provisioner command contract")
struct ProvisioningCommandTests {
  private let digest = String(repeating: "a", count: 64)

  @Test("requires an immutable init image reference")
  func immutableInitImage() throws {
    let command = try ProvisioningCommand.parse([
      "prepare-initfs",
      "/private/tmp/store",
      "ghcr.io/apple/containerization/vminit@sha256:\(digest)",
      "/private/tmp/initfs.ext4",
    ])
    #expect(
      command
        == .prepareInitFS(
          storeRoot: "/private/tmp/store",
          reference: "ghcr.io/apple/containerization/vminit@sha256:\(digest)",
          output: "/private/tmp/initfs.ext4"
        )
    )
    #expect(throws: ProvisioningContractError.invalid("reference")) {
      try ProvisioningCommand.parse([
        "prepare-initfs",
        "/private/tmp/store",
        "ghcr.io/apple/containerization/vminit:0.35.0",
        "/private/tmp/initfs.ext4",
      ])
    }
  }

  @Test("requires absolute filesystem paths")
  func absolutePaths() {
    #expect(throws: ProvisioningContractError.invalid("store-root")) {
      try ProvisioningCommand.parse(["load-oci", "relative", "/private/tmp/image.tar"])
    }
    #expect(throws: ProvisioningContractError.invalid("archive")) {
      try ProvisioningCommand.parse(["load-oci", "/private/tmp/store", "image.tar"])
    }
  }

  @Test("rejects unknown shapes")
  func rejectsUnknownShapes() {
    #expect(throws: ProvisioningContractError.usage) {
      try ProvisioningCommand.parse([])
    }
    #expect(throws: ProvisioningContractError.usage) {
      try ProvisioningCommand.parse(["pull", "anything"])
    }
  }
}
