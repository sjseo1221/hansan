// OpenAI Responses API 호출 — 구조화 출력(JSON Schema strict)만 쓴다. 주기 작업과 대화 Worker 가 함께 쓰므로 fetch 만 쓴다.
// 2026-10-12 공식 문서 확인: POST /v1/responses, text.format{type:"json_schema",name,schema,strict}, 결과는 output[].content[] 의 output_text
// 형식이 맞지 않으면 1회 재시도 후 null (FR-LLM-06). 비밀 값(키)은 기록·오류 메시지에 남기지 않는다

export interface Price {
  input: number; // USD / 1M 토큰
  cachedInput: number;
  output: number;
}

export interface Usage {
  calls: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
}

export const emptyUsage = (): Usage => ({ calls: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0 });

export interface JsonCall<T> {
  model: string;
  name: string; // 스키마 이름
  instructions: string; // 프롬프트 파일 내용
  input: unknown; // 사실(JSON) — 문자열로 바꿔 user 입력으로 보낸다
  schema: Record<string, unknown>;
  validate: (x: unknown) => x is T;
  maxOutputTokens: number;
  reasoningEffort?: string;
  timeoutMs?: number;
}

export function costOf(u: { inputTokens: number; cachedTokens: number; outputTokens: number }, p: Price): number {
  return ((u.inputTokens - u.cachedTokens) * p.input + u.cachedTokens * p.cachedInput + u.outputTokens * p.output) / 1_000_000;
}

function outputText(body: any): string | null {
  for (const item of body?.output ?? []) {
    if (item?.type !== "message") continue;
    for (const c of item.content ?? []) if (c?.type === "output_text" && typeof c.text === "string") return c.text;
  }
  return null;
}

export class LlmError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "LlmError";
  }
}

// 성공하면 검증된 값, 형식 오류 2번이면 null. HTTP·네트워크 오류는 LlmError(호출 쪽이 정형 문장으로 대신)
export async function callJson<T>(apiKey: string, call: JsonCall<T>, usage: Usage, price: Price, fetchImpl: typeof fetch = fetch): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: call.model,
          instructions: call.instructions,
          input: JSON.stringify(call.input),
          text: { format: { type: "json_schema", name: call.name, schema: call.schema, strict: true } },
          reasoning: { effort: call.reasoningEffort ?? "none" },
          max_output_tokens: call.maxOutputTokens,
          store: false,
        }),
        signal: AbortSignal.timeout(call.timeoutMs ?? 30000),
      });
    } catch (e) {
      throw new LlmError((e as Error).name === "TimeoutError" ? "TIMEOUT" : "NETWORK");
    }
    if (!res.ok) throw new LlmError(`HTTP_${res.status}`);
    const body: any = await res.json();
    const u = { inputTokens: body?.usage?.input_tokens ?? 0, cachedTokens: body?.usage?.input_tokens_details?.cached_tokens ?? 0, outputTokens: body?.usage?.output_tokens ?? 0 };
    usage.calls++;
    usage.inputTokens += u.inputTokens;
    usage.cachedTokens += u.cachedTokens;
    usage.outputTokens += u.outputTokens;
    usage.costUsd += costOf(u, price);
    const text = outputText(body);
    try {
      const v = text === null ? null : JSON.parse(text);
      if (call.validate(v)) return v;
    } catch {
      // 형식 오류 — 한 번 더
    }
  }
  return null;
}
