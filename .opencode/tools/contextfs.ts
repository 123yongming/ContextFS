import { tool } from "@opencode-ai/plugin";
import { execFile } from "node:child_process";

function runNode(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("node", args, { cwd }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message)));
      resolve(String(stdout || stderr || "").trim());
    });
  });
}

export default tool({
  description: "ContextFS command runner (ls/cat/pin/pack/compact/gc)",
  args: {
    cmd: tool.schema.string().describe("e.g. 'ls', 'cat pins --head 30', 'pin ...', 'pack', 'compact'"),
  },
  async execute({ cmd }, ctx) {
    const cwd = ctx.cwd;
    const cliPath = ".opencode/plugins/contextfs/cli.mjs"; // 你现有的 CLI
    const argv = cmd.trim() ? cmd.trim().split(/\s+/) : ["ls"];
    return await runNode([cliPath, ...argv], cwd);
  },
});
