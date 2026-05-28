import type { Env } from "./types";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function generateJson(env: Env, messages: ChatMessage[]): Promise<string | null> {
  if (env.LLM_API_KEY) {
    return openAiCompatible(env, messages);
  }

  if (env.AI) {
    const aiResult = await env.AI.run(env.AI_MODEL, { messages });
    return String((aiResult as { response?: string }).response ?? "");
  }

  return null;
}

async function openAiCompatible(env: Env, messages: ChatMessage[]): Promise<string> {
  const baseUrl = (env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = env.LLM_MODEL ?? "gpt-4o-mini";

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.LLM_API_KEY}`
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.8,
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}
