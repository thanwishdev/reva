// Exit only after stdout and stderr have been handed to the OS. On macOS a pipe write from process.stdout is asynchronous:
// process.exit() right after a big write (reva look --json is ~0.3 MB) cut the output at 64 KiB when piped to a file or jq.
export function exitFlushed(code, { stdout = process.stdout, stderr = process.stderr, exit = process.exit } = {}) {
  let left = 2, done = false;
  const one = () => { if (!done && --left === 0) { done = true; exit(code); } };
  // an empty write is queued behind everything written before it; its callback runs when that is flushed
  for (const s of [stdout, stderr]) { try { s.write('', one); } catch { one(); } }
  // never hang on a closed or stuck pipe (the reader went away): leave after 3 s whatever happened
  setTimeout(() => { if (!done) { done = true; exit(code); } }, 3000).unref();
}
