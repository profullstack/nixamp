// A stand-in for ffmpeg in tests: copy stdin to stdout, ignore every flag,
// and stay alive until stdin ends. Enough for a channel to have a live
// "decoder" whose output flows to listeners while its input is tapped.
process.stdin.on("data", (chunk) => process.stdout.write(chunk));
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdout.on("error", () => process.exit(0));
