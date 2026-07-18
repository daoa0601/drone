import DroneNativeCore
import Foundation
import Testing

private func request(overrides: (inout [String: Any]) -> Void = { _ in }) throws -> NativeRequest {
  var value: [String: Any] = [
    "protocol_version": "1",
    "container_id": "drone-0123456789abcdef01234567",
    "provider_attestation_id": "attestation.sha256." + String(repeating: "c", count: 64),
    "attestation_challenge": String(repeating: "d", count: 64),
    "image_reference": "registry.example/drone/tool@sha256:" + String(repeating: "a", count: 64),
    "image_store_root": "/var/lib/drone/images",
    "kernel_path": "/var/lib/drone/vmlinux",
    "initfs_path": "/var/lib/drone/vminit.ext4",
    "work_root": "/var/lib/drone/runs/one",
    "output_directory": "/var/lib/drone/runs/one/outputs",
    "command": ["/usr/local/bin/analyze"],
    "environment": ["HOME=/tmp", "PATH=/usr/bin:/bin"],
    "architecture": "arm64",
    "uid": 65532,
    "gid": 65532,
    "cpus": 1,
    "memory_bytes": 512 * 1_048_576,
    "rootfs_bytes": 1024 * 1_048_576,
    "writable_layer_bytes": 128 * 1_048_576,
    "output_disk_bytes": 32 * 1_048_576,
    "timeout_seconds": 30,
    "max_log_bytes": 65_536,
    "max_processes": 32,
    "max_open_files": 128,
    "inputs": [
      [
        "name": "sample",
        "host_path": "/var/lib/drone/artifacts/sample",
        "sha256": String(repeating: "b", count: 64),
        "size_bytes": 1024,
      ]
    ],
    "outputs": [
      ["name": "report", "required": true, "max_bytes": 1_048_576]
    ],
  ]
  overrides(&value)
  return try JSONDecoder().decode(
    NativeRequest.self,
    from: JSONSerialization.data(withJSONObject: value)
  )
}

@Test func acceptsBoundedNoNetworkContract() throws {
  try request().validate()
}

@Test func rejectsMutableImageReference() throws {
  let value = try request { $0["image_reference"] = "registry.example/drone/tool:latest" }
  #expect(throws: NativeContractError.self) {
    try value.validate()
  }
}

@Test func rejectsInvalidAttestationChallenge() throws {
  let value = try request { $0["attestation_challenge"] = "replayed" }
  #expect(throws: NativeContractError.self) {
    try value.validate()
  }
}

@Test func rejectsTraversalStyleOutputName() throws {
  let value = try request {
    $0["outputs"] = [["name": "../report", "required": true, "max_bytes": 1024]]
  }
  #expect(throws: NativeContractError.self) {
    try value.validate()
  }
}

@Test func rejectsRootUser() throws {
  let value = try request { $0["uid"] = 0 }
  #expect(throws: NativeContractError.self) {
    try value.validate()
  }
}

@Test func rejectsDeclaredOutputsLargerThanDisk() throws {
  let value = try request {
    $0["outputs"] = [["name": "report", "required": true, "max_bytes": 32 * 1_048_576]]
  }
  #expect(throws: NativeContractError.self) {
    try value.validate()
  }
}
