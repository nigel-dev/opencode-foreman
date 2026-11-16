import { expect, test } from "bun:test";
import { resolveConfig } from "../../src/lib/config.js";
import { createJevDecider, parseAnswers } from "../../src/lib/jev.js";

const jev = resolveConfig({ jev: { apiKey: "test-key", url: "http://jev.test/v1/systemone", model: "jev-test" } }).jev;

// Captured from a live jev-1.14.0 response.
const body = {
  model: "jev-1.14.0",
  answers: {
    verified: { type: "noul", noul: 0.01 },
    intent: { type: "choice", choice: "implement", confidence: 1, probabilities: { trivial: 0, implement: 1 } },
    complexity: { type: "score", score: 0.71, confidence: 0.56, probabilities: { "0": 0.29, "1": 0.71 } },
  },
};

test("no decider is created without an API key", () => {
  expect(createJevDecider(resolveConfig({}, {}).jev)).toBeUndefined();
});

test("sends state and questions with bearer auth and parses each answer type", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const decider = createJevDecider(jev, async (url, init) => {
    requests.push({ url, init });
    return Response.json(body);
  });
  const questions = {
    verified: { type: "noul", instructions: "Verified?" },
    intent: { type: "choice", instructions: "Intent?", criteria: { trivial: "t", implement: "i" } },
    complexity: { type: "score", instructions: "Size?", criteria: ["small", "large"] },
  } as const;

  const answers = await decider?.ask({ request: "x" }, questions);

  expect(answers).toEqual({
    verified: { type: "noul", probability: 0.01 },
    intent: { type: "choice", choice: "implement", confidence: 1 },
    complexity: { type: "score", score: 0.71, confidence: 0.56 },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("http://jev.test/v1/systemone");
  expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe("Bearer test-key");
  expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ model: "jev-test", state: { request: "x" }, questions });
});

test("resolves to undefined on HTTP errors, network errors, and malformed bodies", async () => {
  const question = { q: { type: "noul", instructions: "?" } } as const;
  const failing = [
    async () => new Response("nope", { status: 503 }),
    async () => {
      throw new Error("offline");
    },
    async () => Response.json({ answers: {} }),
    async () => Response.json({ answers: { q: { type: "noul", noul: 7 } } }),
    async () => new Response("not json"),
  ];
  for (const fetchImpl of failing) {
    expect(await createJevDecider(jev, fetchImpl)?.ask("state", question)).toBeUndefined();
  }
});

test("a response missing any requested answer is rejected whole", () => {
  expect(parseAnswers(body, ["verified", "missing"])).toBeUndefined();
});

test("each call's outcome is reported, with the reason for a failure", async () => {
  const question = { q: { type: "noul", instructions: "?" } } as const;
  const outcomes: unknown[] = [];
  const observe = (outcome: unknown) => void outcomes.push(outcome);
  await createJevDecider(jev, async () => Response.json({ answers: { q: { type: "noul", noul: 0.5 } } }), observe)?.ask("s", question);
  await createJevDecider(jev, async () => new Response("no", { status: 401 }), observe)?.ask("s", question);
  await createJevDecider(jev, async () => Response.json({ answers: {} }), observe)?.ask("s", question);
  await createJevDecider(jev, async () => { throw new Error("offline"); }, observe)?.ask("s", question);
  await createJevDecider(jev, async () => { throw new DOMException("slow", "TimeoutError"); }, observe)?.ask("s", question);
  expect(outcomes).toEqual([
    { ok: true },
    { ok: false, reason: "HTTP 401" },
    { ok: false, reason: "unusable response" },
    { ok: false, reason: "could not be reached" },
    { ok: false, reason: "timed out" },
  ]);
});
