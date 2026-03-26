import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { log } from "../logging.js";

/* ------------------------------------------------------------------ */
/*  SSH key upload route                                                */
/* ------------------------------------------------------------------ */

const router = Router();

const HOME = process.env.HOME || "/home/node";
const SSH_DIR = path.join(HOME, ".ssh");

/**
 * POST /v1/ssh-keys
 *
 * Upload an SSH private key. Optionally include the public key; if omitted,
 * the public key is derived from the private key via ssh-keygen.
 *
 * Body: { privateKey: string, publicKey?: string, filename?: string }
 */
router.post("/v1/ssh-keys", (req, res) => {
  const { privateKey, publicKey, filename } = req.body as {
    privateKey?: string;
    publicKey?: string;
    filename?: string;
  };

  if (!privateKey) {
    res.status(400).json({ error: "privateKey is required" });
    return;
  }

  const keyName = filename || "id_ed25519";

  // Sanitize filename — alphanumeric, dash, underscore only
  if (!/^[a-zA-Z0-9_-]+$/.test(keyName)) {
    res.status(400).json({ error: "Invalid key filename" });
    return;
  }

  const dst = path.join(SSH_DIR, keyName);
  const dstPub = dst + ".pub";

  try {
    // Ensure ~/.ssh exists
    fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });

    // Write private key
    fs.writeFileSync(dst, privateKey.trim() + "\n", { mode: 0o600 });

    if (publicKey) {
      fs.writeFileSync(dstPub, publicKey.trim() + "\n", { mode: 0o644 });
    } else {
      // Derive public key from private key
      try {
        const derived = execSync(`ssh-keygen -y -f ${dst} 2>/dev/null`)
          .toString()
          .trim();
        if (derived) {
          fs.writeFileSync(dstPub, derived + "\n", { mode: 0o644 });
          log("ssh", "Public key derived from private key");
        }
      } catch {
        log("ssh", "Could not derive public key (key may require passphrase)");
      }
    }

    // Create/update SSH config with StrictHostKeyChecking=accept-new
    const configPath = path.join(SSH_DIR, "config");
    const configBlock = [
      "# Managed by agent-gateway",
      "Host *",
      "  StrictHostKeyChecking accept-new",
      `  IdentityFile ${dst}`,
      "",
    ].join("\n");

    fs.writeFileSync(configPath, configBlock, { mode: 0o644 });

    // Read back public key
    let pubKey = "";
    try {
      pubKey = fs.readFileSync(dstPub, "utf-8").trim();
    } catch {
      // Public key may not exist if derivation failed
    }

    log("ssh", `SSH key written: ${keyName}`);
    res.json({
      status: "ok",
      message: "SSH keys updated",
      publicKey: pubKey,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("ssh", `Key write failed: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

export default router;
