import Foundation

public enum ProvisioningCommand: Equatable, Sendable {
  case prepareInitFS(storeRoot: String, reference: String, output: String)
  case loadOCI(storeRoot: String, archive: String)
  case listImages(storeRoot: String)

  public static func parse(_ arguments: [String]) throws -> Self {
    guard let command = arguments.first else {
      throw ProvisioningContractError.usage
    }
    switch (command, Array(arguments.dropFirst())) {
    case ("prepare-initfs", let values) where values.count == 3:
      let storeRoot = values[0]
      let reference = values[1]
      let output = values[2]
      try validateAbsolutePath(storeRoot, field: "store-root")
      try validateExactReference(reference)
      try validateAbsolutePath(output, field: "output")
      return .prepareInitFS(storeRoot: storeRoot, reference: reference, output: output)
    case ("load-oci", let values) where values.count == 2:
      let storeRoot = values[0]
      let archive = values[1]
      try validateAbsolutePath(storeRoot, field: "store-root")
      try validateAbsolutePath(archive, field: "archive")
      return .loadOCI(storeRoot: storeRoot, archive: archive)
    case ("list", let values) where values.count == 1:
      try validateAbsolutePath(values[0], field: "store-root")
      return .listImages(storeRoot: values[0])
    default:
      throw ProvisioningContractError.usage
    }
  }

  public static let usage = """
    usage:
      drone-provisioner prepare-initfs <absolute-store-root> <exact-image@sha256:digest> <absolute-output>
      drone-provisioner load-oci <absolute-store-root> <absolute-oci-tar>
      drone-provisioner list <absolute-store-root>
    """

  private static func validateAbsolutePath(_ value: String, field: String) throws {
    guard value.hasPrefix("/"), !value.contains("\0") else {
      throw ProvisioningContractError.invalid(field)
    }
  }

  private static func validateExactReference(_ value: String) throws {
    let pattern =
      #"^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$"#
    guard value.range(of: pattern, options: .regularExpression) != nil else {
      throw ProvisioningContractError.invalid("reference")
    }
  }
}

public enum ProvisioningContractError: Error, Equatable, LocalizedError {
  case invalid(String)
  case usage

  public var errorDescription: String? {
    switch self {
    case .invalid(let field):
      "Invalid provisioning field: \(field)"
    case .usage:
      ProvisioningCommand.usage
    }
  }
}
