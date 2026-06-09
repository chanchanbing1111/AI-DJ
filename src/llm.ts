import type { Env } from "./types";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function generateJson(env: Env, messages: ChatMessage[]): Promise<string | null> {
  if (env.LLM_API_KEY) {
    try {
      return await openAiCompatible(env, messages);
    } catch (error) {
      if (!env.AI) throw error;
      return await workersAi(env, messages);
    }
  }

  if (env.AI) {
    return await workersAi(env, messages);
  }

  return null;
}

export async function probeLlm(env: Env): Promise<{ configured: boolean; provider: string; model: string; ok: boolean; error?: string; sample?: string }> {
  const provider = env.LLM_API_KEY ? "openai-compatible" : env.AI ? "workers-ai" : "none";
  const fallbackProvider = env.LLM_API_KEY && env.AI ? "workers-ai" : undefined;
  const model = env.LLM_API_KEY ? env.LLM_MODEL ?? "gpt-4o-mini" : env.AI_MODEL ?? "";

  if (provider === "none") {
    return { configured: false, provider, model, ok: false, error: "No LLM provider configured." };
  }

  try {
    const sample = await generateJson(env, [
      { role: "system", content: "Return JSON only." },
      { role: "user", content: "Return {\"ok\":true,\"say\":\"pong\"}." }
    ]);
    return { configured: true, provider, model, ok: Boolean(sample), sample: sample?.slice(0, 120), ...(fallbackProvider ? { fallbackProvider } : {}) } as {
      configured: boolean;
      provider: string;
      model: string;
      ok: boolean;
      error?: string;
      sample?: string;
    };
  } catch (error) {
    return {
      configured: true,
      provider,
      model,
      ok: false,
      error: error instanceof Error ? error.message.slice(0, 500) : "Unknown LLM error."
    };
  }
}

async function workersAi(env: Env, messages: ChatMessage[]): Promise<string> {
  if (!env.AI) throw new Error("Workers AI binding is not available.");
  const aiResult = await env.AI.run(env.AI_MODEL, { messages });
  const response = String((aiResult as { response?: string }).response ?? "").trim();
  if (!response) throw new Error("Workers AI returned empty response.");
  return response;
}

async function openAiCompatible(env: Env, messages: ChatMessage[]): Promise<string> {
  const baseUrl = (env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = env.LLM_MODEL ?? "gpt-4o-mini";

  const content = await requestChatCompletion(baseUrl, model, env.LLM_API_KEY ?? "", messages, true)
    .catch(async (error) => {
      if (!String(error instanceof Error ? error.message : error).includes("empty message")) throw error;
      return requestChatCompletion(baseUrl, model, env.LLM_API_KEY ?? "", messages, false);
    });
  if (!content.trim()) {
    return requestChatCompletion(baseUrl, model, env.LLM_API_KEY ?? "", messages, false);
  }
  return content;
}

async function requestChatCompletion(
  baseUrl: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  jsonMode: boolean
): Promise<string> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.8,
      max_tokens: 1000,
      ...(jsonMode ? { response_format: { type: "json_object" } } : {})
    })
  });

  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw new Error(`LLM returned empty message content${jsonMode ? " in json mode" : ""}.`);
  return content;
}
