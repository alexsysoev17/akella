import { createServer, type Server } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
export async function serveReport(
  projectRoot: string,
  port = 4173,
): Promise<Server> {
  const server = createServer(async (request, response) => {
    const route = request.url?.split("?")[0];
    let name =
      route === "/" || route === "/report.html"
        ? "report.html"
        : route === "/report.json"
          ? "report.json"
          : undefined;
    if (
      !name &&
      route &&
      /^\/(reconstructed|references)\/[a-f0-9]+\.png$/.test(route)
    )
      name = route.slice(1);
    if (!name) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    try {
      const root = await realpath(path.join(projectRoot, "validation"));
      const file = await realpath(path.join(root, name));
      if (!file.startsWith(root + path.sep)) throw new Error("Unsafe path");
      const bytes = await readFile(file);
      response.writeHead(200, {
        "Content-Type": name.endsWith(".png")
          ? "image/png"
          : name.endsWith(".html")
            ? "text/html; charset=utf-8"
            : "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      });
      response.end(bytes);
    } catch {
      response.writeHead(503);
      response.end("Run validation first");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
