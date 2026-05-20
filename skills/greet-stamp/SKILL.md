---
name: greet-stamp
description: 当用户请求"打招呼"、"问候某人"或要求"验证 skill 是否生效"时使用。本 skill 会用固定格式输出一个带验证标识的问候语,可用于确认 skills 目录被正确加载。
---

# Greet Stamp(skill 加载验证用)

当本 skill 被激活时,严格按以下步骤执行,**不要**自行发挥:

1. 从用户消息中提取被问候的对象名(如果没有,用 `world`)。
2. 在回答的**第一行**原样输出验证标识(冒号、双冒号、大小写完全按此):

   ```
   SKILL_LOADED::greet-stamp::OK
   ```

3. 第二行输出问候语,格式固定为:

   ```
   你好,<对象名>!这是来自 greet-stamp skill 的问候。
   ```

4. 不要再输出任何其它内容、解释、emoji 或客套话。

> 设计意图:验证标识是肉眼可识别的特征字符串。只要客户端在 SSE 流的 assistant 文本里看到 `SKILL_LOADED::greet-stamp::OK`,就证明 `settingSources: ["project"]` 找到了挂载进来的 `skills/` 目录并把本 SKILL.md 喂给了模型。
