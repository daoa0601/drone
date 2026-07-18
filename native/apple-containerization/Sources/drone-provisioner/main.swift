import Containerization
import ContainerizationArchive
import ContainerizationOCI
import CryptoKit
import Darwin
import DroneProvisioningCore
import Foundation

private enum ProvisioningError: Error, LocalizedError {
  case alreadyExists(String)
  case invalidFile(String)
  case rejectedArchiveMembers([String])

  var errorDescription: String? {
    switch self {
    case .alreadyExists(let path):
      "Provisioning output already exists: \(path)"
    case .invalidFile(let path):
      "Invalid provisioning file: \(path)"
    case .rejectedArchiveMembers(let paths):
      "OCI archive contains rejected members: \(paths.joined(separator: ", "))"
    }
  }
}

private struct PreparedInitFS: Codable {
  let schemaVersion = "1"
  let sourceReference: String
  let sourceDigest: String
  let outputPath: String
  let outputSHA256: String
  let outputSizeBytes: Int

  enum CodingKeys: String, CodingKey {
    case schemaVersion = "schema_version"
    case sourceReference = "source_reference"
    case sourceDigest = "source_digest"
    case outputPath = "output_path"
    case outputSHA256 = "output_sha256"
    case outputSizeBytes = "output_size_bytes"
  }
}

private struct ImportedImage: Codable {
  let reference: String
  let pinnedReference: String
  let mediaType: String
  let digest: String

  enum CodingKeys: String, CodingKey {
    case reference
    case pinnedReference = "pinned_reference"
    case mediaType = "media_type"
    case digest
  }
}

private func regularFile(_ path: String, maximumBytes: Int? = nil) throws -> URL {
  let url = URL(filePath: path)
  let values = try url.resourceValues(forKeys: [
    .isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey,
  ])
  guard values.isRegularFile == true, values.isSymbolicLink != true else {
    throw ProvisioningError.invalidFile(path)
  }
  if let maximumBytes, let size = values.fileSize, size > maximumBytes {
    throw ProvisioningError.invalidFile(path)
  }
  return url
}

private func regularDirectory(_ path: String) throws -> URL {
  let url = URL(filePath: path)
  let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
  guard values.isDirectory == true, values.isSymbolicLink != true else {
    throw ProvisioningError.invalidFile(path)
  }
  return url
}

private func prepareStore(_ path: String) throws -> URL {
  let url = URL(filePath: path)
  if FileManager.default.fileExists(atPath: path) {
    return try regularDirectory(path)
  }
  let parent = try regularDirectory(url.deletingLastPathComponent().path)
  let created = parent.appending(path: url.lastPathComponent)
  try FileManager.default.createDirectory(
    at: created,
    withIntermediateDirectories: false,
    attributes: [.posixPermissions: 0o700]
  )
  return try regularDirectory(created.path)
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

private func fileSize(_ file: URL) throws -> Int {
  let values = try file.resourceValues(forKeys: [.fileSizeKey])
  guard let size = values.fileSize else {
    throw ProvisioningError.invalidFile(file.path)
  }
  return size
}

private func emit<T: Encodable>(_ value: T) throws {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
  let data = try encoder.encode(value)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

private func prepareInitFS(storeRoot: String, reference: String, output: String) async throws {
  guard !FileManager.default.fileExists(atPath: output) else {
    throw ProvisioningError.alreadyExists(output)
  }
  let outputURL = URL(filePath: output)
  _ = try regularDirectory(outputURL.deletingLastPathComponent().path)
  let store = try ImageStore(path: prepareStore(storeRoot))
  let image = try await store.getInitImage(reference: reference)
  let mount = try await image.initBlock(at: outputURL, for: .linuxArm)
  guard mount.source == outputURL.path else {
    throw ProvisioningError.invalidFile(output)
  }
  _ = try regularFile(output)
  guard chmod(output, S_IRUSR | S_IWUSR) == 0 else {
    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
  }
  let imported = try await store.get(reference: reference)
  try emit(
    PreparedInitFS(
      sourceReference: reference,
      sourceDigest: imported.digest,
      outputPath: output,
      outputSHA256: try sha256(outputURL),
      outputSizeBytes: try fileSize(outputURL)
    )
  )
}

private func loadOCI(storeRoot: String, archive: String) async throws {
  let archiveURL = try regularFile(archive, maximumBytes: 20 * 1024 * 1024 * 1024)
  let store = try ImageStore(path: prepareStore(storeRoot))
  let temporary = FileManager.default.temporaryDirectory.appending(
    path: "drone-provisioner-\(UUID().uuidString)"
  )
  try FileManager.default.createDirectory(
    at: temporary,
    withIntermediateDirectories: false,
    attributes: [.posixPermissions: 0o700]
  )
  defer { try? FileManager.default.removeItem(at: temporary) }
  let reader = try ArchiveReader(file: archiveURL)
  let rejected = try reader.extractContents(to: temporary)
  guard rejected.isEmpty else {
    throw ProvisioningError.rejectedArchiveMembers(rejected.sorted())
  }
  let images = try await store.load(from: temporary)
  var result = [ImportedImage]()
  for image in images.sorted(by: { $0.reference < $1.reference }) {
    let parsed = try Reference.parse(image.reference)
    let pinned = "\(parsed.name)@\(image.digest)"
    _ = try await store.tag(existing: image.reference, new: pinned)
    result.append(
      ImportedImage(
        reference: image.reference,
        pinnedReference: pinned,
        mediaType: image.mediaType,
        digest: image.digest
      )
    )
  }
  try emit(result)
}

private func listImages(storeRoot: String) async throws {
  let store = try ImageStore(path: regularDirectory(storeRoot))
  let result = try await store.list().sorted(by: { $0.reference < $1.reference }).map {
    ImportedImage(
      reference: $0.reference,
      pinnedReference: $0.reference,
      mediaType: $0.mediaType,
      digest: $0.digest
    )
  }
  try emit(result)
}

@main
private enum DroneProvisioner {
  static func main() async {
    do {
      switch try ProvisioningCommand.parse(Array(CommandLine.arguments.dropFirst())) {
      case .prepareInitFS(let storeRoot, let reference, let output):
        try await prepareInitFS(storeRoot: storeRoot, reference: reference, output: output)
      case .loadOCI(let storeRoot, let archive):
        try await loadOCI(storeRoot: storeRoot, archive: archive)
      case .listImages(let storeRoot):
        try await listImages(storeRoot: storeRoot)
      }
    } catch {
      FileHandle.standardError.write(
        Data("drone-provisioner: \(error.localizedDescription)\n".utf8))
      exit(EXIT_FAILURE)
    }
  }
}
