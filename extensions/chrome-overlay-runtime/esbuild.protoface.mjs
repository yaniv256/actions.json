import * as esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [path.join(here, "src/vendor/protoface-entry.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  outfile: path.join(here, "dist/protoface-client-bundle.mjs"),
  logLevel: "info",
});

console.log("Protoface browser bundle built.");
