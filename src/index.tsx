import { Context, h, Schema } from "koishi";

import OpenAI from "openai";

import { parse } from "node-html-parser";

import "koishi-plugin-markdown-to-image-service";

export const name = "ask-ai";

export interface Config {
  baseURL: string;
  apiKey: string;
  prompt?: string;
  searchURL: string;
}

export const Config: Schema<Config> = Schema.object({
  baseURL: Schema.string()
    .description("OpenAI Like 接口的地址。")
    .role("url")
    .required(),
  apiKey: Schema.string().description("API 密钥。").role("secret").required(),
  prompt: Schema.string()
    .role("textarea", {
      rows: [10, 10],
    })
    .description("用于指定 AI 回答风格的咒语。")
    .default("你是一个问答机器人。"),
  searchURL: Schema.string()
    .role("url")
    .description("Duckduckgo 搜索地址。")
    .default("https://html.duckduckgo.com/html?q=")
    .required(),
});

export const inject = {
  required: ["markdownToImage"],
};

export function apply(ctx: Context, config: Config) {
  const ai = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });
  // write your plugin here
  ctx.command("search <prompt:text>").action(async ({ session }, prompt) => {
    let startTime = Date.now();
    // await session.send("(正在思考)");
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: "user",
        content: `你是一个问答机器人。现在请根据以下的用户输入生成搜索引擎关键词。你不需要输出除了关键词以外的任何内容，以下是用户输入：\n${prompt}`,
      },
    ] as const;
    const chat = await ai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
    });
    // await session.send(
    //   `(正在搜索: ${chat.choices[0].message.content})`
    // );
    const html = await fetch(
      `${config.searchURL}${encodeURIComponent(
        chat.choices[0].message.content
      )}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
        },
      }
    ).then((res) => res.text());
    const parsed = parse(html);
    const v = parsed.querySelectorAll(".result");
    if (v.length === 0 || v[0].classList.contains("result--no-result")) {
      // await session.bot.deleteMessage(session.channelId, messageId[0]);
      await session.send(<>没有找到相关的搜索结果。</>);
      return;
    }
    const result = v
      .map((item) => {
        const a = item.querySelector(".result__a");
        const snippet = item.querySelector(".result__snippet");
        let href = a.getAttribute("href");
        if (href.startsWith("//duckduckgo.com")) {
          href = new URLSearchParams(href.slice(href.indexOf("?"))).get("uddg");
        }
        return {
          title: a.textContent,
          description: snippet.textContent,
          url: new URL(href).toString(),
        };
      })
      .filter(
        (v) => !v.url.startsWith("https://duckduckgo.com/y.js?ad_domain=")
      );

    const nextPrompt = result
      .map((item) => {
        return `标题: ${item.title}\n描述: ${item.description}\n链接: ${item.url}`;
      })
      .join("\n---\n");
    messages[0].content = `${config.prompt ?? "你是一个对话机器人。"}
现在，请你以用户输入为主题，总结所有搜索结果。如果回答中提及了搜索结果的任何一部分，请在这一部分后添加 \`[详细信息](链接)\`。不需要询问用户或者介绍自己。
以下是搜索结果：
${nextPrompt}

用户输入：
${prompt}`;

    // await session.bot.deleteMessage(session.channelId, messageId[0]);
    // messageId = await session.send("(正在总结)");
    const chat2 = await ai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
    });
    // await session.bot.deleteMessage(session.channelId, messageId[0]);
    let output = chat2.choices[0].message.content;
    // 替换 output 中的所有 [详细信息](链接) 为 [编号]
    const links: string[] = [];

    output =
      output.replace(/\[详细信息\]\(([^)]+)\)/g, (_, link) => {
        links.push(link);
        return `[\\[${links.length}\\]](mailto:blank@example.org)`;
      }) + "\n\n";
    for (const [idx, link] of links.entries()) {
      output += `\\[${idx + 1}\\]: ${link}\n`;
    }

    const markdownImage = await ctx.markdownToImage.convertToImage(`# 搜索结果
---
> 已展示 \`${chat.choices[0].message.content}\` 的搜索结果。

${output}

---

<div style="display: flex; justify-content: space-between; color: gray; margin-top: -20px;">
    <span>Powered by 玻狸 × 熊谷凌</span>
    <span>思考用时: ${Date.now() - startTime}ms</span>
</div>
`);
    await session.send(
      <quote id={session.messageId}>
        {h.image(markdownImage, "image/png")}
      </quote>
    );
  });
}
