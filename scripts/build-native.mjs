import { spawnSync } from "node:child_process";
import path from "node:path";

const repository = path.resolve(import.meta.dirname, "..");
const packagePath = path.join(repository, "native", "apple-containerization");
const entitlements = path.join(packagePath, "signing", "vz.entitlements");

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: repository,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${path.basename(executable)} failed with exit ${String(result.status)}.`);
  }
  return result;
}

run("/usr/bin/swift", ["build", "--package-path", packagePath, "-c", "release", "--jobs", "4"], {
  stdio: "inherit",
});
const binPath = run("/usr/bin/swift", [
  "build",
  "--package-path",
  packagePath,
  "-c",
  "release",
  "--show-bin-path",
]).stdout.trim();
const driver = path.join(binPath, "drone-sandboxd");
run(
  "/usr/bin/codesign",
  ["--force", "--sign", "-", "--timestamp=none", `--entitlements=${entitlements}`, driver],
  { stdio: "inherit" },
);
run("/usr/bin/codesign", ["--verify", "--strict", driver], { stdio: "inherit" });
const inspection = run("/usr/bin/codesign", ["-d", "--entitlements", ":-", driver]);
const rendered = `${inspection.stdout}${inspection.stderr}`;
if (
  !rendered.includes("<key>com.apple.security.virtualization</key>") ||
  !rendered.includes("<true/>") ||
  rendered.includes("com.apple.vm.networking")
) {
  throw new Error("Signed native driver does not have the exact no-network entitlement boundary.");
}
process.stdout.write(`Signed and verified ${driver}\n`);
