/**
 * A deterministic random stream.
 *
 * A seeder has to produce the same data twice from the same `--seed`, and it has
 * to produce the same row twice from the same identity, so that re-running it
 * does not rewrite rows it already wrote. One stream per run cannot do the
 * second; `fork` gives a stream per label, derived from the seed.
 *
 * No dependency: this is arithmetic, which is why it belongs in the core.
 */

/** 32-bit string hash (xmur3), so a seed can be any label, including a row id. */
function hashSeed(value: string): number {
  let hash = 1779033703 ^ value.length;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return (hash ^= hash >>> 16) >>> 0;
}

export class Random {
  readonly label: string;
  private state: number;

  constructor(seed: string | number) {
    this.label = String(seed);
    this.state = hashSeed(this.label);
  }

  /** The next value in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in `[min, max]`, both ends included. */
  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
      throw new Error(`int(${min}, ${max}) takes whole numbers, min first.`);
    }
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** A number in `[min, max)`. */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  /** One element of a non-empty list. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick() needs a non-empty list.");
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** One element, chosen by weight (evenly when no weights are given). */
  weighted<T>(items: readonly T[], weights?: readonly number[]): T {
    if (items.length === 0) throw new Error("weighted() needs a non-empty list.");
    const each = weights ?? items.map(() => 1);
    if (each.length !== items.length) throw new Error("weighted() takes one weight per item.");
    const total = each.reduce((sum, weight) => sum + weight, 0);
    if (total <= 0) throw new Error("weighted() needs weights that add up to more than zero.");
    let point = this.next() * total;
    for (let index = 0; index < items.length; index += 1) {
      point -= each[index] ?? 0;
      if (point < 0) return items[index] as T;
    }
    return items[items.length - 1] as T;
  }

  /** A moment `days` back from `from` (default: now). */
  past(options: { days?: number; from?: Date | number } = {}): Date {
    const days = options.days ?? 365;
    const from = options.from === undefined ? Date.now() : new Date(options.from).getTime();
    return new Date(from - Math.floor(this.next() * days * 86_400_000));
  }

  /** A moment `days` ahead of `from` (default: now). */
  future(options: { days?: number; from?: Date | number } = {}): Date {
    const days = options.days ?? 365;
    const from = options.from === undefined ? Date.now() : new Date(options.from).getTime();
    return new Date(from + Math.floor(this.next() * days * 86_400_000));
  }

  /** A moment between two instants. */
  between(from: Date | number, to: Date | number): Date {
    const start = new Date(from).getTime();
    const end = new Date(to).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      throw new Error("between() takes two instants, earliest first.");
    }
    return new Date(start + Math.floor(this.next() * (end - start)));
  }

  /** Lowercase hex of `length` characters. */
  hex(length: number): string {
    let out = "";
    while (out.length < length) {
      out += Math.floor(this.next() * 0x10000).toString(16).padStart(4, "0");
    }
    return out.slice(0, length);
  }

  /**
   * A UUID-shaped id. Deterministic, and shaped like the client's, so a seeded
   * row looks like one the app created.
   */
  uuid(): string {
    const hex = this.hex(32);
    const variant = ((parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  /**
   * An independent stream for one label, derived from this one's seed. The same
   * label gives the same values whatever else the run did first.
   */
  fork(label: string): Random {
    return new Random(`${this.label}/${label}`);
  }
}
