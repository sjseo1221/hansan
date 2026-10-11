import { join } from "node:path";
import { readJson, writeJson } from "./store.js";

// 출처별 하루(KST) 호출 수 기록과 상한 (FR-DATA-10, NFR-COST-02)
export class DailyUsage {
  private count = 0;

  private constructor(
    private readonly path: string,
    readonly cap: number,
  ) {}

  static async load(dataDir: string, source: string, date: string, cap: number) {
    const u = new DailyUsage(join(dataDir, "state", "usage", source, `${date}.json`), cap);
    u.count = (await readJson<{ count: number }>(u.path, { count: 0 })).count;
    return u;
  }

  get used() {
    return this.count;
  }

  tryConsume(): boolean {
    if (this.count >= this.cap) return false;
    this.count++;
    return true;
  }

  save() {
    return writeJson(this.path, { count: this.count, cap: this.cap });
  }
}
