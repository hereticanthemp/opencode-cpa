import type { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { randomBytes } from "node:crypto"
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { Config } from "./config.js"
import { generateImage } from "./image-client.js"

type Editor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]
const ratios = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]
const sizes = ["1K", "2K", "4K"]
const inputMimes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }
const maximumBytes = 20 * 1024 * 1024

function fail(message: string): never { throw new ToolError({ message }) }
function code(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined
}
function inside(root: string, path: string): void {
  const local = relative(root, path)
  if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`) || local.split(sep).includes(".git")) {
    fail("CPA image paths must stay within the working directory and cannot contain .git")
  }
}
function localPath(root: string, path: string): string {
  if (/[\\/]$/.test(path)) fail("CPA image path must name a file")
  if (!path.trim() || path.includes("\0") || isAbsolute(path) || path.split(/[\\/]/).includes(".git")) {
    fail("CPA image paths must be relative and cannot contain .git")
  }
  const result = resolve(root, path)
  inside(root, result)
  if (result === root) fail("CPA image path must name a file")
  return result
}
async function checkParent(root: string, path: string): Promise<void> {
  let parent = dirname(path)
  while (true) {
    try { await lstat(parent); break } catch (error) {
      if (code(error) !== "ENOENT") throw error
      parent = dirname(parent)
    }
  }
  inside(root, await realpath(parent))
}

export function createImageTool(dependencies: {
  directory: string
  models: () => string[]
  settings: () => Promise<{ config: Config; apiKey?: string } | undefined>
  fetch?: typeof fetch
}): Parameters<Editor["add"]>[0] {
  return {
    name: "cpa_generate_image",
    description: "Generate or edit images with a CLIProxyAPI image model. Saves to .opencode/cpa-images/ (git-ignored) by default; use path to choose a different location. Move images you want to keep to a permanent project location.",
    input: {
      type: "object", additionalProperties: false, required: ["prompt"],
      properties: {
        prompt: { type: "string", minLength: 1 },
        images: { type: "array", maxItems: 8, items: { type: "string" }, description: "Image paths within the working directory, for editing or reference." },
        aspectRatio: { type: "string", enum: ratios },
        imageSize: { type: "string", enum: sizes },
        path: { type: "string", description: "Output file path relative to the working directory." },
      },
    },
    async execute(input, context) {
      try {
        if (typeof input !== "object" || input === null || Array.isArray(input)) fail("CPA image input is invalid")
        const value = input as Record<string, unknown>
        if (Object.keys(value).some((key) => !["prompt", "images", "aspectRatio", "imageSize", "path"].includes(key))
          || typeof value.prompt !== "string" || !value.prompt.trim()
          || (value.images !== undefined && (!Array.isArray(value.images) || value.images.length > 8 || !value.images.every((path) => typeof path === "string")))
          || (value.aspectRatio !== undefined && (typeof value.aspectRatio !== "string" || !ratios.includes(value.aspectRatio)))
          || (value.imageSize !== undefined && (typeof value.imageSize !== "string" || !sizes.includes(value.imageSize)))
          || (value.path !== undefined && typeof value.path !== "string")) fail("CPA image input is invalid")
        context.signal.throwIfAborted()
        const root = await realpath(dependencies.directory)
        const custom = value.path !== undefined
        if (custom) await checkParent(root, localPath(root, value.path as string))
        const images: { mime: string; data: string }[] = []
        let total = 0
        for (const path of (value.images ?? []) as string[]) {
          const source = localPath(root, path)
          const resolved = await realpath(source)
          inside(root, resolved)
          const mime = inputMimes[extname(source).toLowerCase()]
          if (!mime) fail("CPA image inputs must be PNG, JPEG, or WebP")
          const info = await stat(resolved)
          if (!info.isFile()) fail("CPA image input must be a file")
          if (total + info.size > maximumBytes) fail("CPA image inputs exceed 20 MB")
          const data = await readFile(resolved)
          total += data.length
          if (total > maximumBytes) fail("CPA image inputs exceed 20 MB")
          images.push({ mime, data: data.toString("base64") })
        }
        const settings = await dependencies.settings()
        context.signal.throwIfAborted()
        if (!settings) fail("CPA image connection is unavailable")
        const models = dependencies.models()
        const model = settings.config.imageModel ?? models[0]
        if (!model || !models.includes(model)) fail("CPA image model is unavailable")
        let image: Awaited<ReturnType<typeof generateImage>>
        try {
          image = await generateImage(settings.config, {
            model, prompt: value.prompt, images,
            aspectRatio: value.aspectRatio as string | undefined, imageSize: value.imageSize as string | undefined,
          }, { apiKey: settings.apiKey, fetch: dependencies.fetch, signal: context.signal })
        } catch (error) {
          if (context.signal.aborted) fail("CPA image request aborted")
          fail(error instanceof Error ? error.message : "CPA image request failed")
        }
        context.signal.throwIfAborted()
        const ext = Object.hasOwn(extensions, image.mime) ? extensions[image.mime] : "bin"
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
        const name = custom ? value.path as string : `.opencode/cpa-images/${stamp}-${randomBytes(2).toString("hex")}.${ext}`
        const suffix = extname(name)
        const output = localPath(root, `${suffix ? name.slice(0, -suffix.length) : name}.${ext}`)
        await checkParent(root, output)
        await mkdir(dirname(output), { recursive: true })
        await checkParent(root, output)
        if (!custom) {
          try { await writeFile(join(dirname(output), ".gitignore"), "*\n", { flag: "wx" }) } catch (error) {
            if (code(error) !== "EEXIST") throw error
          }
        }
        const data = Buffer.from(image.data, "base64")
        try { await writeFile(output, data, { flag: "wx" }) } catch (error) {
          if (code(error) === "EEXIST") fail("CPA image output already exists; choose a different path")
          throw error
        }
        const path = relative(root, output)
        const text = `Saved ${path}\nMIME: ${image.mime}\nBytes: ${data.length}\nModel: ${model}`
          + (custom ? "" : "\nThis file is git-ignored. Move it to a permanent project location to keep it.")
          + (image.text ? `\n${image.text}` : "")
        return {
          content: [{ type: "text", text }, { type: "file", uri: `data:${image.mime};base64,${image.data}`, mime: image.mime, name: basename(output) }],
          metadata: { path, model, mime: image.mime, bytes: data.length },
        }
      } catch (error) {
        if (error instanceof ToolError) throw error
        if (context.signal.aborted) fail("CPA image request aborted")
        fail("CPA image file operation failed")
      }
    },
  }
}
