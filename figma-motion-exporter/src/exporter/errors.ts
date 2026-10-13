// Resource/API failures are recoverable; transport failures must abort the archive.
export class ExportAbortedError extends Error {
  readonly name = "ExportAbortedError";
}
export function rethrowAbort(error: unknown): void {
  if (error instanceof ExportAbortedError) throw error;
}
