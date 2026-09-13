/** Access, billing and throttling failures are terminal. Only transient service
 * and transport failures may recover, with a bounded consecutive failure count. */
export function transientAudioError(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (typeof status === "number") return [408, 502, 503, 504].includes(status);
  return error instanceof TypeError || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
}
export function audioError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
