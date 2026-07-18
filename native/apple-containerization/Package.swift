// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "drone-apple-containerization",
  platforms: [.macOS("26.0")],
  products: [
    .executable(name: "drone-sandboxd", targets: ["drone-sandboxd"]),
    .executable(name: "drone-provisioner", targets: ["drone-provisioner"]),
  ],
  dependencies: [
    .package(
      url: "https://github.com/apple/containerization.git",
      exact: "0.35.0"
    ),
    .package(
      url: "https://github.com/apple/swift-system.git",
      exact: "1.6.4"
    ),
  ],
  targets: [
    .target(name: "DroneNativeCore"),
    .target(name: "DroneProvisioningCore"),
    .executableTarget(
      name: "drone-sandboxd",
      dependencies: [
        "DroneNativeCore",
        .product(name: "Containerization", package: "containerization"),
        .product(name: "ContainerizationEXT4", package: "containerization"),
        .product(name: "ContainerizationOCI", package: "containerization"),
        .product(name: "SystemPackage", package: "swift-system"),
      ]
    ),
    .executableTarget(
      name: "drone-provisioner",
      dependencies: [
        "DroneProvisioningCore",
        .product(name: "Containerization", package: "containerization"),
        .product(name: "ContainerizationArchive", package: "containerization"),
        .product(name: "ContainerizationOCI", package: "containerization"),
      ]
    ),
    .testTarget(name: "DroneNativeCoreTests", dependencies: ["DroneNativeCore"]),
    .testTarget(
      name: "DroneProvisioningCoreTests",
      dependencies: ["DroneProvisioningCore"]
    ),
  ]
)
