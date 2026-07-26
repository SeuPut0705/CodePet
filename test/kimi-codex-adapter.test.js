"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createKimiResponsesStream,
  KimiCodexAdapterError,
  responsesRequestToChat,
} = require("../src/kimi-codex-adapter");

const MODEL = {
  slug: "codepet-kimi-k3",
  upstreamModel: "k3",
  reasoningEfforts: ["low", "high", "max"],
  defaultReasoningEffort: "high",
};

function streamingResponse(chunks, status = 200) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), {
    status,
    headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" },
  });
}

async function streamText(stream) {
  let output = "";
  for await (const chunk of stream) output += chunk.toString("utf8");
  return output;
}

function responseEvents(text) {
  return text.split("\n\n").filter(Boolean).map((frame) => {
    const event = frame.match(/^event: (.+)$/m)?.[1] || null;
    const data = frame.match(/^data: (.+)$/m)?.[1] || "";
    return { event, data: data === "[DONE]" ? data : JSON.parse(data) };
  });
}

test("Responses 입력은 Kimi Chat Completions 메시지와 도구로 변환된다", () => {
  const result = responsesRequestToChat({
    model: "codepet-kimi-k3",
    instructions: "공통 지침",
    reasoning: { effort: "high" },
    input: [
      { role: "developer", content: [{ type: "input_text", text: "개발자 지침" }] },
      {
        role: "user",
        content: [
          { type: "input_text", text: "이미지를 봐" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
        ],
      },
      { role: "assistant", content: [{ type: "output_text", text: "도구를 쓸게" }] },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.js"}' },
      { type: "function_call_output", call_id: "call_1", output: "file body" },
    ],
    tools: [{
      type: "function",
      name: "read_file",
      description: "파일 읽기",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      strict: true,
    }],
    temperature: 0.2,
    max_output_tokens: 2048,
    stream: true,
  }, MODEL);

  assert.deepEqual(result, {
    model: "k3",
    messages: [
      { role: "system", content: "공통 지침" },
      { role: "developer", content: "개발자 지침" },
      {
        role: "user",
        content: [
          { type: "text", text: "이미지를 봐" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "high" } },
        ],
      },
      { role: "assistant", content: "도구를 쓸게" },
      {
        role: "assistant",
        tool_calls: [{
          type: "function",
          id: "call_1",
          function: { name: "read_file", arguments: '{"path":"a.js"}' },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "file body" },
    ],
    tools: [{
      type: "function",
      function: {
        name: "read_file",
        description: "파일 읽기",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
          additionalProperties: false,
        },
        strict: true,
      },
    }],
    temperature: 0.2,
    max_completion_tokens: 2048,
    thinking: { type: "enabled", effort: "high" },
    stream: true,
    stream_options: { include_usage: true },
  });
});

test("문자열 input과 function output 객체는 안전한 텍스트로 정규화한다", () => {
  assert.deepEqual(responsesRequestToChat({
    input: "hello",
    stream: true,
  }, MODEL).messages, [{ role: "user", content: "hello" }]);

  const result = responsesRequestToChat({
    input: [
      { type: "function_call_output", call_id: "call_2", output: [{ type: "input_text", text: "ok" }] },
    ],
  }, MODEL);
  assert.deepEqual(result.messages, [
    { role: "tool", tool_call_id: "call_2", content: "ok" },
  ]);
});

test("Codex custom 도구는 Kimi function wrapper와 custom tool 이력으로 왕복한다", () => {
  const result = responsesRequestToChat({
    input: [
      { type: "custom_tool_call", call_id: "call_exec", name: "exec", input: "await tools.update_plan({})" },
      { type: "custom_tool_call_output", call_id: "call_exec", output: "ok" },
    ],
    tools: [{
      type: "custom",
      name: "exec",
      description: "Run JavaScript tool orchestration",
      format: { type: "grammar", syntax: "lark", definition: "start: SOURCE" },
    }],
    stream: true,
  }, MODEL);

  assert.deepEqual(result.tools, [{
    type: "function",
    function: {
      name: "exec",
      description: "Run JavaScript tool orchestration",
      parameters: {
        type: "object",
        properties: { input: { type: "string", description: "Raw custom tool input" } },
        required: ["input"],
        additionalProperties: false,
      },
    },
  }]);
  assert.deepEqual(result.messages, [
    {
      role: "assistant",
      tool_calls: [{
        type: "function",
        id: "call_exec",
        function: { name: "exec", arguments: '{"input":"await tools.update_plan({})"}' },
      }],
    },
    { role: "tool", tool_call_id: "call_exec", content: "ok" },
  ]);
});

test("Codex additional_tools와 namespace는 Kimi 함수 목록으로 평탄화된다", () => {
  const result = responsesRequestToChat({
    input: [
      {
        type: "additional_tools",
        role: "developer",
        tools: [
          { type: "custom", name: "exec", description: "Run code" },
          {
            type: "function",
            name: "wait",
            description: "Wait",
            parameters: { type: "object", properties: {} },
            strict: false,
          },
          {
            type: "namespace",
            name: "collaboration",
            description: "Team tools",
            tools: [{
              type: "function",
              name: "send_message",
              description: "Send",
              parameters: {
                type: "object",
                properties: { target: { type: "string" } },
                required: ["target"],
              },
            }],
          },
        ],
      },
      { type: "function_call", call_id: "call_ns", namespace: "collaboration", name: "send_message", arguments: '{"target":"a"}' },
      { type: "function_call_output", call_id: "call_ns", output: "sent" },
      { role: "user", content: [{ type: "input_text", text: "go" }] },
    ],
  }, MODEL);

  assert.deepEqual(result.tools.map((tool) => tool.function.name), [
    "exec",
    "wait",
    "collaboration__send_message",
  ]);
  assert.deepEqual(result.messages, [
    {
      role: "assistant",
      tool_calls: [{
        type: "function",
        id: "call_ns",
        function: { name: "collaboration__send_message", arguments: '{"target":"a"}' },
      }],
    },
    { role: "tool", tool_call_id: "call_ns", content: "sent" },
    { role: "user", content: "go" },
  ]);
});

test("지원하지 않는 필수 도구와 reasoning 강도는 조용히 변경하지 않고 거부한다", () => {
  assert.throws(() => responsesRequestToChat({
    input: "search",
    tools: [{ type: "web_search_preview" }],
  }, MODEL), (error) => {
    assert.ok(error instanceof KimiCodexAdapterError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "KIMI_UNSUPPORTED_TOOL");
    return true;
  });

  assert.throws(() => responsesRequestToChat({
    input: "think",
    reasoning: { effort: "xhigh" },
  }, MODEL), { code: "KIMI_UNSUPPORTED_REASONING" });
});

test("effort 미지원 Kimi 모델은 Codex 전역 reasoning 값을 업스트림에 강제로 보내지 않는다", () => {
  const result = responsesRequestToChat({
    input: "hi",
    reasoning: { effort: "xhigh" },
  }, {
    slug: "codepet-kimi-k2-7-coding",
    upstreamModel: "kimi-for-coding",
    reasoningEfforts: [],
    defaultReasoningEffort: null,
  });
  assert.deepEqual(result.thinking, { type: "enabled" });
});

test("Kimi 텍스트 스트림은 순서가 완결된 Responses SSE로 변환된다", async () => {
  let sent = null;
  const result = await createKimiResponsesStream({
    requestBody: { model: MODEL.slug, input: "hi", stream: true },
    modelConfig: MODEL,
    accessToken: "secret-token",
    endpoint: "https://kimi.invalid/v1/chat/completions",
    fetchImpl: async (url, options) => {
      sent = { url, options };
      return streamingResponse([
        'data: {"id":"chat_1","choices":[{"delta":{"role":"assistant","reasoning_content":"hidden"},"finish_reason":null}]}\n',
        '\ndata: {"id":"chat_1","choices":[{"delta":{"content":"안녕"},"finish_reason":null}]}\n\n',
        'data: {"id":"chat_1","choices":[{"delta":{"content":"하세요"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}}\n\n',
        'data: [DONE]\n\n',
      ]);
    },
  });

  assert.equal(result.status, 200);
  assert.equal(sent.url, "https://kimi.invalid/v1/chat/completions");
  assert.equal(sent.options.headers.Authorization, "Bearer secret-token");
  assert.equal(JSON.parse(sent.options.body).model, "k3");

  const raw = await streamText(result.body);
  const events = responseEvents(raw);
  assert.deepEqual(events.map((item) => item.event), [
    "response.created",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
    null,
  ]);
  assert.deepEqual(
    events.filter((item) => item.event === "response.output_text.delta").map((item) => item.data.delta),
    ["안녕", "하세요"]
  );
  assert.equal(events.find((item) => item.event === "response.output_text.done").data.text, "안녕하세요");
  assert.deepEqual(events.find((item) => item.event === "response.completed").data.response.usage, {
    input_tokens: 10,
    output_tokens: 4,
    total_tokens: 14,
  });
  assert.doesNotMatch(raw, /hidden|reasoning_content|secret-token/);
  assert.equal(events.at(-1).data, "[DONE]");
});

test("Kimi 도구 스트림은 병렬 call별 인자와 ID를 섞지 않는다", async () => {
  const result = await createKimiResponsesStream({
    requestBody: { model: MODEL.slug, input: "tools", stream: true },
    modelConfig: MODEL,
    accessToken: "token",
    fetchImpl: async () => streamingResponse([
      'data: {"id":"chat_tools","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"read","arguments":"{\\"pa"}},{"index":1,"id":"call_b","type":"function","function":{"name":"list","arguments":"{\\"di"}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chat_tools","choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"r\\":\\".\\"}"}},{"index":0,"function":{"arguments":"th\\":\\"a\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]),
  });

  const events = responseEvents(await streamText(result.body));
  const added = events.filter((item) => item.event === "response.output_item.added");
  assert.deepEqual(added.map((item) => [item.data.item.call_id, item.data.item.name]), [
    ["call_a", "read"],
    ["call_b", "list"],
  ]);
  const done = events.filter((item) => item.event === "response.function_call_arguments.done");
  assert.deepEqual(done.map((item) => [item.data.item_id, item.data.arguments]), [
    [added[0].data.item.id, '{"path":"a"}'],
    [added[1].data.item.id, '{"dir":"."}'],
  ]);
  assert.equal(events.filter((item) => item.event === "response.output_item.done").length, 2);
  assert.equal(events.at(-2).event, "response.completed");
  assert.equal(events.at(-1).data, "[DONE]");
});

test("Kimi function wrapper 응답은 Codex custom_tool_call로 복원된다", async () => {
  const result = await createKimiResponsesStream({
    requestBody: {
      model: MODEL.slug,
      input: "run",
      stream: true,
      tools: [{ type: "custom", name: "exec", description: "Run code" }],
    },
    modelConfig: MODEL,
    accessToken: "token",
    fetchImpl: async () => streamingResponse([
      'data: {"id":"chat_custom","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_exec","type":"function","function":{"name":"exec","arguments":"{\\"input\\":\\"await "}}]},"finish_reason":null}]}\n\n',
      'data: {"id":"chat_custom","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"tools.exec()\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]),
  });

  const events = responseEvents(await streamText(result.body));
  const added = events.find((item) => item.event === "response.output_item.added");
  const done = events.find((item) => item.event === "response.output_item.done");
  assert.equal(added.data.item.type, "custom_tool_call");
  assert.equal(added.data.item.name, "exec");
  assert.equal(done.data.item.type, "custom_tool_call");
  assert.equal(done.data.item.call_id, "call_exec");
  assert.equal(done.data.item.input, "await tools.exec()");
  assert.equal(events.some((item) => item.event === "response.function_call_arguments.done"), false);
});

test("평탄화한 namespace 함수 응답은 Codex namespace function_call로 복원된다", async () => {
  const result = await createKimiResponsesStream({
    requestBody: {
      model: MODEL.slug,
      input: [{
        type: "additional_tools",
        role: "developer",
        tools: [{
          type: "namespace",
          name: "collaboration",
          description: "Team",
          tools: [{
            type: "function",
            name: "send_message",
            description: "Send",
            parameters: { type: "object", properties: {} },
          }],
        }],
      }],
      stream: true,
    },
    modelConfig: MODEL,
    accessToken: "token",
    fetchImpl: async () => streamingResponse([
      'data: {"id":"chat_ns","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_ns","type":"function","function":{"name":"collaboration__send_message","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]),
  });

  const events = responseEvents(await streamText(result.body));
  const done = events.find((item) => item.event === "response.output_item.done");
  assert.equal(done.data.item.type, "function_call");
  assert.equal(done.data.item.namespace, "collaboration");
  assert.equal(done.data.item.name, "send_message");
  assert.equal(done.data.item.arguments, "{}");
});

test("잘못되거나 조기 종료된 Kimi 스트림은 성공 완료 이벤트를 만들지 않는다", async () => {
  for (const chunks of [
    ['data: {not-json}\n\n'],
    ['data: {"id":"chat_1","choices":[{"delta":{"content":"partial"}}]}\n\n'],
  ]) {
    const result = await createKimiResponsesStream({
      requestBody: { model: MODEL.slug, input: "hi", stream: true },
      modelConfig: MODEL,
      accessToken: "token",
      fetchImpl: async () => streamingResponse(chunks),
    });
    const raw = await streamText(result.body);
    const events = responseEvents(raw);
    assert.equal(events.some((item) => item.event === "response.completed"), false);
    assert.equal(events.some((item) => item.event === "error"), true);
    assert.equal(events.at(-1).data, "[DONE]");
  }
});

test("Kimi HTTP 오류는 원문 본문과 토큰을 버리고 상태별 안전한 오류만 반환한다", async () => {
  const result = await createKimiResponsesStream({
    requestBody: { model: MODEL.slug, input: "hi", stream: true },
    modelConfig: MODEL,
    accessToken: "secret-token",
    fetchImpl: async () => streamingResponse(['{"message":"secret upstream body"}'], 429),
  });

  assert.equal(result.status, 429);
  const raw = await streamText(result.body);
  assert.match(raw, /KIMI_HTTP_429|Kimi 계정 한도/);
  assert.doesNotMatch(raw, /secret upstream body|secret-token/);
});

test("Kimi 요청은 호출자가 준 취소 signal과 추가 장치 헤더를 그대로 사용한다", async () => {
  const controller = new AbortController();
  let seen = null;
  const result = await createKimiResponsesStream({
    requestBody: { model: MODEL.slug, input: "hi", stream: true },
    modelConfig: MODEL,
    accessToken: "token",
    signal: controller.signal,
    headers: { "X-Msh-Device-Id": "device-a", "X-Msh-Platform": "kimi_code_cli" },
    fetchImpl: async (_url, options) => {
      seen = options;
      return streamingResponse(['data: [DONE]\n\n']);
    },
  });
  await streamText(result.body);

  assert.equal(seen.signal, controller.signal);
  assert.equal(seen.headers["X-Msh-Device-Id"], "device-a");
  assert.equal(seen.headers["X-Msh-Platform"], "kimi_code_cli");
});
