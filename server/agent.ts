import { join } from "node:path";
import { z } from "zod";
import type { ChatMessage } from "../shared/chat.ts";
import { getModelClient, model } from "./model.ts";
import { createJsonTaskStore } from "./task-store.ts";

export type { ChatMessage } from "../shared/chat.ts";

// 与 server/index.ts 指向同一个 data/tasks.json 文件。
// 存储层是同步读写且 Node 单线程运行，两个实例不会产生并发冲突；
// 每轮对话前实时 list()，保证模型看到的清单始终是最新的。
const tasks = createJsonTaskStore(join("data", "tasks.json"));

// 模型每轮必须输出的结构化决策
const agentActionSchema = z.object({
  action: z.enum(["create", "complete", "delete", "list", "chat"]),
  taskId: z.string().optional(),
  title: z.string().optional(),
  say: z.string().min(1),
});

type AgentAction = z.infer<typeof agentActionSchema>;

function renderTaskList(): string {
  const items = tasks.list();
  if (items.length === 0) return "（当前清单为空）";
  return items
    .map(
      (task, index) =>
        `${index + 1}. [${task.done ? "已完成" : "待办"}] ${task.title}（id: ${task.id}）`,
    )
    .join("\n");
}

function buildSystemPrompt(): string {
  return `你是「小明」，通过中文对话帮用户管理待办清单的智能助手。

当前任务清单（实时）：
${renderTaskList()}

你每轮只能输出一个 JSON 对象，字段如下：
{"action":"create|complete|delete|list|chat","taskId":"...","title":"...","say":"对用户说的话"}

操作说明：
- create 新增待办：title 为简洁的任务名，去掉「帮我记一下」等口语包装。
- complete 标记完成：taskId 必须从上方清单中选取。
- delete 删除任务：taskId 必须从上方清单中选取。
- list 查看清单：在 say 中清晰列出各任务及其完成状态。
- chat 闲聊或其他无法归类的输入。

规则：
1. 用户可能用模糊说法指代任务（如「牛奶买好了」指「买牛奶」），根据语义匹配 taskId；匹配不到时不要猜测，改用 chat 向用户确认。
2. say 用简短、友好的中文口语直接回应用户这条消息；list 时逐条展示任务名和完成状态。
3. 妥善利用对话历史理解上下文（如「再记一条」要结合之前的内容）。
4. 不要编造清单里不存在的任务，不要执行清单以外的操作。`;
}

// response_format 已约束为 JSON，这里再兜底处理可能的代码围栏
function extractJson(text: string): unknown {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "");
  try {
    return JSON.parse(stripped);
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : undefined;
  }
}

function fallbackReply(reason: string): string {
  console.error(`[agent] ${reason}`);
  return "我这边出了点小状况，请稍后再试一次。";
}

function executeAction(action: AgentAction): string {
  switch (action.action) {
    case "create": {
      const title = action.title?.trim().slice(0, 200);
      if (!title) return "好的，你想记什么事呢？告诉我具体内容吧。";
      tasks.create(title);
      return action.say;
    }
    case "complete": {
      const updated = action.taskId ? tasks.update(action.taskId, { done: true }) : undefined;
      return updated ? action.say : "清单里没找到这条任务，你可以先让我看看当前清单。";
    }
    case "delete": {
      const removed = action.taskId ? tasks.remove(action.taskId) : false;
      return removed ? action.say : "清单里没找到这条任务，你可以先让我看看当前清单。";
    }
    default:
      return action.say;
  }
}

// 接收本轮对话历史（最后一条是最新的用户消息），返回小明的回复。
export async function reply(messages: ChatMessage[]): Promise<string> {
  try {
    const client = getModelClient();
    // 模型偶发返回空内容或结构不符，自动重试一次
    for (let attempt = 1; attempt <= 2; attempt++) {
      const completion = await client.chat.completions.create({
        model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: buildSystemPrompt() }, ...messages],
      });

      const choice = completion.choices[0];
      const content = choice?.message?.content;
      if (!content?.trim()) {
        console.error(
          `[agent] 第 ${attempt} 次模型调用返回空内容: finish=${choice?.finish_reason}`,
        );
        continue;
      }

      const parsed = agentActionSchema.safeParse(extractJson(content));
      if (parsed.success) return executeAction(parsed.data);

      console.error(`[agent] 第 ${attempt} 次模型输出不符合约定结构: ${JSON.stringify(content)}`);
    }
    return "我这边出了点小状况，请稍后再试一次。";
  } catch (error) {
    return fallbackReply(`智能体执行失败: ${String(error)}`);
  }
}
