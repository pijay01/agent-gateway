import fs from "node:fs";
import path from "node:path";
import { log } from "./logging.js";

/* ------------------------------------------------------------------ */
/*  Workspace root                                                      */
/* ------------------------------------------------------------------ */

const HOME = process.env.HOME || "/home/node";
const WORKSPACE_ROOT =
  process.env.WORKSPACE_ROOT || path.join(HOME, ".claude");

export function getWorkspaceRoot(): string {
  return WORKSPACE_ROOT;
}

export function getWorkspaceDir(subdir: string): string {
  return path.join(WORKSPACE_ROOT, subdir);
}

/* ------------------------------------------------------------------ */
/*  Path traversal protection                                           */
/* ------------------------------------------------------------------ */

/**
 * Resolve a user-supplied relative path under a base directory.
 * Returns the resolved absolute path, or null if the path escapes the base.
 *
 * Strategy:
 *   1. Reject absolute paths and obvious traversal (`..`)
 *   2. Join with base and resolve
 *   3. If the target exists, use realpath to resolve symlinks
 *   4. Verify the resolved path starts with the base directory
 */
export function safePath(baseDir: string, userPath: string): string | null {
  if (!userPath) return null;

  // Quick reject: absolute paths
  if (path.isAbsolute(userPath)) return null;

  // Quick reject: null bytes
  if (userPath.includes("\0")) return null;

  // Resolve candidate path
  const candidate = path.resolve(baseDir, userPath);

  // Normalize base for comparison (ensure trailing separator consistency)
  const normalizedBase = path.resolve(baseDir) + path.sep;

  // Check candidate is under base (before symlink resolution)
  if (!candidate.startsWith(normalizedBase) && candidate !== path.resolve(baseDir)) {
    return null;
  }

  // If file/dir exists, resolve symlinks and re-check
  if (fs.existsSync(candidate)) {
    const real = fs.realpathSync(candidate);
    const realBase = fs.realpathSync(baseDir);
    const realBasePrefix = realBase + path.sep;
    if (!real.startsWith(realBasePrefix) && real !== realBase) {
      return null;
    }
    return real;
  }

  // File doesn't exist yet (write operation) — check parent
  const parentDir = path.dirname(candidate);
  if (fs.existsSync(parentDir)) {
    const realParent = fs.realpathSync(parentDir);
    const realBase = fs.existsSync(baseDir)
      ? fs.realpathSync(baseDir)
      : path.resolve(baseDir);
    const realBasePrefix = realBase + path.sep;
    if (!realParent.startsWith(realBasePrefix) && realParent !== realBase) {
      return null;
    }
  }

  return candidate;
}

/* ------------------------------------------------------------------ */
/*  File CRUD helpers                                                    */
/* ------------------------------------------------------------------ */

export interface FileEntry {
  path: string;
  size: number;
  modified: string;
}

/**
 * Recursively list all files under a directory.
 */
export function listFiles(baseDir: string): FileEntry[] {
  const files: FileEntry[] = [];

  const walk = (dir: string, prefix = ""): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, rel);
      } else {
        const stat = fs.statSync(fullPath);
        files.push({
          path: rel,
          size: stat.size,
          modified: stat.mtime.toISOString(),
        });
      }
    }
  };

  walk(baseDir);
  return files;
}

/**
 * Read a file's content as UTF-8.
 */
export function readFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * Write content to a file, creating parent directories as needed.
 */
export function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/**
 * Delete a file.
 */
export function deleteFile(filePath: string): void {
  fs.unlinkSync(filePath);
}

/**
 * Ensure a directory exists.
 */
export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  log("workspace", `Ensured directory: ${dirPath}`);
}
