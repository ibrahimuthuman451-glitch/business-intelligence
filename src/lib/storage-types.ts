export interface StorageDriver {
  readonly name: string;
  put(key: string, bytes: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  list?(prefix: string): Promise<{ key: string; sizeBytes: number }[]>;
}
