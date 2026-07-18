// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "drone-apple-containerization",
  platforms: [.macOS("26.0")],
  products: [
    .executable(name: "drone-sandboxd", targets: ["drone-sandboxd"])
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
    .testTarget(name: "DroneNativeCoreTests", dependencies: ["DroneNativeCore"]),
  ]
)
