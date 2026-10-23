import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

export interface Sticker {
  id: string;
  name: string;
  emotions: string[];
  filepath: string;
  mimeType: string;
  addedAt?: string;
}
export interface StickerWithThumb extends Sticker { thumb: string | null; }

const THUMB_SIZE = 96;
const INLINE_SIZE_LIMIT = 700 * 1024;
const ALLOWED_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];
const MIME_BY_FORMAT: Record<string, string> = {
  png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", avif: "image/avif"
};

async function validateImage(buffer: Buffer, fallbackMimeType: string): Promise<string> {
  if (!buffer.length) throw new Error("Image is empty.");
  let detected = fallbackMimeType;
  try {
    const meta = await sharp(buffer, { animated: true }).metadata();
    detected = meta.format ? MIME_BY_FORMAT[meta.format] ?? "" : "";
  } catch { throw new Error("Invalid image data."); }
  if (!ALLOWED_MIME.includes(detected)) throw new Error(`Unsupported image type '${detected || fallbackMimeType}'.`);
  return detected;
}

type StoredSticker = Omit<Sticker, "filepath"> & { filename: string };

export class StickerStorage {
  private dataFile: string;
  private imageDir: string;
  private thumbCache = new Map<string, string>();
  private githubToken = process.env.GITHUB_TOKEN?.trim() || "";
  private githubRepo = process.env.GITHUB_REPO?.trim() || "";
  private get remoteEnabled() { return Boolean(this.githubToken && this.githubRepo); }

  constructor(baseDir: string) {
    this.dataFile = path.join(baseDir, "stickers.json");
    this.imageDir = path.join(baseDir, "images");
    if (Boolean(this.githubToken) !== Boolean(this.githubRepo)) {
      throw new Error("Set both GITHUB_TOKEN and GITHUB_REPO to enable GitHub persistence.");
    }
    if (this.githubRepo && !/^[\w.-]+\/[\w.-]+$/.test(this.githubRepo)) {
      throw new Error("GITHUB_REPO must use owner/repository format.");
    }
  }

  private apiUrl(filePath: string) {
    return "https://api.github.com/repos/" + this.githubRepo + "/contents/" +
      filePath.split("/").map(encodeURIComponent).join("/");
  }

  private async githubRequest(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers
      }
    });
    if (!response.ok && response.status !== 404) {
      const detail = await response.text().catch(() => "");
      throw new Error(`GitHub storage request failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    return response;
  }

  private async getRemoteFile(filePath: string): Promise<{ buffer: Buffer; sha: string } | null> {
    const response = await this.githubRequest(this.apiUrl(filePath));
    if (response.status === 404) return null;
    const json = await response.json() as { content?: string; sha: string; encoding?: string };
    if (!json.content || json.encoding !== "base64") throw new Error(`Unexpected GitHub file response for ${filePath}`);
    return { buffer: Buffer.from(json.content.replace(/\n/g, ""), "base64"), sha: json.sha };
  }

  private async putRemoteFile(filePath: string, buffer: Buffer, message: string): Promise<void> {
    const existing = await this.getRemoteFile(filePath);
    const body: Record<string, string> = {
      message,
      content: buffer.toString("base64")
    };
    if (existing) body.sha = existing.sha;
    const response = await this.githubRequest(this.apiUrl(filePath), {
      method: "PUT", body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`Could not save ${filePath} to GitHub.`);
  }

  private async deleteRemoteFile(filePath: string, message: string): Promise<void> {
    const existing = await this.getRemoteFile(filePath);
    if (!existing) return;
    const response = await this.githubRequest(this.apiUrl(filePath), {
      method: "DELETE",
      body: JSON.stringify({ message, sha: existing.sha })
    });
    if (!response.ok) throw new Error(`Could not delete ${filePath} from GitHub.`);
  }

  private async readLocalStickers(): Promise<Sticker[]> {
    return JSON.parse(await fs.readFile(this.dataFile, "utf-8")) as Sticker[];
  }

  private async writeLocalStickers(stickers: Sticker[]): Promise<void> {
    await fs.writeFile(this.dataFile, JSON.stringify(stickers, null, 2));
  }

  private async saveRemoteIndex(stickers: Sticker[]): Promise<void> {
    if (!this.remoteEnabled) return;
    const stored: StoredSticker[] = stickers.map(({ filepath, ...s }) => ({
      ...s, filename: path.basename(filepath)
    }));
    await this.putRemoteFile("stickers.json", Buffer.from(JSON.stringify(stored, null, 2)), "Update sticker library index");
  }

  async init() {
    await fs.mkdir(this.imageDir, { recursive: true });
    if (this.remoteEnabled) {
      const remote = await this.getRemoteFile("stickers.json");
      if (!remote) {
        await this.putRemoteFile("stickers.json", Buffer.from("[]"), "Initialize sticker library");
        await this.writeLocalStickers([]);
        return;
      }
      const stored = JSON.parse(remote.buffer.toString("utf-8")) as StoredSticker[];
      const stickers: Sticker[] = [];
      for (const item of stored) {
        const filename = item.filename || path.basename(item.filepath || "");
        if (!filename) continue;
        const image = await this.getRemoteFile(`images/${filename}`);
        if (!image) {
          console.warn(`Missing image in GitHub storage: images/${filename}`);
          continue;
        }
        const filepath = path.join(this.imageDir, filename);
        await fs.writeFile(filepath, image.buffer);
        const { filename: _filename, ...fields } = item;
        stickers.push({ ...fields, filepath } as Sticker);
      }
      await this.writeLocalStickers(stickers);
      return;
    }
    try { await fs.access(this.dataFile); }
    catch { await fs.writeFile(this.dataFile, "[]"); }
  }

  async getAllStickers(): Promise<Sticker[]> { return this.readLocalStickers(); }

  async getById(id: string): Promise<Sticker | null> {
    return (await this.getAllStickers()).find(s => s.id === id) ?? null;
  }

  async findByQuery(query: string): Promise<{ picked: Sticker | null; matches: Sticker[] }> {
    const stickers = await this.getAllStickers();
    const q = query.trim().toLowerCase();
    const matches = stickers.filter(s => [...s.emotions, s.name].map(e => e.toLowerCase())
      .some(t => t.includes(q) || (t.length >= 2 && q.includes(t))));
    return { picked: matches.length ? matches[crypto.randomInt(matches.length)] ?? null : null, matches };
  }

  async addSticker(name: string, emotions: string[], imageBuffer: Buffer, mimeType: string): Promise<Sticker> {
    const safeMimeType = await validateImage(imageBuffer, mimeType);
    const id = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const ext = (safeMimeType.split("/")[1] || "png").replace("+xml", "");
    const filename = `${id}.${ext}`;
    const filepath = path.join(this.imageDir, filename);
    const sticker: Sticker = {
      id, name, emotions: emotions.map(e => e.trim()).filter(Boolean),
      filepath, mimeType: safeMimeType, addedAt: new Date().toISOString()
    };
    await fs.writeFile(filepath, imageBuffer);
    const stickers = await this.getAllStickers();
    stickers.push(sticker);
    if (this.remoteEnabled) {
      await this.putRemoteFile(`images/${filename}`, imageBuffer, `Add sticker image: ${name}`);
      await this.saveRemoteIndex(stickers);
    }
    await this.writeLocalStickers(stickers);
    return sticker;
  }

  async addStickerFromBase64(name: string, emotions: string[], base64Data: string, mimeType: string): Promise<Sticker> {
    const cleaned = base64Data.replace(/^data:image\/[\w.+-]+;base64,/, "");
    return this.addSticker(name, emotions, Buffer.from(cleaned, "base64"), mimeType);
  }

  async updateSticker(id: string, patch: { name?: string; emotions?: string[] }): Promise<Sticker | null> {
    const stickers = await this.getAllStickers();
    const sticker = stickers.find(s => s.id === id);
    if (!sticker) return null;
    if (patch.name !== undefined) sticker.name = patch.name;
    if (patch.emotions !== undefined) sticker.emotions = patch.emotions.map(e => e.trim()).filter(Boolean);
    if (this.remoteEnabled) await this.saveRemoteIndex(stickers);
    await this.writeLocalStickers(stickers);
    return sticker;
  }

  async deleteSticker(id: string): Promise<boolean> {
    const stickers = await this.getAllStickers();
    const index = stickers.findIndex(s => s.id === id);
    if (index < 0) return false;
    const [deleted] = stickers.splice(index, 1);
    if (this.remoteEnabled) {
      await this.saveRemoteIndex(stickers);
      if (deleted) await this.deleteRemoteFile(`images/${path.basename(deleted.filepath)}`, `Delete sticker image: ${deleted.name}`);
    }
    await this.writeLocalStickers(stickers);
    this.thumbCache.delete(id);
    if (deleted) await fs.unlink(deleted.filepath).catch(() => {});
    return true;
  }

  publicFilename(sticker: Sticker): string { return path.basename(sticker.filepath); }

  async readForInline(sticker: Sticker): Promise<{ buffer: Buffer; mimeType: string }> {
    let buffer = await fs.readFile(sticker.filepath);
    let mimeType = sticker.mimeType;
    if (buffer.length > INLINE_SIZE_LIMIT) {
      try {
        buffer = await sharp(buffer, { animated: mimeType === "image/gif" })
          .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 75 }).toBuffer();
        mimeType = "image/webp";
      } catch {}
    }
    return { buffer, mimeType };
  }

  async getThumb(sticker: Sticker): Promise<string | null> {
    const cached = this.thumbCache.get(sticker.id);
    if (cached) return cached;
    try {
      const buffer = await sharp(sticker.filepath)
        .resize({ width: THUMB_SIZE, height: THUMB_SIZE, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 70 }).toBuffer();
      const thumb = `data:image/webp;base64,${buffer.toString("base64")}`;
      this.thumbCache.set(sticker.id, thumb);
      return thumb;
    } catch { return null; }
  }

  async withThumbs(stickers: Sticker[]): Promise<StickerWithThumb[]> {
    return Promise.all(stickers.map(async s => ({ ...s, thumb: await this.getThumb(s) })));
  }
}
