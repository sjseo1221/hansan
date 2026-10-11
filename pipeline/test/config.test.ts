// 설정 파일 정합성 시험 — 운영자가 파일을 고쳐도 서로 어긋나지 않게 한다 (FR-OPS-05, FR-TYPE-10)
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const load = async (name: string) => parse(await readFile(`config/${name}.yaml`, "utf8"));

describe("config", () => {
  it("모든 설정 파일이 읽힌다", async () => {
    for (const name of ["sources", "thresholds", "categories", "companions", "regions", "llm"]) {
      expect(await load(name), name).toBeTruthy();
    }
  });

  it("동행 적합 표는 정의된 분류만 쓴다", async () => {
    const ids = new Set((await load("categories")).categories.map((c: any) => c.id));
    for (const c of (await load("companions")).companions) {
      for (const s of c.suitable) expect(ids.has(s), `${c.id} → ${s}`).toBe(true);
    }
  });

  it("동행 유형은 명세서의 5종이다 (FR-FLT-03)", async () => {
    const labels = (await load("companions")).companions.map((c: any) => c.label);
    expect(labels).toEqual(["아이 동반", "커플", "부모님 동반", "친구", "혼자"]);
  });

  it("대표 유형 순서는 다섯 유형을 한 번씩 모두 담는다 (FR-TYPE-07)", async () => {
    const t = await load("thresholds");
    expect([...t.representativePriority].sort()).toEqual(Object.keys(t.types).sort());
  });

  it("한산 가능성 구간과 인기도 가중치가 올바르다", async () => {
    const t = await load("thresholds");
    expect(t.quietLikelihood.highMax).toBeLessThan(t.quietLikelihood.mediumMax);
    expect(t.popularity.searchWeight + t.popularity.blogWeight).toBeCloseTo(1);
  });

  it("서울 장소 카테고리가 모두 분류에 연결된다 (FR-SCORE-07)", async () => {
    const cat = await load("categories");
    const ids = new Set(cat.categories.map((c: any) => c.id));
    const places = JSON.parse(await readFile("data/sources/seoul/places.json", "utf8")).places;
    for (const p of places) {
      const mapped = cat.seoulCategoryMap[p.category];
      expect(ids.has(mapped), `${p.areaCd} ${p.category}`).toBe(true);
    }
  });

  it("대화 비용 차단선은 월 예산보다 낮다 (NFR-COST-03)", async () => {
    const llm = await load("llm");
    expect(llm.budget.appCutoffUsd).toBeLessThan(llm.budget.monthlyUsd);
  });
});
