#!/usr/bin/env bun
/**
 * @file Tiny static file server for the example pages.
 *
 * Serves the repo root at http://localhost:8080 so the example's
 * relative `<script src="../../packages/core/dist/iife/index.js">`
 * resolves correctly. Default landing page is the vanilla example.
 *
 * Not part of the SDK distribution; only used during local development
 * and verification (it never ships to customers).
 *
 * @module scripts/serve-example
 */

import { stat } from "node:fs/promises";
import { join, extname } from "node:path";

const PORT = Number(process.env.PORT) || 8080;
const ROOT = process.cwd();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    let pathname = new URL(req.url).pathname;
    if (pathname === "/") pathname = "/examples/vanilla/index.html";

    const filePath = join(ROOT, pathname);
    if (!filePath.startsWith(ROOT)) return new Response("forbidden", { status: 403 });

    try {
      const s = await stat(filePath);
      if (s.isDirectory()) {
        return Response.redirect(pathname + (pathname.endsWith("/") ? "index.html" : "/index.html"));
      }
    } catch {
      return new Response(`not found: ${pathname}`, { status: 404 });
    }

    const ext = extname(filePath);
    const file = Bun.file(filePath);
    return new Response(file, {
      headers: {
        "content-type": MIME[ext] || "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  },
});

console.log(`example server: http://localhost:${server.port}/`);
console.log(`vanilla example: http://localhost:${server.port}/examples/vanilla/index.html`);
