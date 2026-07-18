import Containerization
import ContainerizationEXT4
import ContainerizationError
import CryptoKit
import Darwin
import DroneNativeCore
import Foundation
import Synchronization
import SystemPackage

private struct CaptureState {
  var data = Data()
  var truncated = false
}

private final class BoundedCapture: Writer, Sendable {
  private let maximum: Int
  private let storage = Mutex(CaptureState())

  init(maximum: Int) {
    self.maximum = maximum
  }

  var data: Data {
    storage.withLock { $0.data }
  }

  func write(_ bytes: Data) throws {
    storage.withLock { state in
      guard !state.truncated, !bytes.isEmpty else { return }
      let remaining = maximum - state.data.count
      if remaining <= 0 {
        state.truncated = true
        return
      }
      state.data.append(bytes.prefix(remaining))
      if bytes.count > remaining {
        state.truncated = true
      }
    }
  }

  func close() throws {}
}

private enum DriverError: Error, LocalizedError {
  case invalidFile(String)
  case digestMismatch(String)
  case missingOutput(String)
  case oversizedOutput(String)

  var errorDescription: String? {
    switch self {
    case .invalidFile(let value): "Invalid sandbox file: \(value)"
    case .digestMismatch(let value): "Input digest mismatch: \(value)"
    case .missingOutput(let value): "Required sandbox output is missing: \(value)"
    case .oversizedOutput(let value): "Sandbox output exceeded its limit: \(value)"
    }
  }
}

private func regularFile(_ path: String, expectedSize: Int? = nil) throws -> URL {
  let url = URL(filePath: path)
  let values = try url.resourceValues(forKeys: [
    .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey,
  ])
  guard values.isRegularFile == true, values.isSymbolicLink != true else {
    throw DriverError.invalidFile(path)
  }
  if let expectedSize, values.fileSize != expectedSize {
    throw DriverError.invalidFile(path)
  }
  return url
}

private func regularDirectory(_ path: String) throws -> URL {
  let url = URL(filePath: path)
  let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
  guard values.isDirectory == true, values.isSymbolicLink != true else {
    throw DriverError.invalidFile(path)
  }
  return url
}

private func sha256(_ file: URL) throws -> String {
  let handle = try FileHandle(forReadingFrom: file)
  defer { try? handle.close() }
  var hasher = SHA256()
  while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty {
    hasher.update(data: chunk)
  }
  return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}

private func createInputDisk(request: NativeRequest, at disk: URL) throws {
  let declaredBytes = request.inputs.reduce(0) { $0 + $1.sizeBytes }
  let diskBytes = max(16 * 1024 * 1024, declaredBytes + 8 * 1024 * 1024)
  let formatter = try EXT4.Formatter(FilePath(disk.path), minDiskSize: UInt64(diskBytes))
  do {
    for input in request.inputs {
      let source = try regularFile(input.hostPath, expectedSize: input.sizeBytes)
      guard try sha256(source) == input.sha256 else {
        throw DriverError.digestMismatch(input.name)
      }
      guard let stream = InputStream(url: source) else {
        throw DriverError.invalidFile(input.hostPath)
      }
      stream.open()
      defer { stream.close() }
      try formatter.create(
        path: FilePath("/\(input.name)"),
        mode: 0o100444,
        buf: stream
      )
    }
    try formatter.close()
  } catch {
    try? formatter.close()
    throw error
  }
}

private func createOutputDisk(request: NativeRequest, at disk: URL) throws {
  let formatter = try EXT4.Formatter(
    FilePath(disk.path),
    minDiskSize: UInt64(request.outputDiskBytes)
  )
  do {
    try formatter.create(path: FilePath("/input"), mode: 0o040555, recursion: true)
    try formatter.create(path: FilePath("/output"), mode: 0o040777, recursion: true)
    try formatter.close()
  } catch {
    try? formatter.close()
    throw error
  }
}

private func extractOutputs(
  request: NativeRequest,
  disk: URL,
  outputDirectory: URL
) throws -> [NativeOutputResult] {
  let reader = try EXT4.EXT4Reader(blockDevice: FilePath(disk.path))
  var results = [NativeOutputResult]()
  for declaration in request.outputs {
    let bytes: Data
    do {
      bytes = try reader.readFile(at: FilePath("/output/\(declaration.name)"))
    } catch {
      if declaration.required {
        throw DriverError.missingOutput(declaration.name)
      }
      continue
    }
    guard bytes.count <= declaration.maxBytes else {
      throw DriverError.oversizedOutput(declaration.name)
    }
    let destination = outputDirectory.appending(path: declaration.name)
    try bytes.write(to: destination, options: [.atomic])
    _ = try regularFile(destination.path, expectedSize: bytes.count)
    results.append(
      NativeOutputResult(
        name: declaration.name,
        hostPath: destination.path,
        sizeBytes: bytes.count
      )
    )
  }
  return results
}

private func runSandbox(_ request: NativeRequest) async throws -> NativeResponse {
  try request.validate()
  let kernelURL = try regularFile(request.kernelPath)
  let initfsURL = try regularFile(request.initfsPath)
  _ = try regularDirectory(request.imageStoreRoot)
  let workRoot = try regularDirectory(request.workRoot)
  let outputDirectory = try regularDirectory(request.outputDirectory)
  let inputDisk = workRoot.appending(path: "input.ext4")
  let outputDisk = workRoot.appending(path: "output.ext4")
  try createInputDisk(request: request, at: inputDisk)
  try createOutputDisk(request: request, at: outputDisk)

  let imageStore = try ImageStore(path: URL(filePath: request.imageStoreRoot))
  let image = try await imageStore.get(reference: request.imageReference, pull: false)
  let initfs = Mount.block(
    format: "ext4",
    source: initfsURL.path,
    destination: "/",
    options: ["ro"]
  )
  var manager = try ContainerManager(
    kernel: Kernel(path: kernelURL, platform: .linuxArm),
    initfs: initfs,
    imageStore: imageStore,
    network: nil,
    rosetta: request.architecture == "amd64",
    nestedVirtualization: false
  )
  defer { try? manager.delete(request.containerID) }

  let stdout = BoundedCapture(maximum: request.maxLogBytes)
  let stderr = BoundedCapture(maximum: request.maxLogBytes)
  let container = try await manager.create(
    request.containerID,
    image: image,
    rootfsSizeInBytes: UInt64(request.rootfsBytes),
    writableLayerSizeInBytes: UInt64(request.writableLayerBytes),
    readOnly: true,
    networking: false
  ) { config in
    config.cpus = request.cpus
    config.memoryInBytes = UInt64(request.memoryBytes)
    config.process.arguments = request.command
    config.process.environmentVariables = request.environment
    config.process.workingDirectory = "/drone"
    config.process.user = .init(
      uid: UInt32(request.uid),
      gid: UInt32(request.gid),
      umask: 0o077
    )
    config.process.noNewPrivileges = true
    config.process.capabilities = LinuxCapabilities()
    config.process.rlimits = [
      LinuxRLimit(kind: .coreFileSize, limit: 0),
      LinuxRLimit(kind: .cpuTime, limit: UInt64(request.timeoutSeconds + 2)),
      LinuxRLimit(kind: .fileSize, limit: UInt64(request.outputDiskBytes)),
      LinuxRLimit(kind: .numberOfProcesses, limit: UInt64(request.maxProcesses)),
      LinuxRLimit(kind: .openFiles, limit: UInt64(request.maxOpenFiles)),
    ]
    config.process.stdout = stdout
    config.process.stderr = stderr
    config.mounts.append(
      Mount.block(
        format: "ext4",
        source: outputDisk.path,
        destination: "/drone"
      )
    )
    config.mounts.append(
      Mount.block(
        format: "ext4",
        source: inputDisk.path,
        destination: "/drone/input",
        options: ["ro"]
      )
    )
    config.useInit = true
    config.virtualization = false
    config.interfaces = []
    config.sockets = []
  }

  let started = Date()
  try await container.create()
  try await container.start()
  var exitCode: Int
  var timedOut = false
  do {
    let status = try await container.wait(timeoutInSeconds: Int64(request.timeoutSeconds))
    exitCode = Int(status.exitCode)
  } catch let error as ContainerizationError where error.code == .timeout {
    timedOut = true
    exitCode = 124
    try? await container.kill(.kill)
    _ = try? await container.wait(timeoutInSeconds: 5)
  }
  try await container.stop()
  let outputs = try extractOutputs(
    request: request,
    disk: outputDisk,
    outputDirectory: outputDirectory
  )
  return NativeResponse(
    exitCode: exitCode,
    timedOut: timedOut,
    durationMilliseconds: max(0, Int(Date().timeIntervalSince(started) * 1_000)),
    stdoutBase64: stdout.data.base64EncodedString(),
    stderrBase64: stderr.data.base64EncodedString(),
    attestation: NativeExecutionAttestation(request: request),
    outputs: outputs
  )
}

private func writeJSON<T: Encodable>(_ value: T, to handle: FileHandle) throws {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  var data = try encoder.encode(value)
  data.append(0x0a)
  try handle.write(contentsOf: data)
}

@main
private struct DroneSandboxDriver {
  static func main() async {
    do {
      let command = CommandLine.arguments.dropFirst().first ?? ""
      switch command {
      case "probe":
        try writeJSON(NativeProbeResponse(), to: .standardOutput)
      case "run":
        let data = try FileHandle.standardInput.readToEnd() ?? Data()
        let request = try JSONDecoder().decode(NativeRequest.self, from: data)
        try writeJSON(try await runSandbox(request), to: .standardOutput)
      default:
        throw NativeContractError.invalid("driver_command")
      }
    } catch {
      let diagnostic = "drone-sandboxd: \(error.localizedDescription)\n"
      try? FileHandle.standardError.write(contentsOf: Data(diagnostic.utf8))
      try? writeJSON(NativeFailureResponse(errorCode: "DRIVER_FAILURE"), to: .standardOutput)
      exit(1)
    }
  }
}
