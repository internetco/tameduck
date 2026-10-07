import {
  providers,
  providerWire,
  providerHeaders,
  ProviderError,
  responseError,
} from "./ai-config.mjs";

function streamErrorStatus(error) {
  const numeric = Number(error?.code);
  if (Number.isInteger(numeric) && numeric >= 400 && numeric <= 599)
    return numeric;
  const statuses = {
    overloaded_error: 503,
    server_error: 500,
    rate_limit_error: 429,
    rate_limit_exceeded: 429,
    insufficient_quota: 429,
    billing_hard_limit_reached: 402,
    authentication_error: 401,
    invalid_api_key: 401,
    permission_error: 403,
    model_not_found: 404,
    invalid_request_error: 400,
    unsupported_parameter: 400,
    unsupported_value: 400,
    invalid_parameter: 400,
    invalid_json_schema: 400,
    invalid_function_parameters: 400,
    context_length_exceeded: 400,
  };
  return statuses[error?.code] || statuses[error?.type] || 500;
}

function toolArguments(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new ProviderError("The model returned invalid tool arguments.");
  }
}
// Read arbitrary SSE chunk boundaries; a closed socket is not a completed response.
export async function* events(response) {
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, "");
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      if (data === "[DONE]") {
        yield { type: "done" };
        continue;
      }
      yield JSON.parse(data);
    }
    if (buffer.length > 10000000)
      throw new ProviderError(
        "The AI response exceeded the message limit.",
        false,
      );
  }
}
// How much a duck may write in one turn. At 4096 an article, a report or a
// document of more than about three pages ran out mid-sentence and the run
// ended, which is not a length anyone would call unusual. Every model in use
// allows at least this much; raise AI_MAX_OUTPUT_TOKENS if yours allows more.
const maxOutputTokens = +process.env.AI_MAX_OUTPUT_TOKENS || 8192;
// How long a call may say nothing at all before we call it stuck. This is time
// between events, not time from the start: a call that is still sending is
// working. A reply may run to maxOutputTokens, which no provider streams in a
// minute or two, and a model that reasons before it answers can be quiet for a
// while and then be perfectly fine. The run's own limit still bounds the whole
// thing.
const quietMs =
  Math.min(Math.max(+process.env.AI_QUIET_SECONDS || 120, 15), 900) * 1000;
export function requestBody(p, model, system, messages, tools) {
  const w = providerWire(p, model);
  const functions = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
  if (w === "anthropic")
    return {
      model,
      system,
      messages,
      max_tokens: maxOutputTokens,
      stream: true,
      tools: functions.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
    };
  if (w === "openai-responses")
    return {
      model,
      instructions: system,
      input: messages,
      tools: functions.map((t) => ({ type: "function", ...t, strict: false })),
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: maxOutputTokens,
      stream: true,
    };
  return {
    model,
    messages: [{ role: "system", content: system }, ...messages],
    tools: functions.map((t) => ({ type: "function", function: t })),
    max_tokens: maxOutputTokens,
    stream: true,
    // Keep verified staging OpenRouter models on the exact tested Flex route.
    // Other OpenRouter models retain the parameter requirement without a route
    // restriction, so QA candidates and future catalog inspection stay usable.
    ...(p === "openrouter"
      ? {
          provider: {
            require_parameters: true,
            ...(model === "openai/gpt-6.1-sol"
              ? { only: ["openai/flex"], allow_fallbacks: false }
              : model === "google/gemini-3.8-flash"
                ? { only: ["google-ai-studio/flex"], allow_fallbacks: false }
                : {}),
          },
          plugins: [{ id: "web", enabled: false }],
        }
      : {}),
  };
}
export async function completion({
  provider: p,
  model,
  key,
  system,
  messages,
  tools,
  signal,
  onDelta = () => {},
  fetcher = fetch,
  quiet = quietMs,
}) {
  const w = providerWire(p, model);
  const base = providers.find((x) => x.id === p)?.url;
  // The watchdog: it fires only when nothing has come back for quietMs, and
  // every event pushes it out again.
  const stalled = new AbortController();
  let watchdog = null;
  const stillTalking = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(
      () =>
        stalled.abort(
          new DOMException("The AI provider went quiet.", "TimeoutError"),
        ),
      quiet,
    );
    watchdog.unref?.();
  };
  const listening = AbortSignal.any(
    signal ? [signal, stalled.signal] : [stalled.signal],
  );
  let response;
  try {
    stillTalking();
    response = await fetcher(
      base +
        (w === "anthropic"
          ? "/messages"
          : w === "openai-responses"
            ? "/responses"
            : "/chat/completions"),
      {
        method: "POST",
        headers: providerHeaders(p, key),
        body: JSON.stringify(requestBody(p, model, system, messages, tools)),
        signal: listening,
        redirect: "error",
      },
    );
  } catch (e) {
    clearTimeout(watchdog);
    if (stalled.signal.aborted) throw stalled.signal.reason;
    if (signal?.aborted) throw e;
    throw new ProviderError("The AI provider connection was interrupted.");
  }
  if (!response.ok) {
    try {
      throw responseError(p, response.status, await response.text());
    } finally {
      clearTimeout(watchdog);
    }
  }
  let text = "",
    calls = [],
    raw,
    finished = false,
    finishReason = "",
    blocks = [],
    openCalls = new Map();
  const delta = (t) => {
    if (t) {
      text += t;
      onDelta(t);
    }
  };
  try {
    for await (const e of events(response)) {
      // Check it here as well as leaving it to the transport. Aborting the
      // request is what stops a real one, but reading the answer must not carry
      // on regardless of a watchdog that has already given up.
      if (stalled.signal.aborted) throw stalled.signal.reason;
      stillTalking();
      if (e.error || e.type === "error") {
        const error = e.error || e;
        throw responseError(
          p,
          streamErrorStatus(error),
          JSON.stringify({ error }),
        );
      }
      if (w === "anthropic") {
        if (e.type === "content_block_start")
          blocks[e.index] = { ...e.content_block };
        if (e.type === "content_block_delta") {
          const b = blocks[e.index],
            d = e.delta;
          if (d.type === "text_delta") {
            b.text = (b.text || "") + d.text;
            delta(d.text);
          }
          if (d.type === "input_json_delta")
            b._json = (b._json || "") + d.partial_json;
          if (d.type === "thinking_delta")
            b.thinking = (b.thinking || "") + d.thinking;
          if (d.type === "signature_delta")
            b.signature = (b.signature || "") + d.signature;
        }
        if (e.type === "message_delta")
          finishReason = e.delta?.stop_reason || "";
        if (e.type === "message_stop") finished = true;
      } else if (w === "openai-responses") {
        if (e.type === "response.output_text.delta") delta(e.delta);
        if (e.type === "response.completed") {
          finished = true;
          raw = e.response;
        }
        if (e.type === "response.failed" && e.response?.error) {
          const error = e.response.error;
          throw responseError(
            p,
            streamErrorStatus(error),
            JSON.stringify({ error }),
          );
        }
        if (["response.failed", "response.incomplete"].includes(e.type))
          throw new ProviderError(
            (providers.find((x) => x.id === p)?.name || p) +
              " could not finish this reply. Review any saved work before retrying.",
            e.type === "response.failed",
          );
      } else {
        const choice = e.choices?.[0],
          d = choice?.delta;
        if (d?.content) delta(d.content);
        for (const t of d?.tool_calls || []) {
          const c = openCalls.get(t.index) || {
            id: "",
            type: "function",
            function: { name: "", arguments: "" },
          };
          if (t.id) c.id = t.id;
          if (t.function?.name) c.function.name += t.function.name;
          if (t.function?.arguments)
            c.function.arguments += t.function.arguments;
          openCalls.set(t.index, c);
        }
        // Preserve opaque reasoning details required by some OpenRouter models, never display them.
        if (d?.reasoning_details) {
          raw ||= {};
          raw.reasoning_details ||= [];
          for (const r of d.reasoning_details) {
            const previous = raw.reasoning_details.find(
              (x) => x.index === r.index && x.type === r.type,
            );
            if (previous) {
              for (const k of ["text", "summary", "data"])
                if (r[k]) previous[k] = (previous[k] || "") + r[k];
            } else raw.reasoning_details.push({ ...r });
          }
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
          finished = true;
        }
      }
    }
  } catch (e) {
    if (stalled.signal.aborted) throw stalled.signal.reason;
    if (signal?.aborted || e instanceof ProviderError) throw e;
    throw new ProviderError("The AI response stream was interrupted.");
  } finally {
    clearTimeout(watchdog);
  }
  if (!finished)
    throw new ProviderError("The AI response ended before completion.");
  if (["length", "max_tokens"].includes(finishReason))
    throw new ProviderError(
      "This reply reached the model output limit. Review its saved work before retrying.",
      false,
    );
  if (finishReason === "content_filter")
    throw new ProviderError(
      "The AI provider blocked this reply with its content filter.",
      false,
    );
  if (w === "anthropic") {
    blocks = blocks.filter(Boolean).map((b) => {
      const { _json, ...rest } = b;
      return _json ? { ...rest, input: toolArguments(_json) } : rest;
    });
    calls = blocks
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, arguments: b.input }));
    raw = { role: "assistant", content: blocks };
  } else if (w === "openai-responses") {
    calls = (raw?.output || [])
      .filter((b) => b.type === "function_call")
      .map((b) => ({
        id: b.call_id,
        name: b.name,
        arguments: toolArguments(b.arguments),
      }));
    if (!text)
      text = (raw?.output || [])
        .filter((b) => b.type === "message")
        .flatMap((b) => b.content || [])
        .filter((b) => ["output_text", "refusal"].includes(b.type))
        .map((b) => b.text || b.refusal || "")
        .filter(Boolean)
        .join("\n");
    raw = raw?.output || [];
  } else {
    const tool_calls = [...openCalls.values()];
    calls = tool_calls.map((b) => ({
      id: b.id,
      name: b.function.name,
      arguments: toolArguments(b.function.arguments),
    }));
    raw = {
      ...raw,
      role: "assistant",
      content: text || null,
      ...(tool_calls.length ? { tool_calls } : {}),
    };
  }
  return { text, calls, raw };
}
export function toolResults(p, results, model = "") {
  const w = providerWire(p, model);
  const parts = (r) =>
    r._contentItems || [{ type: "inputText", text: JSON.stringify(r) }];
  if (w === "anthropic")
    return [
      {
        role: "user",
        content: results.map(({ call, result }) => ({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: result._success === false,
          content: parts(result).map((b) => {
            if (b.type === "inputText") return { type: "text", text: b.text };
            const match = /^data:([^;]+);base64,(.*)$/s.exec(b.imageUrl || "");
            return match
              ? {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: match[1],
                    data: match[2],
                  },
                }
              : {
                  type: "text",
                  text: "Image unavailable; inspect fresh state.",
                };
          }),
        })),
      },
    ];
  const messages = results.flatMap(({ call, result }) => {
    const content = parts(result),
      text =
        content
          .filter((b) => b.type === "inputText")
          .map((b) => b.text)
          .join("\n") || "Screenshot captured. The image follows.";
    const images = content
      .filter((b) => b.type === "inputImage")
      .map((b) =>
        w === "openai-responses"
          ? { type: "input_image", image_url: b.imageUrl }
          : { type: "image_url", image_url: { url: b.imageUrl } },
      );
    return [
      w === "openai-responses"
        ? { type: "function_call_output", call_id: call.id, output: text }
        : { role: "tool", tool_call_id: call.id, content: text },
      ...(images.length
        ? [
            {
              role: "user",
              content: [
                w === "openai-responses"
                  ? {
                      type: "input_text",
                      text: "Observation returned by " + call.name,
                    }
                  : {
                      type: "text",
                      text: "Observation returned by " + call.name,
                    },
                ...images,
              ],
            },
          ]
        : []),
    ];
  });
  // OpenAI-compatible providers require every tool result before the next user message.
  return [
    ...messages.filter((m) => m.role !== "user"),
    ...messages.filter((m) => m.role === "user"),
  ];
}
