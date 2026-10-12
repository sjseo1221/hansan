import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}

// 임시 파일에 쓴 뒤 rename — 쓰는 도중 실패해도 직전 파일이 깨지지 않는다 (FR-DATA-11)
// indent 0 = 한 줄(큰 결과 파일 — 저장소 용량)
export async function writeJson(path: string, data: unknown, indent = 2): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, indent || undefined) + "\n", "utf8");
  await rename(tmp, path);
}

export async function appendJsonl(path: string, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

// JSONL 을 통째로 원자적으로 쓴다(중복 제거 후 다시 쓸 때)
export async function writeLines(path: string, rows: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  await rename(tmp, path);
}
