import esbuild from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const sdkExternals = ["@paperclipai/plugin-sdk", "@paperclipai/plugin-sdk/ui", "@paperclipai/shared"];
const workerPreset = {...presets.esbuild.worker, external: [...(presets.esbuild.worker.external ?? []), ...sdkExternals]};
const uiPreset = {
  ...presets.esbuild.ui,
  external: [...(presets.esbuild.ui.external ?? []), ...sdkExternals],
  entryPoints: {
    index: "src/ui/index.tsx",
    "pdf.worker": "src/ui/pdf.worker.ts"
  }
};
const watch = process.argv.includes("--watch");
const contexts = await Promise.all([
  esbuild.context(workerPreset),
  esbuild.context(presets.esbuild.manifest),
  esbuild.context(uiPreset),
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("fai-control plugin watch build enabled");
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
  if (!existsSync("dist/ui/index.js") || !existsSync("dist/ui/pdf.worker.js")) {
    throw new Error("Plugin UI build must emit dist/ui/index.js and dist/ui/pdf.worker.js.");
  }
}

await mkdir("dist/chat-assets", {recursive: true});
for (const [source, target] of [["profile-template/config.yaml", "internal-config.yaml"], ["client-profile-template/plugins/fai-client-issues/__init__.py", "__init__.py"], ["client-profile-template/plugins/fai-client-issues/plugin.yaml", "plugin.yaml"]]) {
  await copyFile(`../../infra/hermes-project/${source}`, `dist/chat-assets/${target}`);
}
