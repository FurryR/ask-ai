import { Context, h, Schema } from "koishi";

import OpenAI from "openai";

import { parse } from "node-html-parser";

import {} from "koishi-plugin-markdown-to-image-service";

export const name = "ask-ai";

export interface Config {
  baseURL: string;
  apiKey: string;
  prompt?: string;
  searchURL: string;
  textMode: boolean;
  verboseOutput: boolean;
}

export const Config: Schema<Config> = Schema.object({
  baseURL: Schema.string().description("OpenAI Like 接口的地址。").role("url"), // .required(),
  apiKey: Schema.string().description("API 密钥。").role("secret"), //.required(),
  prompt: Schema.string()
    .role("textarea", {
      rows: [10, 10],
    })
    .description("用于指定 AI 回答风格的咒语。")
    .default("你是一个问答机器人。"),
  searchURL: Schema.string()
    .role("url")
    .description("Duckduckgo 搜索地址。")
    .default("https://html.duckduckgo.com/html?q="), //.required(),
  textMode: Schema.boolean()
    .description("是否启用文本模式。当 markdowntoimage 未加载时此选项无效。")
    .default(false),
  verboseOutput: Schema.boolean()
    .description(
      "是否启用更详细的输出（如显示思考过程）。此功能可能导致风控，不建议在调试以外的场合打开。"
    )
    .default(false),
});

export const inject = {
  optional: ["markdownToImage"],
};

export function apply(ctx: Context, config: Config) {
  const ai = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });
  // write your plugin here
  ctx
    .command("search <prompt:text>")
    .alias("搜索", "不懂就问")
    .action(async ({ session }, prompt) => {
      let startTime = Date.now();
      let lastMessage: string[] = [];
      if (config.verboseOutput) {
        lastMessage = await session.send("(正在思考)");
      }
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        {
          role: "user",
          content: `You are an AI chatbot. Now please generate search engine keywords based on the following user input matching the language of user input. You don't need to output anything other than the keywords. Here is the user input:\n${prompt}`,
        },
      ] as const;
      const chat = await ai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
      });
      if (config.verboseOutput) {
        await session.bot.deleteMessage(session.channelId, lastMessage[0]);
        lastMessage = await session.send(
          `(正在搜索: ${chat.choices[0].message.content})`
        );
      }
      const html = await fetch(
        `${config.searchURL}${encodeURIComponent(
          chat.choices[0].message.content
        )}`
      ).then((res) => res.text());
      const parsed = parse(html);
      const v = parsed.querySelectorAll(".result");
      if (v.length === 0 || v[0].classList.contains("result--no-result")) {
        if (config.verboseOutput)
          await session.bot.deleteMessage(session.channelId, lastMessage[0]);
        await session.send(<>没有找到相关的搜索结果。</>);
        return;
      }
      const result = v
        .map((item) => {
          const a = item.querySelector(".result__a");
          const snippet = item.querySelector(".result__snippet");
          let href = a.getAttribute("href");
          if (href.startsWith("//duckduckgo.com")) {
            href = new URLSearchParams(href.slice(href.indexOf("?"))).get(
              "uddg"
            );
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
          return `Title: ${item.title}\nDescription: ${item.description}\nLink: ${item.url}`;
        })
        .join("\n---\n");
      messages[0].content = `${config.prompt ?? "你是一个对话机器人。"}
Now, please summarize all search results with the user input as the theme matching the language of the user input. If any word, sentence, opinion or specific name of the output is from the search result, please replace the word with a Markdown link to the original content IN PLACE (for example, \`A is [the first letter of the alphabet](https://example.com/source)\`. DO NOT list the links. DO NOT emit sentences like "You can obtain more information about ... at ..." or "Here is the information about ..." Avoid any opinion not from the search result. You don't need to introduce yourself or ask for user input.

${nextPrompt}

The user input:
${prompt}`;
      if (config.verboseOutput) {
        await session.bot.deleteMessage(session.channelId, lastMessage[0]);
        lastMessage = await session.send("(正在总结)");
      }
      const chat2 = await ai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
      });
      // await session.bot.deleteMessage(session.channelId, messageId[0]);
      let output = chat2.choices[0].message.content;
      // 替换 output 中的所有 [详细信息](链接) 为 [编号]
      const links: string[] = [];

      output =
        output.replace(/\[(.*?)\]\((.*?)\)/g, (_, text, link) => {
          links.push(link);
          return `<u>${text}</u>[\\[${links.length}\\]](mailto:blank@example.org)`;
        }) + "\n\n";

      for (const [idx, link] of links.entries()) {
        output += `\\[${idx + 1}\\]: ${link}\n`;
      }

      if (config.verboseOutput) {
        await session.bot.deleteMessage(session.channelId, lastMessage[0]);
        if (ctx.markdownToImage && !config.textMode) {
          lastMessage = await session.send("(正在生图)");
        }
      }

      const usageTime = Date.now() - startTime;

      if (config.textMode || !ctx.markdownToImage) {
        await session.send(
          <>
            <quote id={session.messageId} />
            {`# 搜索结果
---
> 已展示 \`${chat.choices[0].message.content}\` 的搜索结果。

${output.replace(
  /<u>(.*?)<\/u>\[\[(.*?)\]\]\(mailto:blank@example.org\)/g,
  (_, text, index) => {
    return `[${text}](${links[parseInt(index) - 1]})`;
  }
)}

---

Powered by 玻狸 × 熊谷凌 (思考用时: ${usageTime}ms)`}
          </>
        );
      } else {
        const markdownImage = await ctx.markdownToImage
          .convertToImage(`# 搜索结果
---
> 已展示 \`${chat.choices[0].message.content}\` 的搜索结果。

${output}

---

<div style="display: flex; justify-content: space-between; color: gray; margin-top: -20px;">
    <span>Powered by 玻狸 × 熊谷凌</span>
    <span>思考用时: ${usageTime}ms</span>
</div>
`);
        if (config.verboseOutput) {
          await session.bot.deleteMessage(session.channelId, lastMessage[0]);
        }
        await session.send(
          <>
            <quote id={session.messageId} />
            {h.image(markdownImage, "image/png")}
          </>
        );
      }
    });
}
