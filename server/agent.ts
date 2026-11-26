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
  due: z.string().optional(),
  say: z.string().min(1),
});

type AgentAction = z.infer<typeof agentActionSchema>;

// 到期时间格式与任务 API 的校验保持一致
const duePattern = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/;

// 以上海时区为准取当前日期时间，供模型推算「明天」「周五」等相对时间
function todayInfo(): string {
  const now = new Date();
  const options = { timeZone: "Asia/Shanghai" } as const;
  const date = new Intl.DateTimeFormat("sv-SE", {
    ...options,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const time = new Intl.DateTimeFormat("sv-SE", {
    ...options,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now);
  const weekday = new Intl.DateTimeFormat("zh-CN", { ...options, weekday: "long" }).format(now);
  return `${date} ${weekday} ${time}`;
}

// 把 ISO 创建时间转成「刚刚 / N 分钟前 / 昨天」等易读说法，方便模型和用户区分同名任务
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  const days = Math.floor(diff / day);
  if (days === 1) return "昨天";
  if (days <= 7) return `${days} 天前`;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function renderTaskList(): string {
  const items = tasks.list();
  if (items.length === 0) return "（当前清单为空）";
  return items
    .map((task, index) => {
      const status = task.done ? "已完成" : "待办";
      const created = task.createdAt ? `，记于${relativeTime(task.createdAt)}` : "";
      const due = task.due ? `，到期: ${task.due}` : "";
      return `${index + 1}. [${status}] ${task.title}（id: ${task.id}${created}${due}）`;
    })
    .join("\n");
}

function buildSystemPrompt(): string {
  return `你是「小明」，通过中文对话帮用户管理待办清单的智能助手。

今天是 ${todayInfo()}（中国标准时间）。

当前任务清单（实时）：
${renderTaskList()}

你每轮只能输出一个 JSON 对象，字段如下：
{"action":"create|complete|delete|list|chat","taskId":"...","title":"...","due":"...","say":"对用户说的话"}

操作说明：
- create 新增待办：title 为简洁的任务名，去掉「帮我记一下」等口语包装。
- complete 标记完成：taskId 必须从上方清单中选取。
- delete 删除任务：taskId 必须从上方清单中选取。
- list 查看清单：在 say 中清晰列出各任务及其完成状态。
- chat 闲聊或其他无法归类的输入。

规则：
1. 用户可能用模糊说法指代任务（如「牛奶买好了」指「买牛奶」），根据语义匹配 taskId；匹配不到时不要猜测，改用 chat 向用户确认。
2. 用户也可能用序号指代任务（如「第二条」「第一个」「最后一条」），按上方清单展示的序号对应找到任务。
3. 每轮只能执行一个操作。用户提出批量请求（如「全删掉」「都标完成」）时，执行其中一个，并在 say 中诚实说明一次只能处理一条，引导用户继续下一条指令；绝不能声称已完成实际未执行的操作。
4. create 时若清单中已存在标题相同的待办任务，除非用户明确表示要再记一条（如「再记一条买牛奶」），否则先用 chat 反问：「已有一条相同的待办，是要再记一条，还是刚才那条没记上？」确认后再执行。
5. create 时若用户提到了明确的截止时间（如「明天上午十点」「周五」「今天下午三点」），结合今天的日期换算为 due 字段，格式为 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm；没有明确时间就省略 due。
6. 用户询问「今天有哪些任务到期」时，比较各任务 due 的日期部分与今天的日期，在 say 中只列出今天到期的任务；若都没有到期，如实告知。
7. say 用简短、友好的中文口语直接回应用户这条消息。list 时把待办任务排在前面、已完成的排在后面，带序号展示任务名和完成状态；任务有到期时间或创建时间时可一并展示，帮助用户区分同名任务。
8. 妥善利用对话历史理解上下文（如「再记一条」要结合之前的内容）。
9. 不要编造清单里不存在的任务，不要执行清单以外的操作。`;
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
      const due = action.due?.trim().replace(" ", "T").slice(0, 40);
      tasks.create(title, due && duePattern.test(due) ? due : undefined);
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
    // DeepSeek 官方文档说明：JSON Output 模式下 API 偶发返回空 content（finish=stop），
    // 建议的缓解方式就是代码重试，这里最多尝试 3 次
    for (let attempt = 1; attempt <= 3; attempt++) {
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
