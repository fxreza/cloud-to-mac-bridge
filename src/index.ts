import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import express, { type Request, type Response } from "express";
import sharp from "sharp";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DrawThingsClient } from "./drawthings.js";

const config = {
  token: process.env.BRIDGE_TOKEN ?? "",
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
  drawThingsUrl: (process.env.DRAWTHINGS_URL ?? "http://127.0.0.1:7860").replace(/\/$/, ""),
  outputDir: path.resolve(process.env.OUTPUT_DIR ?? "./outputs"),
  previewMaxSide: Number(process.env.PREVIEW_MAX_SIDE ?? 1024),
  previewQuality: Number(process.env.PREVIEW_JPEG_QUALITY ?? 82),
  timeoutMs: Number(process.env.GENERATION_TIMEOUT_S ?? 600) * 1000,
};

if (config.token.length < 32) {
  console.error("BRIDGE_TOKEN is missing or shorter than 32 chars. Run `npm run gen-token` and put it in .env.");
  process.exit(1);
}

const drawThings = new DrawThingsClient(config.drawThingsUrl, config.timeoutMs);

const generationShape = {
  prompt: z.string().min(1).describe("What to generate"),
  negative_prompt: z.string().optional(),
  width: z.number().int().min(64).max(4096).optional().describe("Multiple of 64 recommended"),
  height: z.number().int().min(64).max(4096).optional().describe("Multiple of 64 recommended"),
  steps: z.number().int().min(1).max(150).optional(),
  seed: z.number().int().optional().describe("-1 or omit for random"),
  guidance_scale: z.number().min(0).max(50).optional(),
  sampler: z.string().optional(),
  model: z.string().optional().describe("Model file name as shown by drawthings_status; omit to use the app's current model"),
  extra: z.record(z.unknown()).optional().describe("Other Draw Things config keys, passed through unchanged"),
};

function buildServer(): McpServer {
  const server = new McpServer({ name: "drawthings-bridge", version: "0.1.0" });

  server.registerTool(
    "drawthings_status",
    {
      title: "Draw Things status",
      description: "Check that Draw Things is reachable on the Mac and return its current settings (model, size, steps, etc.).",
      inputSchema: {},
    },
    async () => {
      const status = await drawThings.status();
      return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
    },
  );

  server.registerTool(
    "drawthings_generate",
    {
      title: "Generate image (txt2img)",
      description:
        "Generate images from a text prompt with the local Draw Things app. Unset options fall back to the app's current settings. Returns a JPEG preview plus the file name of the full PNG saved on the Mac.",
      inputSchema: generationShape,
    },
    async (args) => toResult(await drawThings.txt2img(args), "txt2img"),
  );

  server.registerTool(
    "drawthings_img2img",
    {
      title: "Transform image (img2img)",
      description:
        "Transform an existing image with a prompt. Give either source_file (a file name returned by an earlier call) or image_base64.",
      inputSchema: {
        ...generationShape,
        source_file: z.string().optional().describe("File name from an earlier result, e.g. txt2img-1727820000000-0.png"),
        image_base64: z.string().optional().describe("PNG or JPEG, base64 without a data: prefix"),
        strength: z.number().min(0).max(1).optional().describe("0 keeps the source, 1 ignores it"),
      },
    },
    async ({ source_file, image_base64, ...rest }) => {
      const init = source_file ? (await readFile(safeOutputPath(source_file))).toString("base64") : image_base64;
      if (!init) throw new Error("Provide source_file or image_base64");
      return toResult(await drawThings.img2img({ ...rest, init_image_base64: init }), "img2img");
    },
  );

  return server;
}

async function toResult(images: string[], kind: string) {
  await mkdir(config.outputDir, { recursive: true });
  const stamp = Date.now();
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  const files: string[] = [];

  for (const [i, b64] of images.entries()) {
    const png = Buffer.from(b64, "base64");
    const name = `${kind}-${stamp}-${i}.png`;
    await writeFile(path.join(config.outputDir, name), png);
    files.push(name);

    const preview = await sharp(png)
      .resize(config.previewMaxSide, config.previewMaxSide, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: config.previewQuality })
      .toBuffer();
    content.push({ type: "image", data: preview.toString("base64"), mimeType: "image/jpeg" });
  }

  content.unshift({ type: "text", text: `Saved on the Mac in ${config.outputDir}: ${files.join(", ")}` });
  return { content };
}

// Only allow plain file names inside OUTPUT_DIR
function safeOutputPath(name: string): string {
  const base = path.basename(name);
  if (base !== name || !base) throw new Error("source_file must be a plain file name");
  return path.join(config.outputDir, base);
}

const tokenHash = createHash("sha256").update(config.token).digest();
function tokenOk(candidate: string | undefined): boolean {
  if (!candidate) return false;
  return timingSafeEqual(createHash("sha256").update(candidate).digest(), tokenHash);
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "30mb" }));

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// Token in the path (for claude.ai custom connectors) or as a Bearer header (for other clients)
async function handleMcp(req: Request, res: Response) {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  const pathToken = typeof req.params.token === "string" ? req.params.token : undefined;
  if (!tokenOk(pathToken ?? bearer)) {
    res.status(404).end();
    return;
  }

  // Stateless: a fresh server + transport per request
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
}

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).set("Allow", "POST").end();
};

app.post("/mcp/:token", handleMcp);
app.post("/mcp", handleMcp);
app.get(["/mcp", "/mcp/:token"], methodNotAllowed);
app.delete(["/mcp", "/mcp/:token"], methodNotAllowed);

app.listen(config.port, config.host, () => {
  console.log(`drawthings-bridge listening on http://${config.host}:${config.port}`);
  console.log(`Draw Things API: ${config.drawThingsUrl}`);
  console.log(`Outputs: ${config.outputDir}`);
});
