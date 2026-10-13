import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createProject } from "./importer.js";
import { validateProject } from "./validation.js";
import { servePlatform } from "./platform-server.js";
import { discoverProjects, findProject, summary } from "./management.js";
const cliDirectory = path.dirname(fileURLToPath(import.meta.url));
const platformRoot = path.resolve(
  cliDirectory,
  path.basename(path.dirname(cliDirectory)) === "dist"
    ? "../../../.."
    : "../../..",
);
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      name: { type: "string" },
      source: { type: "string" },
      project: { type: "string" },
      "projects-dir": { type: "string" },
      update: { type: "boolean", default: false },
      port: { type: "string" },
      "structural-only": { type: "boolean", default: false },
      help: { type: "boolean" },
    },
  });
  if (values.help || !command) {
    console.log(
      "create-project --name NAME --source ZIP_OR_FOLDER [--projects-dir PATH] [--update]\nvalidate --project PATH\ndev [--projects-dir PATH] [--port 4173]\nprojects [--projects-dir PATH]",
    );
    return;
  }
  const projectsRoot = path.resolve(
    values["projects-dir"] ?? path.join(platformRoot, "projects"),
  );
  if (command === "projects") {
    const result = await discoverProjects(projectsRoot);
    console.log(
      JSON.stringify(
        { projects: result.projects.map(summary), errors: result.errors },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "dev") {
    const port = values.port === undefined ? 4173 : Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid port");
    const server = await servePlatform(projectsRoot, port);
    console.log(`Motion Platform: http://127.0.0.1:${port} — Ctrl+C to stop.`);
    process.once("SIGINT", () => server.close());
    process.once("SIGTERM", () => server.close());
    return;
  }
  if (command === "create-project" || command === "import") {
    if (!values.name || !values.source)
      throw new Error("--name and --source are required");
    const result = await createProject({
      name: values.name,
      source: values.source,
      projectsRoot:
        values["projects-dir"] ?? path.join(platformRoot, "projects"),
      update: values.update,
    });
    console.log(
      `${result.updated ? "Updated" : "Created"}: ${result.projectPath}\nProject ID: ${result.config.projectId}\nScenes: ${result.inspection.document.scenes.length}, assets: ${result.inspection.document.assets.length}\nCopy SHA-256 inventory verified; original preserved.`,
    );
    for (const warning of result.inspection.warnings)
      console.warn(`Warning: ${warning}`);
    return;
  }
  if (command !== "validate" && command !== "dev")
    throw new Error(`Unknown command: ${command}`);
  if (!values.project) throw new Error("--project is required");
  const projectRoot = values.project.includes(path.sep)
    ? path.resolve(values.project)
    : (await findProject(projectsRoot, values.project)).root;
  const report = await validateProject(projectRoot, {
    reconstruct: !values["structural-only"],
  });
  console.log(
    `Structural validation: ${report.structuralStatus ?? report.status}\nScenes: ${report.sceneCount}, assets: ${report.assetCount}\nReport: ${path.join(projectRoot, "validation", "report.html")}\nReconstruction: ${report.reconstruction}; visual comparison: ${report.visualComparison}.`,
  );
  for (const error of report.errors) console.error(error);
  if (report.status === "failed") {
    process.exitCode = 1;
    if (command === "dev") return;
  }
}
main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
