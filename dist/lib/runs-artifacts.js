/**
 * Async run artifact declarations and manifest resolution.
 * Owns: artifact path template expansion and filesystem-backed artifact metadata.
 */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, } from "node:fs";
import { substituteCommandTemplateToken } from "./command-templates.js";
function hashArtifactFile(path) {
    const fd = openSync(path, "r");
    try {
        const size = fstatSync(fd).size;
        const hash = createHash("sha256");
        const chunk = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (position < size) {
            const bytesRead = readSync(fd, chunk, 0, Math.min(chunk.byteLength, size - position), position);
            if (bytesRead === 0)
                break;
            hash.update(chunk.subarray(0, bytesRead));
            position += bytesRead;
        }
        return { sha256: hash.digest("hex"), size: position };
    }
    finally {
        closeSync(fd);
    }
}
export function resolveArtifactPaths(artifacts, values) {
    if (!artifacts)
        return undefined;
    const resolved = {};
    for (const [key, value] of Object.entries(artifacts)) {
        if (!key.trim())
            continue;
        if (typeof value === "string") {
            resolved[key] = substituteCommandTemplateToken(value, values, `recipe artifacts.${key}`);
        }
        else if (value &&
            typeof value === "object" &&
            typeof value.path === "string") {
            resolved[key] = {
                ...value,
                path: substituteCommandTemplateToken(value.path, values, `recipe artifacts.${key}.path`),
            };
        }
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
}
export function resolveArtifactManifest(artifacts) {
    if (!artifacts)
        return undefined;
    const manifest = {};
    for (const [name, artifact] of Object.entries(artifacts)) {
        const declaration = typeof artifact === "string" ? { path: artifact } : artifact;
        if (!declaration?.path)
            continue;
        try {
            const hashed = hashArtifactFile(declaration.path);
            manifest[name] = {
                exists: true,
                ...(declaration.kind ? { kind: declaration.kind } : {}),
                ...(declaration.media_type
                    ? { media_type: declaration.media_type }
                    : {}),
                path: declaration.path,
                ...(declaration.required !== undefined
                    ? { required: declaration.required }
                    : {}),
                sha256: hashed.sha256,
                size: hashed.size,
            };
        }
        catch {
            manifest[name] = {
                exists: false,
                ...(declaration.kind ? { kind: declaration.kind } : {}),
                ...(declaration.media_type
                    ? { media_type: declaration.media_type }
                    : {}),
                path: declaration.path,
                ...(declaration.required !== undefined
                    ? { required: declaration.required }
                    : {}),
            };
        }
    }
    return Object.keys(manifest).length > 0 ? manifest : undefined;
}
