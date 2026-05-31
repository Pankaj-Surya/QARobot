export async function withPlaywrightMcp<T>(callback: () => Promise<T>) {
  return callback();
}
