// 상단 검색 — 추천 피드의 장소 카드를 이름·지역·유형 글자로 걸러 낸다. 다른 화면에서는 피드로 보내 같은 검색어를 적용한다
export function initSearch() {
  const form = document.getElementById("search") as HTMLFormElement;
  const input = document.getElementById("q") as HTMLInputElement;
  const feed = document.getElementById("feed");
  input.value = new URLSearchParams(location.search).get("q") ?? "";
  if (!feed) return; // 피드가 없는 화면은 form 이 / 로 이동한다

  const apply = () => {
    const q = input.value.trim().toLowerCase();
    feed.querySelectorAll<HTMLElement>(".card").forEach((c) => {
      c.hidden = q !== "" && !(c.textContent ?? "").toLowerCase().includes(q);
    });
  };
  form.addEventListener("submit", (e) => e.preventDefault());
  input.addEventListener("input", apply);
  new MutationObserver(apply).observe(feed, { childList: true }); // 피드가 다시 그려져도 검색어를 유지한다
  apply();
}
