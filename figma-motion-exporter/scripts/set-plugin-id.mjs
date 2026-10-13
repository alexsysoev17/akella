import { readFile, writeFile } from "node:fs/promises";
const id = process.argv[2];
if (!id || !/^\d+$/.test(id))
  throw new Error(
    "Usage: npm run set-plugin-id -- <numeric ID assigned by Figma>",
  );
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
if (manifest.id && manifest.id !== id)
  throw new Error("Existing ID must be preserved; refusing replacement.");
manifest.id = id;
await writeFile("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
