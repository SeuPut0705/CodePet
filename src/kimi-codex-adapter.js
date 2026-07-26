"use strict";

const crypto = require("node:crypto");
const { Readable } = require("node:stream");

const DEFAULT_KIMI_CHAT_URL = "https://api.kimi.com/coding/v1/chat/completions";

class KimiCodexAdapterError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "KimiCodexAdapterError";
    this.code = code;
    this.status = status;
  }
}

function textFromOutput(output) {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return JSON.stringify(output ?? null);
  return output
    .filter((part) => part?.type === "input_text" || part?.type === "output_text")
    .map((part) => String(part.text ?? ""))
    .join("");
}

function chatContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (part?.type === "input_text" || part?.type === "output_text") {
      parts.push({ type: "text", text: String(part.text ?? "") });
      continue;
    }
    if (part?.type === "input_image" && typeof part.image_url === "string") {
      const imageUrl = { url: part.image_url };
      if (["auto", "low", "high"].includes(part.detail)) imageUrl.detail = part.detail;
      parts.push({ type: "image_url", image_url: imageUrl });
      continue;
    }
    throw new KimiCodexAdapterError(
      "KIMI_UNSUPPORTED_INPUT",
      `Kimi에서 지원하지 않는 입력 형식입니다: ${part?.type || "unknown"}`,
      400
    );
  }
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

function convertInput(input, instructions) {
  const messages = [];
  if (typeof instructions === "string" && instructions) {
    messages.push({ role: "system", content: instructions });
  }
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "additional_tools") continue;
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        tool_calls: [{
          type: "function",
          id: String(item.call_id || item.id || ""),
          function: {
            name: item.namespace
              ? `${String(item.namespace)}__${String(item.name || "")}`
              : String(item.name || ""),
            arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
          },
        }],
      });
      continue;
    }
    if (item.type === "custom_tool_call") {
      messages.push({
        role: "assistant",
        tool_calls: [{
          type: "function",
          id: String(item.call_id || item.id || ""),
          function: {
            name: item.namespace
              ? `${String(item.namespace)}__${String(item.name || "")}`
              : String(item.name || ""),
            arguments: JSON.stringify({ input: String(item.input ?? "") }),
          },
        }],
      });
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: String(item.call_id || ""),
        content: textFromOutput(item.output),
      });
      continue;
    }
    if (["system", "developer", "user", "assistant"].includes(item.role)) {
      messages.push({ role: item.role, content: chatContent(item.content) });
      continue;
    }
    throw new KimiCodexAdapterError(
      "KIMI_UNSUPPORTED_INPUT",
      `Kimi에서 지원하지 않는 입력 항목입니다: ${item.type || "unknown"}`,
      400
    );
  }
  return messages;
}

function responseToolRoutes(body) {
  const routes = [];
  const declared = [
    ...(Array.isArray(body?.tools) ? body.tools : []),
    ...(Array.isArray(body?.input)
      ? body.input
        .filter((item) => item?.type === "additional_tools" && Array.isArray(item.tools))
        .flatMap((item) => item.tools)
      : []),
  ];

  const add = (tool, namespace = null) => {
    if (!tool || typeof tool !== "object") return;
    if (typeof tool.name !== "string") {
      routes.push({ upstreamName: "", namespace, name: "", kind: tool.type, tool });
      return;
    }
    if (tool.type === "namespace" && Array.isArray(tool.tools)) {
      for (const child of tool.tools) add(child, namespace ? `${namespace}__${tool.name}` : tool.name);
      return;
    }
    const upstreamName = namespace ? `${namespace}__${tool.name}` : tool.name;
    if (routes.some((route) => route.upstreamName === upstreamName)) return;
    routes.push({
      upstreamName,
      namespace,
      name: tool.name,
      kind: tool.type,
      tool,
    });
  };
  for (const tool of declared) add(tool);
  return routes;
}

function convertTools(routes) {
  if (!Array.isArray(routes) || routes.length === 0) return undefined;
  return routes.map((route) => {
    const { tool } = route;
    if (route.kind === "custom") {
      return {
        type: "function",
        function: {
          name: route.upstreamName,
          description: typeof tool.description === "string" ? tool.description : "",
          parameters: {
            type: "object",
            properties: {
              input: { type: "string", description: "Raw custom tool input" },
            },
            required: ["input"],
            additionalProperties: false,
          },
        },
      };
    }
    if (route.kind !== "function") {
      throw new KimiCodexAdapterError(
        "KIMI_UNSUPPORTED_TOOL",
        `Kimi에서 지원하지 않는 도구 형식입니다: ${tool?.type || "unknown"}`,
        400
      );
    }
    const fn = {
      name: route.upstreamName,
      description: typeof tool.description === "string" ? tool.description : "",
      parameters: tool.parameters && typeof tool.parameters === "object"
        ? tool.parameters
        : { type: "object", properties: {} },
    };
    if (typeof tool.strict === "boolean") fn.strict = tool.strict;
    return { type: "function", function: fn };
  });
}

function responsesRequestToChat(body, modelConfig) {
  if (!body || typeof body !== "object" || !modelConfig?.upstreamModel) {
    throw new KimiCodexAdapterError("KIMI_INVALID_REQUEST", "Kimi 요청 형식이 올바르지 않습니다.", 400);
  }
  const supportedEfforts = Array.isArray(modelConfig.reasoningEfforts)
    ? modelConfig.reasoningEfforts
    : [];
  const effort = supportedEfforts.length > 0
    ? body.reasoning?.effort || modelConfig.defaultReasoningEffort || supportedEfforts[0]
    : null;
  if (effort && !supportedEfforts.includes(effort)) {
    throw new KimiCodexAdapterError(
      "KIMI_UNSUPPORTED_REASONING",
      `Kimi 모델에서 지원하지 않는 추론 강도입니다: ${effort}`,
      400
    );
  }

  const request = {
    model: modelConfig.upstreamModel,
    messages: convertInput(body.input, body.instructions),
  };
  const tools = convertTools(responseToolRoutes(body));
  if (tools) request.tools = tools;
  for (const key of ["temperature", "top_p", "presence_penalty", "frequency_penalty"]) {
    if (typeof body[key] === "number" && Number.isFinite(body[key])) request[key] = body[key];
  }
  if (Number.isInteger(body.max_output_tokens) && body.max_output_tokens > 0) {
    request.max_completion_tokens = body.max_output_tokens;
  }
  // keep=all은 다음 요청에 raw reasoning_content를 되돌려 보내는 계약입니다.
  // CodePet은 원문 추론을 노출하거나 영속화하지 않으므로 보존 모드를 요청하지 않습니다.
  request.thinking = effort ? { type: "enabled", effort } : { type: "enabled" };
  request.stream = body.stream !== false;
  if (request.stream) request.stream_options = { include_usage: true };
  return request;
}

function publicResponseState(requestBody, modelConfig, id, status, output, usage = null) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    error: null,
    incomplete_details: null,
    instructions: requestBody.instructions || null,
    model: modelConfig.slug,
    output,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: Array.isArray(requestBody.tools) ? requestBody.tools : [],
    usage,
  };
}

function kimiUsage(value) {
  if (!value || typeof value !== "object") return null;
  const inputTokens = Number(value.prompt_tokens);
  const outputTokens = Number(value.completion_tokens);
  const totalTokens = Number(value.total_tokens);
  if (![inputTokens, outputTokens, totalTokens].every(Number.isFinite)) return null;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

async function* kimiDataFrames(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) yield line.slice(5).trimStart();
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    for (const line of buffer.split("\n")) {
      if (line.startsWith("data:")) yield line.slice(5).trimStart();
    }
  }
}

function responseEvent(type, sequenceNumber, fields = {}) {
  const data = { type, sequence_number: sequenceNumber, ...fields };
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function errorEvent(error, sequenceNumber) {
  const data = {
    type: "error",
    sequence_number: sequenceNumber,
    code: error instanceof KimiCodexAdapterError ? error.code : "KIMI_STREAM_ERROR",
    message: error instanceof KimiCodexAdapterError
      ? error.message
      : "Kimi 응답 스트림을 처리하지 못했습니다.",
    param: null,
  };
  return `event: error\ndata: ${JSON.stringify(data)}\n\n`;
}

async function* responsesStream(upstreamBody, requestBody, modelConfig) {
  const responseId = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  let sequence = 0;
  const output = [];
  let textItem = null;
  let text = "";
  let textFinished = false;
  let usage = null;
  const toolItems = new Map();
  const toolRoutes = new Map(
    responseToolRoutes(requestBody).map((route) => [route.upstreamName, route])
  );
  let sawDone = false;

  const startText = () => {
    if (textItem) return [];
    textItem = {
      id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    output.push(textItem);
    const part = { type: "output_text", text: "", annotations: [], logprobs: [] };
    textItem.content.push(part);
    return [
      responseEvent("response.output_item.added", sequence++, {
        output_index: output.length - 1,
        item: structuredClone(textItem),
      }),
      responseEvent("response.content_part.added", sequence++, {
        item_id: textItem.id,
        output_index: output.length - 1,
        content_index: 0,
        part: structuredClone(part),
      }),
    ];
  };

  try {
    yield responseEvent("response.created", sequence++, {
      response: publicResponseState(requestBody, modelConfig, responseId, "in_progress", []),
    });

    for await (const data of kimiDataFrames(upstreamBody)) {
      if (data === "[DONE]") {
        sawDone = true;
        break;
      }
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        throw new KimiCodexAdapterError("KIMI_STREAM_JSON", "Kimi 스트림 JSON이 올바르지 않습니다.");
      }
      usage = kimiUsage(chunk.usage) || kimiUsage(chunk.choices?.[0]?.usage) || usage;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta || {};

      if (typeof delta.content === "string" && delta.content) {
        for (const event of startText()) yield event;
        const outputIndex = output.indexOf(textItem);
        text += delta.content;
        textItem.content[0].text = text;
        yield responseEvent("response.output_text.delta", sequence++, {
          item_id: textItem.id,
          output_index: outputIndex,
          content_index: 0,
          delta: delta.content,
          logprobs: [],
        });
      }

      for (const call of delta.tool_calls || []) {
        const key = Number.isInteger(call.index) ? call.index : toolItems.size;
        let entry = toolItems.get(key);
        if (!entry) {
          const callId = String(call.id || `call_${crypto.randomUUID().replaceAll("-", "")}`);
          const upstreamName = String(call.function?.name || "");
          const route = toolRoutes.get(upstreamName) || null;
          const name = route?.name || upstreamName;
          const custom = route?.kind === "custom";
          const item = custom
            ? {
              id: `ctc_${crypto.randomUUID().replaceAll("-", "")}`,
              type: "custom_tool_call",
              call_id: callId,
              name,
              input: "",
              ...(route?.namespace ? { namespace: route.namespace } : {}),
            }
            : {
              id: `fc_${crypto.randomUUID().replaceAll("-", "")}`,
              type: "function_call",
              status: "in_progress",
              arguments: "",
              call_id: callId,
              name,
              ...(route?.namespace ? { namespace: route.namespace } : {}),
            };
          entry = { item, outputIndex: output.length, custom, rawArguments: "", route };
          toolItems.set(key, entry);
          output.push(item);
          yield responseEvent("response.output_item.added", sequence++, {
            output_index: entry.outputIndex,
            item: structuredClone(item),
          });
        }
        if (call.id && entry.item.call_id.startsWith("call_") && !entry.rawArguments) {
          entry.item.call_id = String(call.id);
        }
        if (call.function?.name && !entry.route) entry.item.name = String(call.function.name);
        if (typeof call.function?.arguments === "string" && call.function.arguments) {
          entry.rawArguments += call.function.arguments;
          if (!entry.custom) {
            entry.item.arguments += call.function.arguments;
            yield responseEvent("response.function_call_arguments.delta", sequence++, {
              item_id: entry.item.id,
              output_index: entry.outputIndex,
              delta: call.function.arguments,
            });
          }
        }
      }
    }

    if (!sawDone) {
      throw new KimiCodexAdapterError("KIMI_STREAM_EOF", "Kimi 스트림이 완료 전에 종료됐습니다.");
    }

    if (textItem && !textFinished) {
      const outputIndex = output.indexOf(textItem);
      textFinished = true;
      yield responseEvent("response.output_text.done", sequence++, {
        item_id: textItem.id,
        output_index: outputIndex,
        content_index: 0,
        text,
        logprobs: [],
      });
      yield responseEvent("response.content_part.done", sequence++, {
        item_id: textItem.id,
        output_index: outputIndex,
        content_index: 0,
        part: structuredClone(textItem.content[0]),
      });
      textItem.status = "completed";
      yield responseEvent("response.output_item.done", sequence++, {
        output_index: outputIndex,
        item: structuredClone(textItem),
      });
    }

    for (const entry of [...toolItems.values()].sort((left, right) => left.outputIndex - right.outputIndex)) {
      if (entry.custom) {
        let parsed;
        try {
          parsed = JSON.parse(entry.rawArguments);
        } catch {
          parsed = null;
        }
        entry.item.input = typeof parsed?.input === "string" ? parsed.input : entry.rawArguments;
        if (entry.item.input) {
          yield responseEvent("response.custom_tool_call_input.delta", sequence++, {
            item_id: entry.item.id,
            call_id: entry.item.call_id,
            output_index: entry.outputIndex,
            delta: entry.item.input,
          });
        }
      } else {
        yield responseEvent("response.function_call_arguments.done", sequence++, {
          item_id: entry.item.id,
          output_index: entry.outputIndex,
          arguments: entry.item.arguments,
        });
        entry.item.status = "completed";
      }
      yield responseEvent("response.output_item.done", sequence++, {
        output_index: entry.outputIndex,
        item: structuredClone(entry.item),
      });
    }

    yield responseEvent("response.completed", sequence++, {
      response: publicResponseState(requestBody, modelConfig, responseId, "completed", output, usage),
    });
  } catch (error) {
    yield errorEvent(error, sequence++);
  }
  yield "data: [DONE]\n\n";
}

function sanitizedUpstreamError(status) {
  const messages = {
    401: "Kimi 로그인이 만료됐습니다.",
    403: "Kimi 로그인이 거부됐습니다.",
    429: "Kimi 계정 한도에 도달했습니다.",
  };
  return JSON.stringify({
    error: {
      code: `KIMI_HTTP_${status}`,
      message: messages[status] || "Kimi 모델 서버가 요청을 처리하지 못했습니다.",
    },
  });
}

async function createKimiResponsesStream({
  requestBody,
  modelConfig,
  accessToken,
  fetchImpl = fetch,
  signal,
  endpoint = DEFAULT_KIMI_CHAT_URL,
  headers = {},
} = {}) {
  const chatBody = responsesRequestToChat(requestBody, modelConfig);
  const upstream = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      ...headers,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(chatBody),
    signal,
  });
  const status = Number(upstream?.status) || 502;
  if (!upstream?.ok || !upstream.body) {
    return {
      status,
      headers: { "content-type": "application/json" },
      body: Readable.from([sanitizedUpstreamError(status)]),
    };
  }
  return {
    status,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
    body: Readable.from(responsesStream(upstream.body, requestBody, modelConfig)),
  };
}

module.exports = {
  createKimiResponsesStream,
  KimiCodexAdapterError,
  responsesRequestToChat,
};
