import Foundation

public enum NativeContractError: Error, Equatable, LocalizedError {
  case invalid(String)

  public var errorDescription: String? {
    switch self {
    case .invalid(let field):
      "Invalid native sandbox request field: \(field)"
    }
  }
}

public struct NativeInput: Codable, Sendable {
  public let name: String
  public let hostPath: String
  public let sha256: String
  public let sizeBytes: Int

  enum CodingKeys: String, CodingKey {
    case name
    case hostPath = "host_path"
    case sha256
    case sizeBytes = "size_bytes"
  }
}

public struct NativeOutputDeclaration: Codable, Sendable {
  public let name: String
  public let required: Bool
  public let maxBytes: Int

  enum CodingKeys: String, CodingKey {
    case name
    case required
    case maxBytes = "max_bytes"
  }
}

public struct NativeRequest: Codable, Sendable {
  public let protocolVersion: String
  public let containerID: String
  public let providerAttestationID: String
  public let attestationChallenge: String
  public let imageReference: String
  public let imageStoreRoot: String
  public let kernelPath: String
  public let initfsPath: String
  public let workRoot: String
  public let outputDirectory: String
  public let command: [String]
  public let environment: [String]
  public let architecture: String
  public let uid: Int
  public let gid: Int
  public let cpus: Int
  public let memoryBytes: Int
  public let rootfsBytes: Int
  public let writableLayerBytes: Int
  public let outputDiskBytes: Int
  public let timeoutSeconds: Int
  public let maxLogBytes: Int
  public let maxProcesses: Int
  public let maxOpenFiles: Int
  public let inputs: [NativeInput]
  public let outputs: [NativeOutputDeclaration]

  enum CodingKeys: String, CodingKey {
    case protocolVersion = "protocol_version"
    case containerID = "container_id"
    case providerAttestationID = "provider_attestation_id"
    case attestationChallenge = "attestation_challenge"
    case imageReference = "image_reference"
    case imageStoreRoot = "image_store_root"
    case kernelPath = "kernel_path"
    case initfsPath = "initfs_path"
    case workRoot = "work_root"
    case outputDirectory = "output_directory"
    case command
    case environment
    case architecture
    case uid
    case gid
    case cpus
    case memoryBytes = "memory_bytes"
    case rootfsBytes = "rootfs_bytes"
    case writableLayerBytes = "writable_layer_bytes"
    case outputDiskBytes = "output_disk_bytes"
    case timeoutSeconds = "timeout_seconds"
    case maxLogBytes = "max_log_bytes"
    case maxProcesses = "max_processes"
    case maxOpenFiles = "max_open_files"
    case inputs
    case outputs
  }

  public func validate() throws {
    guard protocolVersion == "1" else { throw NativeContractError.invalid("protocol_version") }
    guard Self.matches(containerID, pattern: #"^drone-[a-f0-9]{24}$"#) else {
      throw NativeContractError.invalid("container_id")
    }
    guard
      Self.matches(
        providerAttestationID,
        pattern: #"^attestation\.sha256\.[a-f0-9]{64}$"#
      )
    else {
      throw NativeContractError.invalid("provider_attestation_id")
    }
    guard Self.matches(attestationChallenge, pattern: #"^[a-f0-9]{64}$"#) else {
      throw NativeContractError.invalid("attestation_challenge")
    }
    guard
      Self.matches(
        imageReference,
        pattern:
          #"^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$"#
      )
    else {
      throw NativeContractError.invalid("image_reference")
    }
    for (name, value) in [
      ("image_store_root", imageStoreRoot),
      ("kernel_path", kernelPath),
      ("initfs_path", initfsPath),
      ("work_root", workRoot),
      ("output_directory", outputDirectory),
    ] {
      guard value.hasPrefix("/"), !value.contains("\0") else {
        throw NativeContractError.invalid(name)
      }
    }
    guard !command.isEmpty, command.count <= 64 else {
      throw NativeContractError.invalid("command")
    }
    guard command.allSatisfy({ !$0.isEmpty && $0.count <= 2048 && !$0.contains("\0") }) else {
      throw NativeContractError.invalid("command")
    }
    guard environment.count <= 35,
      environment.allSatisfy({
        Self.matches($0, pattern: #"^[A-Z_][A-Z0-9_]{0,63}=.{0,2048}$"#) && !$0.contains("\0")
      })
    else {
      throw NativeContractError.invalid("environment")
    }
    guard architecture == "arm64" || architecture == "amd64" else {
      throw NativeContractError.invalid("architecture")
    }
    guard (1...Int(UInt32.max)).contains(uid), (1...Int(UInt32.max)).contains(gid) else {
      throw NativeContractError.invalid("user")
    }
    guard (1...16).contains(cpus) else { throw NativeContractError.invalid("cpus") }
    guard (128 * Self.mib...65_536 * Self.mib).contains(memoryBytes) else {
      throw NativeContractError.invalid("memory_bytes")
    }
    guard (128 * Self.mib...65_536 * Self.mib).contains(rootfsBytes) else {
      throw NativeContractError.invalid("rootfs_bytes")
    }
    guard (16 * Self.mib...16_384 * Self.mib).contains(writableLayerBytes) else {
      throw NativeContractError.invalid("writable_layer_bytes")
    }
    guard (16 * Self.mib...4_096 * Self.mib).contains(outputDiskBytes) else {
      throw NativeContractError.invalid("output_disk_bytes")
    }
    guard (1...3_600).contains(timeoutSeconds) else {
      throw NativeContractError.invalid("timeout_seconds")
    }
    guard (1_024...Self.mib).contains(maxLogBytes) else {
      throw NativeContractError.invalid("max_log_bytes")
    }
    guard (1...1_024).contains(maxProcesses), (16...4_096).contains(maxOpenFiles) else {
      throw NativeContractError.invalid("rlimits")
    }
    guard inputs.count <= 16, outputs.count <= 16 else {
      throw NativeContractError.invalid("exchange_declarations")
    }
    var inputNames = Set<String>()
    for input in inputs {
      guard Self.safeName(input.name), inputNames.insert(input.name).inserted else {
        throw NativeContractError.invalid("inputs.name")
      }
      guard input.hostPath.hasPrefix("/"), !input.hostPath.contains("\0") else {
        throw NativeContractError.invalid("inputs.host_path")
      }
      guard Self.matches(input.sha256, pattern: #"^[a-f0-9]{64}$"#),
        (1...1_073_741_824).contains(input.sizeBytes)
      else {
        throw NativeContractError.invalid("inputs.identity")
      }
    }
    var outputNames = Set<String>()
    var declaredOutputBytes = 0
    for output in outputs {
      guard Self.safeName(output.name), outputNames.insert(output.name).inserted else {
        throw NativeContractError.invalid("outputs.name")
      }
      guard (1...256 * Self.mib).contains(output.maxBytes) else {
        throw NativeContractError.invalid("outputs.max_bytes")
      }
      declaredOutputBytes += output.maxBytes
    }
    guard declaredOutputBytes <= outputDiskBytes - Self.mib else {
      throw NativeContractError.invalid("outputs.capacity")
    }
  }

  private static let mib = 1_048_576

  private static func safeName(_ value: String) -> Bool {
    matches(value, pattern: #"^[a-z][a-z0-9_-]{0,63}$"#)
  }

  private static func matches(_ value: String, pattern: String) -> Bool {
    value.range(of: pattern, options: .regularExpression) != nil
  }
}

public struct NativeExecutionAttestation: Codable, Sendable {
  public let schemaVersion = "1"
  public let profile = "apple_native_no_network_vm_v1"
  public let providerAttestationID: String
  public let challenge: String
  public let containerID: String
  public let imageReference: String
  public let backend = "apple_containerization"
  public let isolation = "lightweight_vm"
  public let guestOS = "linux"
  public let networkMode = "none"
  public let ephemeralVM = true
  public let readOnlyRoot = true
  public let inputDiskReadOnly = true
  public let outputDiskBounded = true
  public let hostDirectorySharing = false
  public let socketSharing = false
  public let nestedVirtualization = false
  public let nonRootRequired = true
  public let noNewPrivileges = true
  public let capabilities = "none"

  public init(request: NativeRequest) {
    providerAttestationID = request.providerAttestationID
    challenge = request.attestationChallenge
    containerID = request.containerID
    imageReference = request.imageReference
  }

  enum CodingKeys: String, CodingKey {
    case schemaVersion = "schema_version"
    case profile
    case providerAttestationID = "provider_attestation_id"
    case challenge
    case containerID = "container_id"
    case imageReference = "image_reference"
    case backend
    case isolation
    case guestOS = "guest_os"
    case networkMode = "network_mode"
    case ephemeralVM = "ephemeral_vm"
    case readOnlyRoot = "read_only_root"
    case inputDiskReadOnly = "input_disk_read_only"
    case outputDiskBounded = "output_disk_bounded"
    case hostDirectorySharing = "host_directory_sharing"
    case socketSharing = "socket_sharing"
    case nestedVirtualization = "nested_virtualization"
    case nonRootRequired = "non_root_required"
    case noNewPrivileges = "no_new_privileges"
    case capabilities
  }
}

public struct NativeOutputResult: Codable, Sendable {
  public let name: String
  public let hostPath: String
  public let sizeBytes: Int

  public init(name: String, hostPath: String, sizeBytes: Int) {
    self.name = name
    self.hostPath = hostPath
    self.sizeBytes = sizeBytes
  }

  enum CodingKeys: String, CodingKey {
    case name
    case hostPath = "host_path"
    case sizeBytes = "size_bytes"
  }
}

public struct NativeResponse: Codable, Sendable {
  public let protocolVersion = "1"
  public let ok = true
  public let exitCode: Int
  public let timedOut: Bool
  public let durationMilliseconds: Int
  public let stdoutBase64: String
  public let stderrBase64: String
  public let attestation: NativeExecutionAttestation
  public let outputs: [NativeOutputResult]

  public init(
    exitCode: Int,
    timedOut: Bool,
    durationMilliseconds: Int,
    stdoutBase64: String,
    stderrBase64: String,
    attestation: NativeExecutionAttestation,
    outputs: [NativeOutputResult]
  ) {
    self.exitCode = exitCode
    self.timedOut = timedOut
    self.durationMilliseconds = durationMilliseconds
    self.stdoutBase64 = stdoutBase64
    self.stderrBase64 = stderrBase64
    self.attestation = attestation
    self.outputs = outputs
  }

  enum CodingKeys: String, CodingKey {
    case protocolVersion = "protocol_version"
    case ok
    case exitCode = "exit_code"
    case timedOut = "timed_out"
    case durationMilliseconds = "duration_ms"
    case stdoutBase64 = "stdout_base64"
    case stderrBase64 = "stderr_base64"
    case attestation
    case outputs
  }
}

public struct NativeFailureResponse: Codable, Sendable {
  public let protocolVersion = "1"
  public let ok = false
  public let errorCode: String

  public init(errorCode: String) {
    self.errorCode = errorCode
  }

  enum CodingKeys: String, CodingKey {
    case protocolVersion = "protocol_version"
    case ok
    case errorCode = "error_code"
  }
}

public struct NativeProbeResponse: Codable, Sendable {
  public let protocolVersion = "1"
  public let profile = "apple_native_no_network_vm_v1"
  public let backend = "apple_containerization"
  public let isolation = "lightweight_vm"
  public let guestOS = "linux"
  public let networkMode = "none"
  public let ephemeralVM = true
  public let readOnlyRoot = true
  public let inputDiskReadOnly = true
  public let outputDiskBounded = true
  public let hostDirectorySharing = false
  public let socketSharing = false
  public let nestedVirtualization = false
  public let nonRootRequired = true
  public let noNewPrivileges = true
  public let capabilities = "none"

  public init() {}

  enum CodingKeys: String, CodingKey {
    case protocolVersion = "protocol_version"
    case profile
    case backend
    case isolation
    case guestOS = "guest_os"
    case networkMode = "network_mode"
    case ephemeralVM = "ephemeral_vm"
    case readOnlyRoot = "read_only_root"
    case inputDiskReadOnly = "input_disk_read_only"
    case outputDiskBounded = "output_disk_bounded"
    case hostDirectorySharing = "host_directory_sharing"
    case socketSharing = "socket_sharing"
    case nestedVirtualization = "nested_virtualization"
    case nonRootRequired = "non_root_required"
    case noNewPrivileges = "no_new_privileges"
    case capabilities
  }
}
