import type { Asset } from "../types/scene";
export type FileSink = (
  path: string,
  bytes: Uint8Array | string,
) => Promise<void>;
export class AssetRegistry {
  readonly assets: Asset[] = [];
  private pending = new Map<string, Promise<Asset | undefined>>();
  constructor(private sink: FileSink) {}
  once(
    key: string,
    create: () => Promise<Asset | undefined>,
  ): Promise<Asset | undefined> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = create();
    this.pending.set(key, promise);
    return promise;
  }
  async add(asset: Asset, bytes: Uint8Array | string): Promise<Asset> {
    await this.sink(asset.path, bytes);
    this.assets.push(asset);
    return asset;
  }
}
