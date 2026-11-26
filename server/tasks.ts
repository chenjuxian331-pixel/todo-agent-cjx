import { Router } from "express";
import { z } from "zod";
import type { TaskStore } from "./task-store.ts";

// 到期时间支持日期（YYYY-MM-DD）或日期时间（YYYY-MM-DDTHH:mm）
const dueSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/, {
  message: "到期时间格式应为 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm",
});

const createTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  due: dueSchema.optional(),
});
const updateTaskSchema = createTaskSchema
  .partial()
  .extend({ done: z.boolean().optional() })
  .refine((changes) => Object.keys(changes).length > 0);

const taskNotFound = { error: "找不到这条任务。" };

export function taskRouter(tasks: TaskStore) {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(tasks.list());
  });

  router.post("/", (req, res) => {
    const input = createTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({
        error: "请提供 1 至 200 个字符的任务标题，到期时间格式为 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm。",
      });
    }
    res.status(201).json(tasks.create(input.data.title, input.data.due));
  });

  router.patch("/:id", (req, res) => {
    const input = updateTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供有效的 title 或 done 字段。" });
    }

    const updated = tasks.update(req.params.id, input.data);
    if (!updated) return res.status(404).json(taskNotFound);
    res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    if (!tasks.remove(req.params.id)) return res.status(404).json(taskNotFound);
    res.sendStatus(204);
  });

  return router;
}
