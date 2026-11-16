import { emitKeypressEvents, type Key } from "node:readline";
import { createInterface } from "node:readline/promises";

export const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);

export async function ask(question: string, fallback: string): Promise<string> {
  if (!interactive()) return fallback;
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await input.question(question + " (" + fallback + "): ")).trim() || fallback; }
  finally { input.close(); }
}

/** Explicit choices, arrow keys, Enter to select, Escape/Ctrl+C to cancel. */
export async function select(question: string, choices: readonly string[], fallback = 0): Promise<number> {
  if (!choices.length || fallback < 0 || fallback >= choices.length) throw new Error("Invalid prompt choices.");
  if (!interactive()) return fallback;
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = Boolean(input.isRaw);
  const wasFlowing = input.readableFlowing;
  let selected = fallback;
  let drawn = false;
  emitKeypressEvents(input);
  return new Promise<number>((resolve, reject) => {
    const render = () => {
      if (drawn) output.write("\x1b[" + (choices.length + 1) + "A");
      output.write("\r\x1b[2K" + question + "  (↑/↓ choose, Enter select, Esc cancel)\n");
      choices.forEach((choice, index) => output.write("\r\x1b[2K" + (index === selected ? "  ❯ " : "    ") + choice + "\n"));
      drawn = true;
    };
    const cleanup = () => {
      input.off("keypress", onKey);
      input.off("end", onEnd);
      input.off("error", onError);
      input.setRawMode(wasRaw);
      if (wasFlowing !== true) input.pause();
      output.write("\x1b[?25h");
    };
    const finish = (cancelled: boolean) => {
      cleanup();
      if (cancelled) reject(new Error("Setup cancelled."));
      else resolve(selected);
    };
    const onEnd = () => finish(true);
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onKey = (_text: string, key: Key) => {
      if (key.name === "escape" || (key.ctrl && (key.name === "c" || key.name === "d"))) return finish(true);
      if (key.name === "up" || key.name === "down") {
        selected = (selected + (key.name === "up" ? -1 : 1) + choices.length) % choices.length;
        render();
      } else if (key.name === "return") finish(false);
    };
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKey);
    input.once("end", onEnd);
    input.once("error", onError);
    output.write("\x1b[?25l");
    render();
  });
}

export async function confirm(question: string, fallback = false): Promise<boolean> {
  return (await select(question, ["Yes", "No"], fallback ? 0 : 1)) === 0;
}
