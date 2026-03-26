import { Router } from "express";
import fs from "node:fs";
import type { Request, Response } from "express";
import { log } from "../logging.js";
import {
  getWorkspaceDir,
  safePath,
  listFiles,
  readFile,
  writeFile,
  deleteFile,
} from "../workspace.js";

/* ------------------------------------------------------------------ */
/*  Workspace CRUD routes: memory, agents, skills                       */
/* ------------------------------------------------------------------ */

const router = Router();

type WorkspaceSection = "memory" | "agents" | "skills";
const SECTIONS: WorkspaceSection[] = ["memory", "agents", "skills"];

/**
 * Extract the sub-path from the URL.
 * e.g. /v1/memory/MEMORY.md → "MEMORY.md"
 * e.g. /v1/agents/my-agent/config.json → "my-agent/config.json"
 * e.g. /v1/memory → "" (list mode)
 */
function extractSubPath(req: Request, prefix: string): string {
  // req.path is the URL path portion after the router mount
  // With the pattern /v1/memory/*, req.params[0] gives the wildcard part
  // But since we use explicit route params, we'll parse from the URL
  const fullPath = req.path;
  const prefixPath = `/v1/${prefix}`;

  if (fullPath === prefixPath || fullPath === prefixPath + "/") {
    return "";
  }

  // Strip the prefix + trailing slash
  return fullPath.substring(prefixPath.length + 1);
}

for (const section of SECTIONS) {
  const baseDir = getWorkspaceDir(section);

  /* LIST: GET /v1/{section} */
  router.get(`/v1/${section}`, (_req: Request, res: Response) => {
    try {
      const files = listFiles(baseDir);
      res.json({ files });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
    }
  });

  /* GET: GET /v1/{section}/* */
  router.get(`/v1/${section}/*`, (req: Request, res: Response) => {
    const subPath = extractSubPath(req, section);
    if (!subPath) {
      // Redirect to list
      const files = listFiles(baseDir);
      res.json({ files });
      return;
    }

    const filePath = safePath(baseDir, subPath);
    if (!filePath) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    try {
      const content = readFile(filePath);
      // Detect content type from extension
      if (subPath.endsWith(".json")) {
        res.type("application/json").send(content);
      } else {
        res.type("text/plain").send(content);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
    }
  });

  /* PUT: PUT /v1/{section}/* */
  router.put(`/v1/${section}/*`, (req: Request, res: Response) => {
    const subPath = extractSubPath(req, section);
    if (!subPath) {
      res.status(400).json({ error: "Path is required" });
      return;
    }

    const filePath = safePath(baseDir, subPath);
    if (!filePath) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }

    try {
      const content =
        typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      writeFile(filePath, content);
      log("workspace", `Written: ${section}/${subPath}`);
      res.json({ status: "ok", path: `${section}/${subPath}` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
    }
  });

  /* DELETE: DELETE /v1/{section}/* */
  router.delete(`/v1/${section}/*`, (req: Request, res: Response) => {
    const subPath = extractSubPath(req, section);
    if (!subPath) {
      res.status(400).json({ error: "Path is required" });
      return;
    }

    const filePath = safePath(baseDir, subPath);
    if (!filePath) {
      res.status(400).json({ error: "Invalid path" });
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    try {
      deleteFile(filePath);
      log("workspace", `Deleted: ${section}/${subPath}`);
      res.json({ status: "ok" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
    }
  });
}

export default router;
