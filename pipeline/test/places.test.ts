import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectCnctr, type Attraction } from "../src/collect/cnctr.js";
import type { Candidate } from "../src/collect/tour.js";
import type { DgGet } from "../src/lib/datagokr.js";
import { buildPlaces, categoryOf, keywordOf, regionHeadsOf, validCoord, type CategoryConfig, type Place } from "../src/places/build.js";
import { inSigungu, matchOne, norm } from "../src/places/match.js";

const cand = (o: Partial<Candidate>): Candidate => ({
  contentid: "1", contenttypeid: "12", title: "x", addr1: "서울특별시 종로구 어딘가", mapx: 127, mapy: 37.5,
  lDongRegnCd: "11", lDongSignguCd: "110", lclsSystm1: "HS", lclsSystm2: "HS01", lclsSystm3: "HS0101", modifiedtime: "20260101", ...o,
});
const attr = (o: Partial<Attraction>): Attraction => ({
  areaCd: "11", signguCd: "11110", signguNm: "종로구", tAtsNm: "x", firstSeen: "2026-10-12", lastSeen: "2026-10-12", ...o,
});
const byProv = (cs: Candidate[]) => {
  const m = new Map<string, Candidate[]>();
  for (const c of cs) (m.get(c.lDongRegnCd) ?? m.set(c.lDongRegnCd, []).get(c.lDongRegnCd)!).push(c);
  return m;
};
const tp = ["12", "14", "28", "15", "38"];
const cfg: CategoryConfig = {
  categories: [{ id: "heritage", indoor: "outdoor" }, { id: "exhibition", indoor: "indoor" }, { id: "nature_park", indoor: "outdoor" }],
  lclsMap: { HS: "heritage", VE07: "exhibition", NA: "nature_park" },
  typeFallback: { "12": "nature_park" },
  typePriority: tp,
};

describe("norm", () => {
  it("괄호·가운뎃점·공백·엔티티·대소문자를 지운다", () => {
    expect(norm("KT&amp;G 상상마당 (춘천)")).toBe("kt&g상상마당");
    expect(norm("광화문·덕수궁")).toBe("광화문덕수궁");
  });
});

describe("matchOne", () => {
  it("같은 시·군·구 주소의 원문 일치가 우선이고 신뢰도 high", () => {
    const m = matchOne(attr({ tAtsNm: "경복궁" }), byProv([cand({ contentid: "9", title: "경복궁" })]), { typePriority: tp });
    expect(m).toMatchObject({ method: "exact", confidence: "high" });
  });
  it("정규화 일치", () => {
    const m = matchOne(attr({ tAtsNm: "광화문·덕수궁" }), byProv([cand({ title: "광화문 덕수궁" })]), { typePriority: tp });
    expect(m?.method).toBe("normalized");
  });
  it("동명 후보가 여럿이면 유형 우선순위로 하나를 고르고 ambiguous 로 표시", () => {
    const m = matchOne(attr({ tAtsNm: "서울숲" }), byProv([cand({ contentid: "a", title: "서울숲", contenttypeid: "28" }), cand({ contentid: "b", title: "서울숲", contenttypeid: "12" })]), { typePriority: tp });
    expect(m).toMatchObject({ ambiguous: true, confidence: "medium" });
    expect(m?.candidate.contentid).toBe("b");
  });
  it("다른 시·도의 동명은 연결하지 않는다", () => {
    expect(matchOne(attr({ tAtsNm: "중앙공원" }), byProv([cand({ title: "중앙공원", lDongRegnCd: "41" })]), { typePriority: tp })).toBeNull();
  });
  it("주소에 시·군·구가 없으면 시·도 전체에서 일치만 보고 신뢰도 medium — 인천 개편 코드 불일치 대응", () => {
    const m = matchOne(attr({ areaCd: "28", signguCd: "28110", signguNm: "중구", tAtsNm: "개항장 거리" }), byProv([cand({ title: "개항장 거리", lDongRegnCd: "28", addr1: "인천광역시 제물포구 신포로" })]), { typePriority: tp });
    expect(m).toMatchObject({ method: "exact", confidence: "medium" });
  });
  it("포함 관계는 시·군·구 안에서 1건일 때만, 짧은 쪽 3자 이상", () => {
    expect(matchOne(attr({ tAtsNm: "북촌한옥마을" }), byProv([cand({ title: "북촌한옥마을 전망대" })]), { typePriority: tp })?.method).toBe("partial");
    expect(matchOne(attr({ tAtsNm: "궁" }), byProv([cand({ title: "경복궁" })]), { typePriority: tp })).toBeNull();
  });
  it("수동 매칭이 우선하고, contentId null 이면 자동 매칭을 막는다", () => {
    const c = cand({ contentid: "77", title: "엉뚱한 이름" });
    const byId = new Map([["77", c]]);
    expect(matchOne(attr({ tAtsNm: "가" }), byProv([c]), { typePriority: tp, manual: new Map([["11110|가", "77"]]), byId })?.method).toBe("manual");
    expect(matchOne(attr({ tAtsNm: "경복궁" }), byProv([cand({ title: "경복궁" })]), { typePriority: tp, manual: new Map([["11110|경복궁", null]]), byId })).toBeNull();
  });
});

describe("2차 리뷰 오매칭 재발 방지", () => {
  const heads = regionHeadsOf(["종로구", "동구", "남동구", "평창군", "영월군", "군포시", "시흥시", "양주시", "남양주시", "수원시 장안구"]);
  it("시·군·구는 주소 낱말 단위로 비교 — '동구'가 '남동구'에, '양주시'가 '남양주시'에 걸리지 않는다", () => {
    expect(inSigungu("인천광역시 남동구 소래로", "동구")).toBe(false);
    expect(inSigungu("인천광역시 동구 송림로", "동구")).toBe(true);
    expect(inSigungu("경기도 남양주시 화도읍", "양주시")).toBe(false);
    expect(inSigungu("경기도 수원시 장안구 영화동", "수원시 장안구")).toBe(true);
  });
  it("괄호 속 지역이 다르면 같은 이름이어도 연결하지 않는다 — 백덕산(평창) ≠ 백덕산(영월)", () => {
    const a = attr({ areaCd: "51", signguCd: "51760", signguNm: "평창군", tAtsNm: "백덕산(평창)" });
    expect(matchOne(a, byProv([cand({ title: "백덕산(영월)", lDongRegnCd: "51", addr1: "강원특별자치도 영월군 수주면" })]), { typePriority: tp, regionHeads: heads })).toBeNull();
  });
  it("다른 시·군·구 후보는 원문이 정확히 같을 때만 — 중앙공원(군포) 이 중앙공원(시흥)에 붙지 않는다", () => {
    const a = attr({ areaCd: "41", signguCd: "41410", signguNm: "군포시", tAtsNm: "중앙공원" });
    expect(matchOne(a, byProv([cand({ title: "중앙공원(시흥)", lDongRegnCd: "41", addr1: "경기도 시흥시 정왕동" })]), { typePriority: tp, regionHeads: heads })).toBeNull();
    // 원문이 정확히 같은 1건은 경계 장소일 수 있어 medium 으로 연결
    expect(matchOne(a, byProv([cand({ title: "중앙공원", lDongRegnCd: "41", addr1: "경기도 안양시 동안구" })]), { typePriority: tp, regionHeads: heads })?.confidence).toBe("medium");
  });
  it("시·도 표기는 시·군·구 표기와 충돌로 보지 않는다 — 봉선사(경기) = 봉선사(남양주)", () => {
    const a = attr({ areaCd: "41", signguCd: "41360", signguNm: "남양주시", tAtsNm: "봉선사(경기)" });
    expect(matchOne(a, byProv([cand({ title: "봉선사(남양주)", lDongRegnCd: "41", addr1: "경기도 남양주시 진접읍 봉선사길 32" })]), { typePriority: tp, regionHeads: heads })?.method).toBe("normalized");
  });
  it("괄호가 지역명이 아니면 무시한다 — 풍물시장(2, 7일)", () => {
    const a = attr({ areaCd: "51", signguCd: "51110", signguNm: "춘천시", tAtsNm: "풍물시장" });
    expect(matchOne(a, byProv([cand({ title: "춘천 풍물시장(2, 7일)", lDongRegnCd: "51", addr1: "강원특별자치도 춘천시 온의동" })]), { typePriority: tp, regionHeads: heads })?.method).toBe("partial");
  });
});

describe("좌표 검증 (2차 리뷰 Critical)", () => {
  it("빈 좌표·한국 밖 좌표 후보는 장소가 되지 않는다", () => {
    expect(validCoord(37.5, 127)).toBe(true);
    expect(validCoord(0, 0)).toBe(false);
    expect(validCoord(NaN, 127)).toBe(false);
  });
});

describe("분류와 검색어", () => {
  it("신분류가 있으면 신분류로만 판단 — 숙박 같은 제외 대상을 유형으로 되살리지 않는다", () => {
    expect(categoryOf(cand({ lclsSystm1: "AC", lclsSystm2: "AC01", contenttypeid: "12" }), cfg)).toBeNull();
    expect(categoryOf(cand({ lclsSystm1: "VE", lclsSystm2: "VE07" }), cfg)).toBe("exhibition");
    expect(categoryOf(cand({ lclsSystm1: "", lclsSystm2: "", contenttypeid: "12" }), cfg)).toBe("nature_park");
  });
  it("짧은 이름은 시·군·구 이름을 앞에 붙인다", () => {
    expect(keywordOf("경복궁 (사적)", "종로구")).toBe("종로 경복궁");
    expect(keywordOf("북촌한옥마을", "종로구")).toBe("북촌한옥마을");
    expect(keywordOf("광교산", "수원시 장안구")).toBe("수원 광교산");
    expect(keywordOf("문충사", "동구")).toBe("동구 문충사");
  });
});

describe("buildPlaces", () => {
  const base = {
    candidates: [cand({ contentid: "1", title: "경복궁" }), cand({ contentid: "2", title: "국립민속박물관", lclsSystm1: "VE", lclsSystm2: "VE07" })],
    attractions: [attr({ tAtsNm: "경복궁" }), attr({ tAtsNm: "국립민속박물관" }), attr({ tAtsNm: "없는곳" })],
    sigunguNames: { "11110": "종로구" },
    seoulPlaces: [{ areaCd: "POI009", areaNm: "경복궁" }],
    overrides: {},
    previous: [] as Place[],
    cfg,
    today: "2026-10-12",
  };

  it("매칭된 장소를 SRS 9절 필드로 만들고 지표를 계산한다", () => {
    const { places, report } = buildPlaces(base);
    expect(places.map((p) => p.placeId)).toEqual(["kto-1", "kto-2"]);
    expect(places[0]).toMatchObject({ category: "heritage", indoor: "outdoor", region: { provinceCd: "11", signguCd: "11110", signgu: "종로구" }, external: { seoulAreaCd: "POI009" } });
    expect(report).toMatchObject({ matchRate: 0.667, unmatched: { count: 1 }, completeness: { requiredFields: 1 } });
  });

  it("overrides 숨김·검색어 보정, 직전 장소 유지, 직전 숨김 보존", () => {
    const previous = [{ ...buildPlaces(base).places[1], placeId: "kto-old", hidden: true } as Place];
    const { places, report } = buildPlaces({ ...base, previous, overrides: { places: { "kto-1": { hidden: true, keyword: "경복궁 궁궐" } } } });
    expect(places.find((p) => p.placeId === "kto-1")).toMatchObject({ hidden: true, keyword: "경복궁 궁궐" });
    expect(places.find((p) => p.placeId === "kto-old")?.hidden).toBe(true);
    expect(report.warnings.join()).toContain("kto-old");
  });

  it("보이는 장소가 직전보다 30% 넘게 줄면 막는다", () => {
    const previous = Array.from({ length: 10 }, (_, i) => ({ ...buildPlaces(base).places[0], placeId: `kto-p${i}` }) as Place);
    // 직전 10곳 + 이번 2곳이 합쳐지므로 직전 장소를 모두 숨김으로 보정해 급감 상황을 만든다
    const hideAll = Object.fromEntries(previous.map((p) => [p.placeId, { hidden: true }]));
    expect(buildPlaces({ ...base, previous, overrides: { places: hideAll } }).report.shrinkBlocked).toBe(true);
  });

  it("없는 분류로 보정하면 실패한다", () => {
    expect(() => buildPlaces({ ...base, overrides: { places: { "kto-1": { category: "cafe" } } } })).toThrow("없는 분류");
  });
});

describe("collectCnctr", () => {
  const now = new Date("2026-10-12T03:00:00Z"); // KST 12:00, 월요일
  const get: DgGet = async (_p, params) => {
    if (params.signguCd === "41110") return { totalCount: 0, items: [] };
    if (params.signguCd === "99999") throw Object.assign(new Error("x"), { name: "HTTP_500" });
    return {
      totalCount: 2,
      items: [
        { baseYmd: "20261012", areaCd: "11", areaNm: "서울특별시", signguCd: params.signguCd, signguNm: "종로구", tAtsNm: "경복궁", cnctrRate: "55.5" },
        { baseYmd: "20261013", areaCd: "11", areaNm: "서울특별시", signguCd: params.signguCd, signguNm: "종로구", tAtsNm: "경복궁", cnctrRate: "60" },
      ],
    };
  };

  it("최신 예측을 시·군·구 단위로 저장하고 오늘 값만 이력에 쌓으며, 응답 없는 코드는 비활성으로 기록한다", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "hansan-cnctr-"));
    const res = await collectCnctr({ candidates: [{ code: "11110", name: "종로구" }, { code: "41110", name: "수원시" }, { code: "99999", name: "x" }], cfg: { dailyCap: 100 }, get, dataDir, now });
    expect(res).toMatchObject({ ok: 1, empty: 1, failed: 1, activeCodes: 1 });
    const latest = JSON.parse(await readFile(join(dataDir, "latest", "cnctr.json"), "utf8"));
    expect(latest.sigungu["11110"].attractions["경복궁"]).toEqual({ "20261012": 55.5, "20261013": 60 });
    const histPath = join(dataDir, "raw", "cnctr_history", "2026-10", "12.jsonl");
    expect((await readFile(histPath, "utf8")).trim().split("\n")).toHaveLength(1);
    const attrs = JSON.parse(await readFile(join(dataDir, "sources", "cnctr", "attractions.json"), "utf8")).attractions;
    expect(attrs).toEqual([expect.objectContaining({ signguCd: "11110", tAtsNm: "경복궁" })]);

    // 같은 날 다시 돌아도 이력은 한 줄 그대로 (2차 리뷰: 실행 횟수만큼 중복되던 문제)
    await collectCnctr({ candidates: [{ code: "11110", name: "종로구" }], cfg: { dailyCap: 100 }, get, dataDir, now });
    expect((await readFile(histPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("잘 나오던 시·군·구가 한 번 비면 실패로 알리고 활성은 유지, 두 번째에 비활성 — 1만 건 넘게 잘리면 실패", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "hansan-cnctr-"));
    await collectCnctr({ candidates: [{ code: "11110", name: "종로구" }], cfg: { dailyCap: 100 }, get, dataDir, now });
    const emptyGet: DgGet = async () => ({ totalCount: 0, items: [] });
    const r1 = await collectCnctr({ candidates: [{ code: "11110", name: "종로구" }], cfg: { dailyCap: 100 }, get: emptyGet, dataDir, now });
    expect(r1).toMatchObject({ failed: 1, activeCodes: 1 });
    const r2 = await collectCnctr({ candidates: [{ code: "11110", name: "종로구" }], cfg: { dailyCap: 100 }, get: emptyGet, dataDir, now });
    expect(r2).toMatchObject({ activeCodes: 0 });

    const cut: DgGet = async () => ({ totalCount: 20000, items: [{ baseYmd: "20261012", areaCd: "11", areaNm: "서울", signguCd: "11140", signguNm: "중구", tAtsNm: "a", cnctrRate: "1" }] });
    const r3 = await collectCnctr({ candidates: [{ code: "11140", name: "중구" }], cfg: { dailyCap: 100 }, get: cut, dataDir: await mkdtemp(join(tmpdir(), "hansan-cnctr-")), now });
    expect(r3).toMatchObject({ ok: 0, failed: 1 });
  });

  it("후보가 비면 오류로 끝낸다", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "hansan-cnctr-"));
    await expect(collectCnctr({ candidates: [], cfg: { dailyCap: 1 }, get, dataDir, now })).rejects.toThrow("비어 있음");
  });
});

describe("TourAPI 후보 코드 정규화", () => {
  it("세종처럼 시·도 코드가 5자리로 오면 2자리 + 시·군·구 3자리로 나눈다 (2026-10-12 첫 실행 0건 원인)", async () => {
    const { fetchCandidates } = await import("../src/collect/tour.js");
    const { DailyUsage } = await import("../src/lib/usage.js");
    const usage = await DailyUsage.load(await mkdtemp(join(tmpdir(), "hansan-tour-")), "tour", "2026-10-12", 10);
    const seen: Record<string, string>[] = [];
    const get: DgGet = async (_p, params) => {
      seen.push(params);
      return { totalCount: 1, items: [{ contentid: 1, contenttypeid: 12, title: "국립세종수목원", lDongRegnCd: "36110", lDongSignguCd: "", mapx: "127", mapy: "36" }] };
    };
    const [c] = await fetchCandidates(get, usage, "36110", [{ contentTypeId: "12" }]);
    expect(seen[0].lDongRegnCd).toBe("36110");
    expect(c).toMatchObject({ lDongRegnCd: "36", lDongSignguCd: "110" });
  });
});
