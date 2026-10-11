import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectSeoul, parseResponse, type FetchText, type Place } from "../src/collect/seoul.js";
import type { SeoulCitydataConfig } from "../src/lib/config.js";

const fixture = (name: string) => readFile(join(__dirname, "fixtures", name), "utf8");

const cfg: SeoulCitydataConfig = {
  baseUrl: "http://example.test",
  service: "citydata_ppltn",
  dailyCap: 100,
  timeoutMs: 1000,
  concurrency: 2,
};

const places: Place[] = ["POI001", "POI002", "POI003"].map((areaCd) => ({ areaCd, areaNm: areaCd, category: "공원" }));

// 실호출 응답(POI009)을 요청한 장소 코드로 바꿔 돌려주는 가짜 fetch
async function fakeFetch(opts: { failFor?: string[]; throwFor?: string[] } = {}): Promise<FetchText> {
  const ok = await fixture("seoul-ok-POI009.json");
  const err = await fixture("seoul-err-INFO-100.xml");
  return async (url) => {
    const cd = url.split("/").pop()!;
    if (opts.throwFor?.includes(cd)) throw new Error("network");
    if (opts.failFor?.includes(cd)) return err;
    return ok.replaceAll("POI009", cd);
  };
}

const tmp = () => mkdtemp(join(tmpdir(), "hansan-"));
const now = new Date("2026-10-11T05:17:00Z"); // KST 14:17
const readLines = async (p: string) => (await readFile(p, "utf8")).trim().split("\n").map((l) => JSON.parse(l));

describe("parseResponse", () => {
  it("정상 JSON 응답에서 실측 필드를 뽑는다", async () => {
    const r = parseResponse(await fixture("seoul-ok-POI009.json"));
    expect(r).toEqual({
      ok: true,
      record: { areaCd: "POI009", areaNm: "광화문·덕수궁", congestLvl: "여유", ppltnMin: 2500, ppltnMax: 3000, ppltnTime: "2026-10-11 03:35" },
    });
  });

  it("XML 오류 응답에서 코드와 메시지를 뽑는다", async () => {
    const r = parseResponse(await fixture("seoul-err-INFO-100.xml"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("INFO-100");
      expect(r.message).toContain("인증키가 유효하지 않습니다");
    }
  });

  it("RESULT 가 정상이 아니거나 데이터가 비면 실패로 본다", () => {
    expect(parseResponse(JSON.stringify({ RESULT: { "RESULT.CODE": "INFO-200", "RESULT.MESSAGE": "해당하는 데이터가 없습니다." } })).ok).toBe(false);
    expect(parseResponse(JSON.stringify({ "SeoulRtd.citydata_ppltn": [], RESULT: { "RESULT.CODE": "INFO-000" } })).ok).toBe(false);
  });
});

describe("collectSeoul", () => {
  it("수집 결과를 KST 일별 JSONL 과 최신값에 출처·수집 일시와 함께 저장한다 (FR-DATA-12)", async () => {
    const dataDir = await tmp();
    const res = await collectSeoul({ places, cfg, key: "k", dataDir, now, fetchText: await fakeFetch() });
    expect(res).toEqual({ attempted: 3, ok: 3, failed: 0, skipped: 0 });

    const rows = await readLines(join(dataDir, "raw", "seoul_citydata", "2026-10", "11.jsonl"));
    expect(rows.map((r) => r.areaCd)).toEqual(["POI001", "POI002", "POI003"]);
    expect(rows[0]).toMatchObject({ source: "seoul_citydata", fetchedAt: "2026-10-11T14:17:00.000+09:00" });
  });

  it("실패한 장소는 직전 값을 유지하고 실패를 기록한다 (FR-DATA-11)", async () => {
    const dataDir = await tmp();
    await collectSeoul({ places, cfg, key: "k", dataDir, now, fetchText: await fakeFetch() });
    const later = new Date(now.getTime() + 3600_000);
    const res = await collectSeoul({ places, cfg, key: "k", dataDir, now: later, fetchText: await fakeFetch({ failFor: ["POI002"], throwFor: ["POI003"] }) });
    expect(res).toMatchObject({ ok: 1, failed: 2 });

    const latest = JSON.parse(await readFile(join(dataDir, "latest", "seoul_citydata.json"), "utf8"));
    expect(latest.places.POI001.fetchedAt).toBe("2026-10-11T15:17:00.000+09:00");
    expect(latest.places.POI002.fetchedAt).toBe("2026-10-11T14:17:00.000+09:00");
    expect(latest.places.POI003.fetchedAt).toBe("2026-10-11T14:17:00.000+09:00");

    const fails = await readLines(join(dataDir, "state", "failures", "2026-10.jsonl"));
    expect(fails.map((f) => f.code).sort()).toEqual(["Error", "INFO-100"]);
  });

  it("오류 기록에 인증키를 남기지 않는다 (NFR-SEC-01)", async () => {
    const dataDir = await tmp();
    await collectSeoul({ places, cfg, key: "SECRET-KEY-123", dataDir, now, fetchText: await fakeFetch({ throwFor: ["POI001"] }) });
    const text = await readFile(join(dataDir, "state", "failures", "2026-10.jsonl"), "utf8");
    expect(text).not.toContain("SECRET-KEY-123");
  });

  it("요청과 다른 장소가 오면 실패로 본다 (샘플 키는 항상 POI009 를 준다)", async () => {
    const dataDir = await tmp();
    const ok = await fixture("seoul-ok-POI009.json");
    const res = await collectSeoul({ places, cfg, key: "sample", dataDir, now, fetchText: async () => ok });
    expect(res).toMatchObject({ ok: 0, failed: 3 });
  });

  it("하루 상한에 닿으면 남은 장소를 다음 실행으로 넘긴다 (FR-DATA-10)", async () => {
    const dataDir = await tmp();
    const capped = { ...cfg, dailyCap: 2 };
    const first = await collectSeoul({ places, cfg: capped, key: "k", dataDir, now, fetchText: await fakeFetch() });
    expect(first).toMatchObject({ attempted: 2, skipped: 1 });

    // 같은 날 다시 돌면 상한이 이미 찼으므로 호출하지 않는다
    const second = await collectSeoul({ places, cfg: capped, key: "k", dataDir, now, fetchText: await fakeFetch() });
    expect(second).toMatchObject({ attempted: 0, skipped: 3 });

    // 다음 날은 지난번에 못 한 POI003 부터 시작한다
    const nextDay = new Date(now.getTime() + 24 * 3600_000);
    await collectSeoul({ places, cfg: { ...cfg, dailyCap: 1 }, key: "k", dataDir, now: nextDay, fetchText: await fakeFetch() });
    const rows = await readLines(join(dataDir, "raw", "seoul_citydata", "2026-10", "12.jsonl"));
    expect(rows.map((r) => r.areaCd)).toEqual(["POI003"]);
  });
});
