// Thin client for the Draw Things HTTP API server (A1111-style endpoints).
// Enable it in the app: Settings > API Server, protocol HTTP, default port 7860.

export interface GenerateParams {
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  guidance_scale?: number;
  sampler?: string;
  model?: string;
  // Any other Draw Things config keys, passed through as-is
  extra?: Record<string, unknown>;
}

export interface Img2ImgParams extends GenerateParams {
  init_image_base64: string;
  strength?: number;
}

export class DrawThingsClient {
  // Draw Things runs one job at a time; serialize requests so they don't collide
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private baseUrl: string,
    private timeoutMs: number,
  ) {}

  async status(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Draw Things returned HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  txt2img(params: GenerateParams): Promise<string[]> {
    return this.enqueue(() => this.post("/sdapi/v1/txt2img", toBody(params)));
  }

  img2img(params: Img2ImgParams): Promise<string[]> {
    const body = {
      ...toBody(params),
      init_images: [params.init_image_base64],
      ...(params.strength !== undefined && { strength: params.strength }),
    };
    return this.enqueue(() => this.post("/sdapi/v1/img2img", body));
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async post(path: string, body: unknown): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Draw Things returned HTTP ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as { images?: string[] };
    if (!json.images?.length) throw new Error("Draw Things returned no images");
    return json.images;
  }
}

function toBody(p: GenerateParams): Record<string, unknown> {
  const { extra, ...rest } = p;
  const body: Record<string, unknown> = { ...(extra ?? {}) };
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined && k !== "init_image_base64" && k !== "strength") body[k] = v;
  }
  return body;
}
