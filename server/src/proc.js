import { spawn } from "node:child_process";

/** Run a CLI tool, capture stdout/stderr, reject on non-zero exit. */
export function run(tool, args, { timeoutMs = 600_000, cwd, onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { windowsHide: true, cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`${tool} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      onStderr?.(chunk.toString());
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`${tool} failed to start: ${err.message}`));
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${tool} exited ${code}\n${stderr.split("\n").slice(-8).join("\n")}`,
          ),
        );
    });
  });
}
