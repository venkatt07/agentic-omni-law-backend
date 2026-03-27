import { build as viteBuild } from "vite";
import { rm } from "fs/promises";
import { spawn } from "child_process";

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building backend...");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["--prefix", "backend", "run", "build"], {
      stdio: "inherit",
      shell: true,
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`backend build failed with code ${code}`))));
    child.on("error", reject);
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
