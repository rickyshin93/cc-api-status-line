import { chmodSync } from "node:fs";

const res = await Bun.build({
  entrypoints: ["src/cli.ts"],
  target: "node",
  format: "esm",
});

if (!res.success) {
  for (const log of res.logs) console.error(log);
  process.exit(1);
}

let code = await res.outputs[0].text();
if (!code.startsWith("#!")) code = `#!/usr/bin/env node\n${code}`;

await Bun.write("bin/cli.js", code);
chmodSync("bin/cli.js", 0o755);
console.log("built bin/cli.js");
