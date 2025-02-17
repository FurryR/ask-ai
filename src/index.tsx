import { Context, h, Schema } from "koishi";

import OpenAI from "openai";

import { parse } from "node-html-parser";

import {} from "koishi-plugin-markdown-to-image-service";

import {} from "@koishijs/cache";

declare module "@koishijs/cache" {
  interface Tables {
    "ask-ai": {
      links: string[];
    };
  }
}

export const name = "ask-ai";

export interface Config {
  baseURL: string;
  apiKey: string;
  model: string;
  prompt?: string;
  searchURL: string;
  textMode: boolean;
  verboseOutput: boolean;
  cacheEnabled: boolean;
  maxAge?: number;
}

export const Config: Schema<Config> = Schema.object({
  baseURL: Schema.string().description("OpenAI Like 接口的地址。").role("url"), // .required(),
  apiKey: Schema.string().description("API 密钥。").role("secret"), //.required(),
  model: Schema.string().description("使用的模型名称。").default("gpt-4o-mini"),
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
      "是否启用更详细的输出（如显示思考过程）。此功能可能导致风控，不建议在调试以外的场合打开。",
    )
    .default(false),
  cacheEnabled: Schema.boolean()
    .description(
      "是否启用缓存 (需要缓存实现支持)。这将允许用户通过回复搜索结果来获得引用链接。",
    )
    .default(true),
  maxAge: Schema.number().description(
    "缓存最大存活时间。未指定时，使用缓存表的设置。",
  ),
});

export const inject = {
  optional: ["markdownToImage", "cache"],
};

export function apply(ctx: Context, config: Config) {
  const ai = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });
  ctx.middleware(async (session, next) => {
    const { message } = session.event;
    if (config.cacheEnabled && ctx.cache && message && message.quote) {
      const index = parseInt(message.content);
      const quote = await ctx.cache.get("ask-ai", message.quote.id ?? "");
      if (!quote) return next();
      const link = !(index % 1) ? quote.links[index - 1] : null;
      if (!link) {
        if (isNaN(index) || index % 1)
          return (
            <>
              <quote id={message.id} />
              非法输入。
            </>
          );
        if (quote.links.length === 0)
          return (
            <>
              <quote id={message.id} />
              没有针对此搜索结果的引用链接。
            </>
          );
        if (index < 1 || index > quote.links.length)
          return (
            <>
              <quote id={message.id} />
              下标越界。请输入 [1, {quote.links.length}] 范围内的整数。
            </>
          );
        return (
          <>
            <quote id={message.id} />
            孩子你无敌了。发生了未知错误。
          </>
        );
      }
      return (
        <>
          <quote id={message.id} />
          {link}
        </>
      );
    } else return next();
  }, true);
  ctx
    .command("search <prompt:text>")
    .alias("搜索", "不懂就问")
    .action(async ({ session }, prompt) => {
      let startTime = Date.now();
      let lastMessage: string[] = [];
      ctx.logger.info(`用户 ${session.userId} 请求搜索 ${prompt}`);
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
        model: config.model,
        messages,
      });
      if (config.verboseOutput) {
        await session.bot.deleteMessage(session.channelId, lastMessage[0]);
        lastMessage = await session.send(
          `(正在搜索: ${chat.choices[0].message.content})`,
        );
      }
      const html = await fetch(
        `${config.searchURL}${encodeURIComponent(
          chat.choices[0].message.content,
        )}`,
      ).then((res) => res.text());
      const parsed = parse(html);
      const v = parsed.querySelectorAll(".result");
      if (v.length === 0 || v[0].classList.contains("result--no-result")) {
        if (config.verboseOutput)
          await session.bot.deleteMessage(session.channelId, lastMessage[0]);
        await session.send(
          <>
            <quote id={session.messageId} />
            没有找到相关的搜索结果。
          </>,
        );
        return;
      }
      const result = v
        .map((item) => {
          const a = item.querySelector(".result__a");
          const snippet = item.querySelector(".result__snippet");
          let href = a.getAttribute("href");
          if (href.startsWith("//duckduckgo.com")) {
            href = new URLSearchParams(href.slice(href.indexOf("?"))).get(
              "uddg",
            );
          }
          return {
            title: a.textContent,
            description: snippet.textContent,
            url: new URL(href).toString(),
          };
        })
        .filter(
          (v) => !v.url.startsWith("https://duckduckgo.com/y.js?ad_domain="),
        );

      const nextPrompt = result
        .map((item) => {
          return `Title: ${item.title}\nDescription: ${item.description}\nLink: ${item.url}`;
        })
        .join("\n---\n");
      messages[0].content = `${config.prompt ?? "你是一个对话机器人。"}
Now, please summarize all search results with the user input as the theme matching the language of the user input. If any word, phrase, sentence, opinion or specific name of the output is from the search result, please replace the word with a Markdown link to the original content IN PLACE (for example, \`[A](https://example.com/about_a) is [the first letter of the alphabet](https://example.com/source)\`. ALL SEARCH RESULTS MUST APPEAR IN THE OUTPUT. DO NOT list the links. DO NOT emit sentences like "You can obtain more information about ... at ..." or "Here is the information about ...". DO NOT emit any opinion not from the search result. You don't need to introduce yourself or ask for user input.

${nextPrompt}

The user input:
${prompt}`;
      if (config.verboseOutput) {
        await session.bot.deleteMessage(session.channelId, lastMessage[0]);
        lastMessage = await session.send("(正在总结)");
      }
      const chat2 = await ai.chat.completions.create({
        model: config.model,
        messages,
      });
      // await session.bot.deleteMessage(session.channelId, messageId[0]);
      let output = chat2.choices[0].message.content;
      // 替换 output 中的所有 [详细信息](链接) 为 [编号]
      const links: string[] = [];

      output =
        output.replace(/\[(.*?)\]\((.*?)\)/g, (_, text, link) => {
          if (links.includes(link)) {
            return `<u>${text}</u>[\\[${
              links.indexOf(link) + 1
            }\\]](mailto:blank@example.org)`;
          }
          links.push(link);
          return `<u>${text}</u>[\\[${links.length}\\]](mailto:blank@example.org)`;
        }) + "\n\n";

      for (const [idx, link] of links.entries()) {
        output += ` \\[${idx + 1}\\]: ${link}\n`;
      }

      if (config.verboseOutput) {
        await session.bot.deleteMessage(session.channelId, lastMessage[0]);
        if (ctx.markdownToImage && !config.textMode) {
          lastMessage = await session.send("(正在生图)");
        }
      }

      const usageTime = Date.now() - startTime;

      if (config.textMode || !ctx.markdownToImage) {
        const messageId = await session.send(
          <>
            <quote id={session.messageId} />
            {`# 搜索结果
---
> 已展示 \`${chat.choices[0].message.content}\` 的搜索结果。

${output
  .replace(
    /<u>(.*?)<\/u>\[\\\[(.*?)\\\]\]\(mailto:blank@example.org\)/g,
    (_, text, index) => {
      return ` ${text} [${index}] `;
    },
  )
  .replace(/\\\[(.*?)\\\]: (.*?)/g, (_, index, link) => {
    return `[${index}]: ${link}`;
  })}

---

Powered by 玻狸 × 熊谷凌 (思考用时: ${usageTime}ms)`}
          </>,
        );
        if (config.cacheEnabled && ctx.cache) {
          await ctx.cache.set(
            "ask-ai",
            messageId[0] ?? "",
            {
              links,
            },
            config.maxAge,
          );
        }
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
        const messageId = await session.send(
          <>
            <quote id={session.messageId} />
            {h.image(markdownImage, "image/png")}
          </>,
        );
        if (config.cacheEnabled && ctx.cache) {
          await ctx.cache.set(
            "ask-ai",
            messageId[0] ?? "",
            {
              links,
            },
            config.maxAge,
          );
        }
      }
    });
}
